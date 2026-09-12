# Build plan — "Homeward": an agentic discharge conductor

Working name: **Homeward** (rename freely). One-line pitch:
*Medically fit patients wait in beds because six teams each own one piece of the discharge and nobody owns the list.
Homeward owns the list — it finds who is ready, runs all six workstreams in parallel through each team's own system,
chases blockers, asks a human only when it must, and frees the bed. Demoed live against the NHS-SIM neighbourhood,
side-by-side with the world as it is today.*

## 0. What the sim gives us (from the exploration — details in `docs/SIM_API.md`)

- Real, separate systems for hospital EPR, GP records + Document Inbox, pharmacy dispensing/stock, community visit board,
  diagnostics, referrals, messaging — all in one isolated world per team key, all mutable by API, all visible in a browser UI we can show judges.
- A native bed/flow story: `bed` resources with a `barrier` field, `capacity-beds`, and the world's own `acute-flow` agent that keeps
  admitting A&E patients as the clock advances, with `flow.pressure` events when demand exceeds beds. Freeing beds visibly matters.
- Every one of our six workstreams maps to a verified action chain (table in `CLAUDE.md` §4), and the closing action
  (`update_attendance discharge`) stamps `dischargedAt` — so **time-to-discharge is measured by the sim, not by us**.
- Worlds are free to mint by name, all with an identical seed. **We do not need a second key from the organisers**: the backend
  creates a `baseline` and a `conductor` world per run.
- Constraints: writes take 2–30s and sometimes 502; the clock must be advanced explicitly per world; community capacity is 4;
  several medicines are at 0 stock (great built-in blockers).

## 1. Architecture

```
┌──────────────── web (Vite + React + TS) ────────────────┐      ┌──────────── server (Node 22 + TS) ─────────────┐
│ Left: Discharge board (patients × 6 workstreams, agent   │ SSE  │ api/        HTTP + SSE: start run, stream events,│
│       log, blockers, approve/reject)                     │◀─────│             approve yields, evals JSON            │
│ Right: Two-world ward animation (status quo vs Homeward) │ REST │ runner/     tick loop: both worlds in lockstep    │
│ Strip: metrics + eval pass rates + $/discharge           │─────▶│ conductor/  ADK app: tools, agents, orchestrator  │
└──────────────────────────────────────────────────────────┘      │ baseline/   status-quo simulator (no LLM)         │
                                                                  │ scenario/   cohort seeding, identical in both     │
                                                                  │ metrics/    derived from sim state each tick      │
                                                                  │ evals/      ADK evaluate suite → latest.json      │
                                                                  │ sim/        typed client: retry, idempotency,     │
                                                                  │             concurrency, version refresh, worlds  │
                                                                  └────────────────────┬───────────────────────────────┘
                                                                                       │ HTTPS
                                                                          https://sim.animahacks.com (2 worlds per run)
```

Monorepo with npm workspaces: `server/` and `web/`. Shared types in `server/src/shared/` re-exported to the web via a path alias
(or a tiny `shared/` package if it stays clean). Everything ESM, `tsx` for dev, `tsc` for typecheck, `vitest` for tests.

## 2. Backend (build this first — it is the product)

### 2.1 `sim/` — the client everything else stands on

- `SimClient(apiKey)` with `get(path)`, `act(site, body, { idempotencyKey? })`, `advance(minutes)`, `clock()`.
- Retry 502/503/504/network with backoff (3s → 6s → 12s, max 4 tries) **reusing the same `Idempotency-Key`**.
- Concurrency limiter (default 8 in flight per world). Per-resource mutex so version chains never race.
- `update(site, resourceId, fetchLatest, body)` helper: on `409 Stale resource version`, re-fetch from the fast workspace endpoint, retry with the current version.
- `Worlds.mint(name)` → `POST /api/keys`; `prewarm(patientIds)` → parallel `view?patient=` to eat the 25s first-touch cost.
- Every call logs `{world, site, type, resourceId, ms, status}` to the run recorder (feeds the UI agent log and the metrics).
- Typed resource kinds we touch: `hospital-attendance`, `discharge-summary`, `prescription`, `pharmacy-product`, `test`, `report`, `visit`, `referral`, `task`, `conversation`, `bed`, `capacity`.

### 2.2 `scenario/` — an identical cohort in both worlds

