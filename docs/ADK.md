# Anima ADK cheat sheet (v0.6.0, verified 12 Sep 2026)

Official docs: https://adk.animahealth.com — every page is runnable; `https://adk.animahealth.com/all.html` has everything on one screen.
GitHub: https://github.com/mycontinuum-com/adk · npm: `@animahealth/adk` (MIT). Requires Node ≥ 22.

## Install

```bash
npm install @animahealth/adk zod@^3.25 openai      # openai is a peer dependency (^5)
npm install -D tsx typescript @types/node
```

The OpenAI adapter reads `OPENAI_API_KEY` (also `OPENAI_EU_API_KEY`, `AZURE_OPENAI_ENDPOINT`+`AZURE_OPENAI_API_KEY`).
Our secret is `OPENAI_KEY`, so the first line of every entrypoint is:

```ts
process.env.OPENAI_API_KEY ??= process.env.OPENAI_KEY
```

Subpath exports: `.`, `./openai`, `./gemini`, `./claude`, `./testing`, `./eval`, `./web`, `./agui`, `./cli`, `./voice`,
`./stores/{sqlite,postgres,dynamodb}`, `./workflow` (experimental), `./agents/coding`.

## Mental model

- **App** = `adk({ name?, schema?: { session: {...zod fields} }, defaultModel?, adapters?, hooks? })`. One typed state schema; every tool/agent/step infers it.
- **Session ledger** = append-only list of events (`user`, `assistant`, `tool_call`, `tool_result`, `state_change`, `model_start/end`, `invocation_start/end`, `annotation`, `thought`).
  State is *derived* from `state_change` events. `run.session.events` is the ledger; `run.usage` totals tokens/cost across the session.
- **Context is rendered per model call** from renderers: `app.context.system(string | ({state}) => string)`, `app.context.history()`, custom `app.context(ctx => ctx)`.
  Nothing reaches the model unless a renderer puts it there. Different agents can see different slices of the same session.
- **Five runnables**: `agent` (calls a model in a loop until no more tool calls), `step` (your code; may return a runnable to route),
  `sequence`, `parallel` (cloned sessions, merged back), `loop` (`while`, `maxIterations`, optional `yields`).
- **Handoff verbs** inside a step/tool: `await ctx.run(agent, msg)` (wait), `ctx.spawn(agent, msg).wait()`, `ctx.dispatch(agent, msg)` (fire-and-forget; run still waits for it to finish), or `return agent` (transfer).
- **One-shot judgement**: `app.ask(prompt, { schema, system?, model? })` → parsed typed value on a fresh session. `fanout(thunks, { limit })` for bounded concurrency (never rejects; failures → `null`).

## Tools

```ts
import { adk } from '@animahealth/adk'
import { z } from 'zod'

const app = adk({ schema: { session: { blockers: z.array(z.string()).default([]) } } })

const scheduleVisit = app.tool({
  name: 'schedule_community_visit',
  description: 'Book a community nurse home visit for an inpatient. Fails with a blocker if community capacity is exhausted.',
  schema: z.object({ patientId: z.string().describe('SIM id, e.g. SIM-000010'), purpose: z.string() }),
  retry: { maxAttempts: 4, initialDelayMs: 2000, maxDelayMs: 15000, backoffMultiplier: 2, retryableErrors: (e) => /50[234]/.test(String(e)) },
  timeout: 120_000,                              // budget for the whole call incl. retries
  prepare: (ctx) => ({ ...ctx.args, purpose: ctx.args.purpose.trim() }),   // normalise before execute
  execute: async (ctx) => {
    const res = await sim.act('hospital', { type: 'schedule_visit', patientId: ctx.args.patientId, title: ctx.args.purpose })
    if (res.status === 409) { ctx.state.blockers = [...ctx.state.blockers, 'community capacity exhausted']; throw new Error('Community capacity exhausted — escalate to the community team lead') }
    return { visitId: res.body.id, dueAt: res.body.dueAt }
  },
  finalize: (ctx) => ctx.result,                 // redact/trim what the model sees
})
```

