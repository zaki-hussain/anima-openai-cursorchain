import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Clock, Patient, Resource, Site, SimError, Team, View, Workspace } from './types.js'
import { SimHttpError } from './types.js'

export interface SimCallLog {
  world: string
  method: 'GET' | 'POST'
  path: string
  site?: Site
  actionType?: string
  resourceId?: string
  status: number
  ms: number
  attempts: number
  ok: boolean
  error?: string
}

export interface SimClientOptions {
  baseUrl: string
  apiKey: string
  /** Label used in logs; usually the team name. */
  world?: string
  /** Max in-flight requests to this world. Writes scale roughly 4x at 8-way concurrency. */
  concurrency?: number
  /** Retry budget for 502/503/504 and network failures. The hosted sim has multi-minute 502 outages under load. */
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  requestTimeoutMs?: number
  onCall?: (log: SimCallLog) => void
}

interface RequestOptions {
  idempotencyKey?: string
  site?: Site
  actionType?: string
  resourceId?: string
}

/** Small counting semaphore so we never flood the hosted sim. */
class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    return () => this.release()
  }

  private release(): void {
    this.active--
    this.queue.shift()?.()
  }
}

/**
 * Typed client for one NHS-SIM world.
 *
 * - retries 502/503/504/network errors with backoff, reusing the same Idempotency-Key
 * - bounds concurrency per world
 * - serialises updates to the same resource so optimistic version chains never race
 * - refreshes `expectedVersion` once on "Stale resource version"
 */
export class SimClient {
  readonly baseUrl: string
  readonly world: string
  private readonly apiKey: string
  private readonly semaphore: Semaphore
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly onCall: ((log: SimCallLog) => void) | undefined
  private readonly resourceLocks = new Map<string, Promise<unknown>>()

  constructor(options: SimClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.world = options.world ?? 'unknown-world'
    this.semaphore = new Semaphore(options.concurrency ?? 8)
    this.maxAttempts = options.maxAttempts ?? 10
    this.baseDelayMs = options.baseDelayMs ?? 3000
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.onCall = options.onCall
  }