Deterministic cohort of **6 patients** (fits community capacity 4 + 2 who don't need a visit; tune later) with authored stories:
patient id, name (from the directory), admission complaint, ward/bed, TTO medicine(s) (**one deliberately maps to a 0-stock product, e.g. metformin**),
which of the six workstreams apply, and what "fit" looks like. Seeding = `register → assess → refer → admit` for each, in both worlds, same order.
Seeded inpatients SIM-000007 (chest discomfort) and SIM-000008 (fall at home) are included as the first two.
Use the hospital `hospital_note` action to write a short ward-round note per patient (this is what the readiness assessor reads), identical in both worlds.

### 2.3 `baseline/` — the world as it is today (no LLM, honest and parameterised)

The delay today is the **sequential handoff chain and polling cadence**, not the work itself. Encode exactly that, with visible parameters:

| Step | Rule (sim time) |
|---|---|
| Doctor | writes letters one at a time, 30 min each, starting 2h after the patient is fit (end of ward round); TTO prescription drafted with the letter |
| Pharmacy | polls its queue every 2h; 90 min per patient, one at a time; 0 stock → nobody notices until dispense fails → waits for tomorrow's delivery |
| Lab | bloods requested at the ward round with `next-round` collection (240 min); nobody checks the result until the next poll |
| Community | referral only after TTOs are confirmed; polls every 2h; visit takes 90 min; capacity 4 |
| Equipment | requested only after community accepts; 4h turnaround |
| GP practice | reviews letters at 09:00 next day (outside the demo window → letter sits "sent", never "filed") |
| Discharge | only when all of the above are done |

Executed through the *same* sim actions as the conductor, so both worlds end up with real, inspectable records. Parameters live in one
`baselineConfig` object and are displayed in the UI under "status quo assumptions" so nobody thinks we cheated.

### 2.4 `conductor/` — the ADK app (the actual product)

**State schema (session):** `patient`, `attendance {id, version}`, `readiness {fit, confidence, reasoning}`, one slot per workstream
`{status: pending|in_flight|done|blocked|skipped, resourceId?, version?, note?}`, `blockers[]`, `humanRequests[]`, `dischargedAt?`.

**Tools (one per sim chain, thin and typed; every error message is written for the model):**
`read_patient_record`, `assess_readiness` (structured `app.ask`), `draft_letter` → `send_letter`, `draft_tto` → `check_stock` → `link_stock` → `pharmacy_review_accept` → `dispense` → `collect`,
`order_bloods` → `read_results`, `schedule_visit`, `request_equipment` → `accept_referral` → `complete_referral`, `gp_assign` → `gp_review` → `gp_file` → `gp_annotate`, `notify_patient_sms`,
`raise_blocker`, `ask_human` (a **yielding tool**: approve discharge below a confidence threshold / accept substitution / accept "no visit possible"), `discharge_patient`.

**Agents & composition per patient:**
```
discharge-one-patient = sequence [
  readiness-assessor (agent, output schema Readiness; gpt-5.6-luna)  → writes state.readiness
  gate: not fit → ctx.skip patient (stays inpatient; UI shows "not ready: <reason>")
  workstreams = parallel [ pharmacy-agent, lab-agent, community-agent, equipment-agent, letter-agent ]   (gpt-5.4-mini; tools above)
  gp-agent  (needs letter sent; files it, creates follow-up task, SMS to patient)
  all-clear-gate (step, code): six done? else route to blocker-resolver (agent) which may substitute (e.g. order stock, or ask_human)
  close-loop (step, code): discharge_patient with disposition from the letter's followUp
]
conductor = step that lists inpatients from the fast attendances endpoint and fans out discharge-one-patient per patient (fanout limit 6)
```
- Decisions that must be *rules* are steps/hooks, not prompts: a `beforeTool` hook **vetoes `discharge_patient` unless all six slots are `done|skipped`**.
- Letter drafting is the one place we want the model's prose: it reads the ward-round note, the GP problem list and the TTOs, and writes the 7 sections; a code check rejects empty sections before `send`.
- Model choice: `gpt-5.6-luna` for readiness + letter, `gpt-5.4-mini` for workstream agents (they mostly sequence tool calls). Cost per discharge is a metric we show.

### 2.5 `runner/` — the tick loop and the recording

`Run = { id, worlds: {baseline, conductor}, cohort, ticks[] }`. Loop over ticks of **30 sim-minutes from 08:00 to 17:00** (18 ticks):
1. Conductor world: let the conductor act (it is event-driven within the tick; bounded by sim latency).
2. Baseline world: apply the status-quo rules due at this sim time.
3. Advance **both** clocks by 30 min (`POST /api/clock`), read both worlds' fast workspaces, compute metrics, append a tick snapshot, emit SSE.
Every snapshot and every event is written to `runs/<id>.json` so the UI can **replay** any run without network — this is the demo-day safety net.

### 2.6 `metrics/` — computed from sim state, per tick, per world

- Discharged count; per patient `fitAt → dischargedAt` hours (median, max); **delayed bed-hours** (fit but still `inpatient`).
- A&E attendances in `waiting`/`take` (the sim's own arrivals piling up) — shown per world with the caveat that arrivals are stochastic.
- Workstream completion matrix (6 × N), blockers raised/resolved, human interventions, sim write count, LLM tokens/$ (from ADK `run.usage`).

### 2.7 `evals/` — `npm run eval` (required; results shown in the UI)

Offline by default (`toolMocks` so nothing hits the sim; scripted model for wiring tests, **live model** for judgement cases), `repeat: 3`.
Cases and metrics:
1. **Readiness judgement** — fit stories → `fit=true`; unfit stories (new O₂ requirement, rising CRP, unsafe on stairs, no home support) → `fit=false`. Live model, `output.value` checked.
2. **Out-of-stock TTO** — `check_stock` mock returns 0 → `raise_blocker` called, `dispense` never called (`eventCountMetric` = 0, `stateMetric blockers`).
3. **In-stock TTO** — full chain in order (`eventSequenceMetric` link → review → accept → dispense → collect).
4. **Letter completeness/faithfulness** — all 7 sections ≥ 20 chars; LLM judge (`app.ask`) confirms medication changes and follow-up match the source note and nothing is invented.
5. **Safety invariant** — `discharge_patient` never before `gp_file`/all-six; hook veto unit test.
6. **Community 409** — capacity exhausted → escalation via `ask_human`/`raise_blocker`, not silent failure.
7. **Timing** — `total_duration` per patient under budget with mocks; `tool_execution_average`.
8. **Sim client unit tests** (vitest, no model): 502 → retry same idempotency key; 409 → refresh version and retry once; concurrency limiter.
Output: `server/evals/latest.json` (`summary`, per-metric pass rates, cost) + `latest.md`; exit non-zero on failures.

### 2.8 `api/`

`POST /api/runs` (start; body `{cohortSize, tickMinutes, mode: live|replay, runId?}`) · `GET /api/runs/:id/events` (SSE: `tick`, `agent_event`, `sim_write`, `blocker`, `human_request`, `done`) ·
`GET /api/runs/:id` (latest snapshot) · `POST /api/runs/:id/human/:requestId` (`{decision, note}` resumes the yielded run) · `GET /api/evals/latest` · `GET /api/runs` (recorded runs for replay).

## 3. Frontend (build after the backend produces recordings; develop the UI against a recorded run)

Vite + React + TypeScript + Tailwind + framer-motion (+ a tiny chart lib or hand-rolled SVG sparklines). Two-panel layout, 16:9, readable from 2 m away.

**Left panel — the work (for the clinician / ops lead at the stall):**
- Header: sim clock (both worlds), run status, "Start live run" / "Replay".
- Discharge board: one row per patient — name, age, bed, admitted for, readiness badge (fit ✓ / not yet: reason / awaiting human), hours since fit.
  Six chips: Pharmacy · Lab · Community · Equipment · Letter · GP — pending / in-flight (pulse) / done / blocked (red, with reason).
- Expand a row → agent timeline: each tool call with sim time, real latency, resource id, deep link to the sim UI (`/hospital/`, `/gp/documents/`, `/pharmacy/`, `/community/`) so a judge can click and see the real record.
- "Needs a human" tray: approve / reject with note → `POST …/human/:id`.
- "Status quo assumptions" drawer showing `baselineConfig`.

**Right panel — the story (for the passer-by):**
- Two wards stacked (or side by side): **"Today"** and **"With Homeward"**. Bed tiles with patient avatars; A&E queue growing on the left edge from the sim's own arrivals.
- When a patient is discharged the avatar animates bed → door → home icon; the freed bed glows and the next A&E patient slides in.
- Big counters per ward: **discharged**, **bed-hours saved**, **waiting in A&E**; a shared timeline scrubber (replay) and a sparkline of delayed bed-hours.
- Palette: NHS blue `#005EB8` accents, calm light UI on the left, higher-contrast cinematic right panel. Motion is the hook; numbers are the point.

**Bottom strip:** eval pass rate (from `latest.json`) with per-metric mini-bars, LLM $/discharge, sim writes, p50 write latency.

## 4. Demo script (≈3 minutes; also the video)

1. The problem (20s): six teams, one bed, nobody owns the list; the sim's own A&E is filling.
2. Start a live run (or replay): both wards at 08:00 with the same six patients.
3. Homeward assesses readiness, fans out — chips light up in parallel; open one patient and click through to the real pharmacy record and the GP inbox.
4. A blocker: metformin is out of stock → conductor proposes a supplier order / asks a human → approve at the stall.
5. Clock runs to 17:00: "Today" ward still full, letters unfiled; "Homeward" ward has freed N beds, A&E queue drained; bed-hours saved counter.
6. Evals strip: this is how we know it is safe to trust — pass rates, the safety invariant, cost per discharge.

## 5. Order of work and suggested split (4 people)

| # | Milestone | Owner (suggested) | Done when |
|---|---|---|---|
| M0 | Docs (this) on `main` | — | ✓ |
| M1 | `server/` scaffold, `SimClient` with retry/idempotency/limiter, `scripts/smoke.ts` mints a scratch world, seeds a 2-patient cohort, advances 60 min, prints attendances | A | smoke runs green against a scratch world |
| M2 | `scenario/` cohort + `baseline/` rules + `metrics/` + run recorder → `runs/<id>.json` | A | a full baseline run recorded end-to-end |
| M3 | `conductor/` tools + agents + orchestrator; run against a scratch world; recorded | B | 6 patients discharged with real sim records |
| M4 | `evals/` suite + `latest.json`; sim client unit tests | C | `npm run eval` green, repeat 3 |
| M5 | `api/` SSE + `web/` left panel driven by a recorded run | D (UI), C (API) | board updates live from replay |
| M6 | right panel animation + metrics strip + replay scrubber | D | passer-by test: someone who hasn't heard the pitch gets it in 10s |
| M7 | live comparison run recorded for the video; submission by 18:15 | all | video link works signed-out |

Cut order if time runs short: GP SMS → equipment (keep as a plain referral) → LLM-judge letter eval (keep the deterministic one) → live-model evals (keep mocked) → right-panel polish.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sim latency 2–30s per write, 502 bursts | 8-way concurrency, retry with same idempotency key, optimistic "in flight" UI, and **replay mode from recordings for the stall** |
| First-touch 25s per patient | prewarm cohort views in parallel at run start |
| Community capacity = 4 | cohort designed so ≤4 need visits; a 5th is a *feature* (blocker → escalation) |
| Model non-determinism | structured outputs + code gates (`beforeTool` veto) + evals with `repeat: 3` |
| Stochastic A&E arrivals differ between worlds | headline metric is bed-hours saved / discharges (deterministic); A&E queue shown per world with a caveat |
| Version 409s from parallel updates to one resource | per-resource mutex; version refresh from fast workspace endpoints |
| Hospital `view` without patient = 25s | never call it; use `/attendances`, `/documents`, `/pharmacy-workspace` |
| Clock cannot rewind / worlds cannot reset | mint fresh worlds per run (`homeward-<runId>-baseline|conductor`); keep `team1experiment` for browsing in the sim UI |
| Venue Wi-Fi | recorded run + video; the sim UI deep links are the only live dependency |

## 7. Open decisions (defaults chosen; change if you disagree)

1. **Human-in-the-loop policy** — default: auto-proceed when readiness confidence ≥ 0.8 and no blockers; otherwise `ask_human`. Shows safety without stalling the demo.
2. **Baseline parameters** — defaults in §2.3; make them slightly generous to the status quo so the comparison is credible.
3. **Cohort size 6, tick 30 min, window 08:00–17:00** — 18 ticks; ~2–5 real minutes per live run at current sim latency.
4. **Product name** — "Homeward" until someone objects.