- `name`/`description`/`schema.describe()` are prompt: the model chooses tools from them alone.
- Arguments are coerced then Zod-parsed; invalid args become a `tool_result` error the model can correct. A thrown error also becomes a `tool_result` with `error` = message — **write error messages for the model to act on**.
- `ctx` carries: `args, state, session, toolName, callId, invocationId, runnable, signal, note(), output(), run/spawn/dispatch`.
- A tool with `yieldSchema` and no `execute` **pauses the run** for a human (approval / missing info). The run returns `yielded_tool`; a later `app.run` on the same session with the answer resumes it. Use for "approve discharge?".
- Provider tools like `{ type: 'web_search' }` run inside the provider.

## Agents

```ts
import { openai } from '@animahealth/adk/openai'

const Readiness = z.object({
  fit: z.boolean(), confidence: z.number().min(0).max(1), reasoning: z.string(),
  workstreams: z.array(z.enum(['pharmacy', 'lab', 'community', 'equipment', 'letter', 'gp'])),
})

const readinessAssessor = app.agent({
  name: 'readiness-assessor',
  model: openai('gpt-5.6-luna', { reasoning: { effort: 'low' } }),
  context: [app.context.system(({ state }) => `Decide if this inpatient is medically fit for discharge… ${JSON.stringify(state.patient)}`), app.context.history()],
  output: { schema: Readiness },                 // run.output.value is the parsed object; lenient JSON repair built in
})
const run = await app.run(readinessAssessor, { input: { message: 'Assess SIM-000010', initialState: { session: { patient } } } })
run.status            // 'completed' | 'yielded_tool' | 'yielded_message' | 'error' | 'aborted' | 'max_steps' | 'terminated'
run.output.value      // typed
run.output.text       // last assistant text
run.state             // typed session state
run.usage.cost.totalCost
```

`model: openai(name, { temperature?, maxTokens?, reasoning?: { effort } })`. Verified working here: `gpt-5.4-mini` (fast/cheap), `gpt-5.6-luna` (quality).
Pass `hooks: [{ name, onEvent(e) }]` to `app.run` to stream every `StreamEvent` (incl. `assistant_delta`) to the UI.

## Composition example (our shape)

```ts
const workstreams = app.parallel({
  name: 'workstreams',
  runnables: [pharmacyAgent, labAgent, communityAgent, equipmentAgent, letterAgent],   // cloned sessions, merged back
  minSuccessful: 5, branchTimeout: 240_000,
})
const gate = app.step({ name: 'all-clear-gate', execute: (ctx) => { if (!allSixDone(ctx.state)) ctx.fail('Discharge blocked: ' + ctx.state.blockers.join(', ')) } })
const discharge = app.sequence({ name: 'discharge-one-patient', runnables: [assessStep, workstreams, gpAgent, gate, closeLoopStep] })
```

A sequence stops on `error | aborted | max_steps | yielded_tool`. `ctx.skip()` skips only that step. Values move between children via `ctx.state`, not return values.
`gated(runnable, check)` and `cached(runnable, { key, scope, ttlMs })` are ready-made wrappers.

## Testing without a model (`@animahealth/adk/testing`)

```ts
import { runTest, user, model, getToolResults, findEventsByType, mockAgent, MockAdapter } from '@animahealth/adk/testing'

const t = await runTest(pharmacyAgent, [
  user('Get TTOs ready for SIM-000010'),
  model({ toolCalls: [{ name: 'check_stock', args: { productId: 'pharmacy-product-metformin' } }] }),   // the script decides WHAT is called…
  model('Metformin is out of stock; raised a blocker.'),                                              // …the real tool runs
])
t.status; t.events; getToolResults(t.events)
```
`MockAdapter({ responses, defaultResponse })` registered via `adk({ adapters: { openai: mock } })` replaces the provider for whole apps;
`mock.addResponses('agent:<name>', [...])` routes scripts per agent. Deterministic → runs in CI with no key.

## Evals (`app.evaluate`, `@animahealth/adk/eval`)

