export type Site =
  | 'gp'
  | 'hospital'
  | 'community'
  | 'pharmacy'
  | 'diagnostics'
  | 'referrals'
  | 'wearables'
  | 'patient'

export type SimMillis = number

export interface Actor {
  kind: 'team' | 'simulation' | string
  name: string
}

export interface RecordChange {
  time: SimMillis
  actor: Actor
  action: string
  source: string
  version: number
}

export interface Resource<TData = Record<string, unknown>> {
  id: string
  patientId?: string | null
  kind: string
  title: string
  status: string
  owner: string
  visibleTo: string[]
  priority: 'routine' | 'urgent'
  createdAt: SimMillis
  dueAt?: SimMillis | null
  data: TData
  version: number
  provenance?: {
    created: RecordChange | null
    changes: RecordChange[]
  }
}

export interface Patient {
  id: string
  name: string
  birthDate: string
  localIds: Record<string, string>
  conditions: string[]
  needs: string[]
  goals: string[]
  synthetic: true
}

export interface SimEvent {
  id: string
  time: SimMillis
  type: string
  actor: string
  detail: string
  resourceId?: string
  patientId?: string
  visibleTo: string[]
}

export interface Clock {
  now: SimMillis
  paused: boolean
  speed: number
  events: SimEvent[]
}

export interface Workspace {
  resources: Resource[]
  patients: Patient[]
  now?: SimMillis
}

export interface View {
  id: string
  now: SimMillis
  speed: number
  paused: boolean
  population: number
  counters?: Record<string, number>
  resources: Resource[]
  resourceTotal: number
  resourceOffset: number
  resourceLimit: number
  staffing?: { doctors: number; nurses: number; staffedSpaces: number; waiting: number }
  events: SimEvent[]
}

export interface TeamKey {
  apiKey: string
  team: string
  teamName: string
  world: string
  scopes: string[]
  created: boolean
}

export interface Team {
  team: string
  world: string
  scopes: string[]
}

export type AttendanceStage = 'waiting' | 'assessing' | 'take' | 'inpatient' | 'discharged'

export interface AttendanceData {
  stage: AttendanceStage
  acuity: '1' | '2' | '3' | '4' | '5'
  location: string
  arrivalAt: SimMillis
  clinician: string
  presentingComplaint: string
  assessmentAt?: SimMillis
  referredAt?: SimMillis
  admittedAt?: SimMillis
  dischargedAt?: SimMillis
  disposition?: string
}

export type Attendance = Resource<AttendanceData> & { kind: 'hospital-attendance'; patientId: string }

export interface DischargeSections {
  reason: string
  course: string
  diagnoses: string
  medicationChanges: string
  results: string
  followUp: string
  gpActions: string
}

export interface DischargeSummaryData {
  stage: 'draft' | 'sent' | 'reviewed' | 'filed'
  sections: DischargeSections
  assignee?: string
  sentAt?: SimMillis
  sentBy?: string
  reviewNote?: string
  reviewedAt?: SimMillis
  reviewedBy?: string
  filingNote?: string
  filedAt?: SimMillis
  filedBy?: string
  tags?: string[]
  snomedCodes?: { code: string; display: string }[]
}

export interface MedicationOrder {
  drug: string
  dose: string
  unit: string
  route: string
  frequency: string
  duration: string
  quantity: number
  indication: string
}

export interface PrescriptionData {
  medicationOrder?: MedicationOrder
  drug: string
  requiredUnits?: number
  productId?: string
  quantity?: number
  supplyDrug?: string
  text?: string
}

export type PrescriptionStatus = 'draft' | 'reviewed' | 'approved' | 'dispensed' | 'collected'

export interface PharmacyProductData {
  drug: string
  stock: number
  packSize: number
  costPence: number
  pricePence: number
  formulation: string
  reorderLevel: number
}

export interface BloodTestOrder {
  panelId: 'fbc' | 'ue' | 'hba1c' | 'lft' | 'crp' | 'lipids'
  panel: string
  specimen: string
  priority: 'routine' | 'urgent'
  collection: 'now' | 'next-round'
  clinicalDetails: string
}

export interface SimError {
  error: string
  message?: string
}

export class SimHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: SimError | undefined,
    readonly path: string,
  ) {
    super(`Sim ${status} on ${path}: ${body?.error ?? body?.message ?? 'no body'}`)
    this.name = 'SimHttpError'
  }

  get isStaleVersion(): boolean {
    return this.status === 409 && /stale/i.test(this.body?.error ?? '')
  }

  get isCapacity(): boolean {
    return this.status === 409 && /capacity|exhausted|no .*slots/i.test(this.body?.error ?? '')
  }

  get isRetryable(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 504
  }
}