  // ---------- low level ----------

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined, {})
  }

  /** Execute a typed site action. Always sends an Idempotency-Key; pass one to make a retry of the same logical action safe. */
  async act<T extends Resource<any> = Resource>(
    site: Site,
    body: Record<string, unknown> & { type: string },
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const resourceId = typeof body.resourceId === 'string' ? body.resourceId : undefined
    const run = () =>
      this.request<T>('POST', `/api/sites/${site}/actions`, body, {
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        site,
        actionType: body.type,
        ...(resourceId ? { resourceId } : {}),
      })
    return resourceId ? this.withResourceLock(resourceId, run) : run()
  }

  /**
   * Update an existing resource with optimistic concurrency. If the sim reports a stale version,
   * `refresh` is called to fetch the current version and the action is retried once.
   */
  async update<T extends Resource<any> = Resource>(
    site: Site,
    resourceId: string,
    expectedVersion: number,
    body: Record<string, unknown> & { type: string },
    refresh?: () => Promise<number>,
  ): Promise<T> {
    const idempotencyKey = randomUUID()
    try {
      return await this.act<T>(site, { ...body, resourceId, expectedVersion }, { idempotencyKey })
    } catch (error) {
      if (error instanceof SimHttpError && error.isStaleVersion && refresh) {
        const current = await refresh()
        return this.act<T>(site, { ...body, resourceId, expectedVersion: current }, { idempotencyKey: randomUUID() })
      }
      throw error
    }
  }

  private async withResourceLock<T>(resourceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.resourceLocks.get(resourceId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.resourceLocks.set(resourceId, tail)
    try {
      return await next
    } finally {
      if (this.resourceLocks.get(resourceId) === tail) this.resourceLocks.delete(resourceId)
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body: unknown, options: RequestOptions): Promise<T> {
    const release = await this.semaphore.acquire()
    const started = Date.now()
    let attempts = 0
    let lastStatus = 0
    try {
      while (true) {
        attempts++
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
        try {
          const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          }
          if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
          const init: RequestInit = { method, headers, signal: controller.signal }
          if (body !== undefined) init.body = JSON.stringify(body)
          const response = await fetch(this.baseUrl + path, init)
          lastStatus = response.status
          const text = await response.text()
          let parsed: unknown = undefined
          if (text) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = undefined
            }
          }
          if (response.ok) {
            this.log({ ...options, method, path, status: response.status, ms: Date.now() - started, attempts, ok: true })
            return parsed as T
          }
          const error = new SimHttpError(response.status, parsed as SimError | undefined, path)
          if (error.isRetryable && attempts < this.maxAttempts) {
            await sleep(this.backoff(attempts))
            await this.waitUntilHealthy()
            continue
          }
          this.log({ ...options, method, path, status: response.status, ms: Date.now() - started, attempts, ok: false, error: error.message })
          throw error
        } catch (error) {
          if (error instanceof SimHttpError) throw error
          if (attempts < this.maxAttempts) {
            await sleep(this.backoff(attempts))
            continue
          }
          const message = error instanceof Error ? error.message : String(error)
          this.log({ ...options, method, path, status: lastStatus, ms: Date.now() - started, attempts, ok: false, error: message })
          throw new SimHttpError(lastStatus || 0, { error: message }, path)
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      release()
    }
  }

  /** Exponential backoff capped at maxDelayMs: 3s, 6s, 12s, 24s, 30s, 30s… (≈4 min over 10 attempts). */
  private backoff(attempt: number): number {
    const jitter = Math.random() * 500
    return Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs) + jitter
  }

  /** During a 502 burst, poll the public health endpoint (bounded) before spending another attempt. */
  private async waitUntilHealthy(maxWaitMs = 60_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(10_000) })
        if (response.ok) return
      } catch {
        // fall through to the next poll
      }
      await sleep(5000)
    }
  }

  private log(entry: Omit<SimCallLog, 'world'>): void {
    this.onCall?.({ world: this.world, ...entry })
  }

  // ---------- reads (fast workspace endpoints preferred) ----------

  team(): Promise<Team> {
    return this.get<Team>('/api/team')
  }

  clock(): Promise<Clock> {
    return this.get<Clock>('/api/clock')
  }

  /** Pause and advance the world's clock; runs every job due in the window and returns the new clock + recent events. */
  advance(minutes: number): Promise<Clock> {
    if (minutes < 0 || minutes > 10080) throw new Error('advanceMinutes must be within 0..10080')
    return this.request<Clock>('POST', '/api/clock', { paused: true, advanceMinutes: minutes }, {})
  }

  pause(): Promise<Clock> {
    return this.request<Clock>('POST', '/api/clock', { paused: true }, {})
  }

  attendances(): Promise<Workspace> {
    return this.get<Workspace>('/api/sites/hospital/attendances')
  }

  hospitalDocuments(): Promise<Workspace> {
    return this.get<Workspace>('/api/sites/hospital/documents')
  }

  gpDocuments(): Promise<Workspace> {
    return this.get<Workspace>('/api/sites/gp/documents')
  }

  pharmacyWorkspace(): Promise<Workspace> {
    return this.get<Workspace>('/api/sites/pharmacy/pharmacy-workspace')
  }

  gpMessaging(): Promise<Workspace> {
    return this.get<Workspace>('/api/sites/gp/messaging-workspace')
  }

  /** Per-patient view. ~25s the first time a patient is touched in a world, ~1s afterwards. */
  view(site: Site, patientId: string, limit = 200): Promise<View> {
    const query = new URLSearchParams({ patient: patientId, limit: String(limit) })
    return this.get<View>(`/api/sites/${site}/view?${query}`)
  }

  patients(site: Site, q: string, offset = 0): Promise<{ total: number; items: Patient[] }> {
    const query = new URLSearchParams({ q, offset: String(offset) })
    return this.get(`/api/sites/${site}/patients?${query}`)
  }

  /** Eat the first-touch cost for a cohort up front, in parallel. */
  async prewarm(patientIds: string[], sites: Site[] = ['hospital', 'gp']): Promise<void> {
    await Promise.all(patientIds.flatMap((id) => sites.map((site) => this.view(site, id, 1).catch(() => undefined))))
  }

  /** Find one resource's current version from a workspace read (fast) — used to recover from stale-version 409s. */
  async currentVersion(fetch: () => Promise<Workspace>, resourceId: string): Promise<number> {
    const workspace = await fetch()
    const resource = workspace.resources.find((r) => r.id === resourceId)
    if (!resource) throw new Error(`Resource ${resourceId} not found in workspace for ${this.world}`)
    return resource.version
  }
}