```ts
import { eventSequenceMetric, eventCountMetric, stateMetric, timingMetric } from '@animahealth/adk/eval'

const neverDischargeEarly = eventSequenceMetric({ name: 'six_done_before_discharge', sequence: [
  { eventType: 'tool_call', filter: (e) => e.name === 'file_letter_at_gp' },
  { eventType: 'tool_call', filter: (e) => e.name === 'discharge_attendance' },
]})
const oneDischarge = eventCountMetric({ name: 'discharged_once', eventType: 'tool_call', filter: (e) => e.name === 'discharge_attendance', assertion: (n) => n === 1 })
const blockerRaised = stateMetric({ name: 'blocker_surfaced', scope: 'session', key: 'blockers', assertion: (v) => Array.isArray(v) && v.length > 0 })
const fast = timingMetric({ name: 'under_2_min', measure: 'total_duration', assertion: (ms) => ms < 120_000 })
const letterComplete = app.evaluate.metric({ name: 'letter_all_sections', evaluate: (run) => { const s = run.session.state.letter; const ok = s && Object.values(s).every((x) => String(x).trim().length > 20); return { passed: !!ok, score: ok ? 1 : 0, evidence: [JSON.stringify(s)] } } })

const cases = app.evaluate.cases([
  { name: 'out-of-stock TTO raises blocker, no dispense', runnable: pharmacyAgent, input: {...}, toolMocks: { check_stock: { execute: () => ({ stock: 0 }) }, dispense: { execute: () => { throw new Error('must not be called') } } }, metrics: [blockerRaised] },
  { name: 'happy path discharges once', runnable: dischargeSequence, input: {...}, toolMocks: simMocks, metrics: [oneDischarge] },
])
const result = await app.evaluate(cases, { metrics: [neverDischargeEarly, fast], repeat: 3, concurrency: 4, onCase: (r, done, total) => log(`${done}/${total} ${r.name} ${r.status}`) })
result.summary            // { total, passed, failed, errors, terminated, aborted, timedOut }
app.evaluate.report({ title: 'Discharge conductor evals' })(result)   // markdown
```
- `toolMocks` is **strict**: a called tool without an entry errors inside the tool (recorded, not thrown). Pass the real tool object as the value to let a read-only tool through.
- A case with no metrics passes whenever the run didn't error — always attach metrics.
- `timingMetric.measure` ∈ `total_duration | time_to_first_assistant | time_to_first_tool_call | model_latency_total | model_latency_average | tool_execution_total | tool_execution_average`.
- Scores in [0,1] are averaged in the report. `evaluate` never throws on failure — read `summary` and exit non-zero yourself.
- `app.simulate(agent, { input, userAgent, toolAgents, maxTurns, maxDuration, stateMatches })` drives multi-turn evals with a simulated counterpart.
- LLM-as-judge: use `app.ask(prompt, { schema: z.object({ score: z.number(), reasons: z.array(z.string()) }) })` inside a custom metric.

## Hooks & guardrails

Nine lifecycle points (`beforeAgent`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `afterAgent`, `onEvent`, `onError`, …).
`beforeModel` can return tool calls directly (deterministic action without a model call); `beforeTool` can veto (throw) — e.g. block `discharge_attendance`
unless state says all six workstreams are done. Errors have six recovery actions. `timeout` and `maxSteps` caps exist on `app.run`.

## Serving & streaming

`app.handler.rest({ agent, sessionService?, hooks?, response? })` → `(input: { sessionId?, input }) => Promise<RestResponse>`; `app.handler.turn` returns a stream;
`app.handler.agui` speaks AG-UI. Stores: in-memory default, `./stores/sqlite` (`better-sqlite3`), postgres, dynamodb — needed only if a yielded run must survive a restart.
For our dashboard we don't need the ADK handlers: the orchestrator runs server-side and we push our own event stream (SSE) to the web app, fed by an `onEvent` hook + sim events.

## Verified smoke test (ran locally)

ADK 0.6.0, `gpt-5.4-mini`, one tool writing typed state: `status: completed` in 5.3s, ledger
`user → invocation_start → model_start → model_end → tool_call → state_change → tool_result → model_start → model_end → assistant → invocation_end`,
`usage.cost.totalCost ≈ $0.0009` (264 in / 61 out tokens, 2 calls).
