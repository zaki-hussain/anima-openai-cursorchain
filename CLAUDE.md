# CLAUDE.md — Discharge Conductor (OpenAI x Anima hackathon, 12 Sep 2026)

Read this first. It is the source of truth for agents and humans working in this repo.
Detailed references live in `docs/` — read the one you need before touching that area.

| Doc | Read it when |
|---|---|
| `docs/PLAN.md` | You need to know what we are building, why, in what order, and how the demo works |
| `docs/SIM_API.md` | You touch anything that talks to the NHS-SIM world (endpoints, action types, lifecycles, verified examples) |
| `docs/ADK.md` | You write or test agents with the Anima ADK (tools, agents, steps, evals, testing) |
| `docs/HACKATHON.md` | You need event logistics, judging criteria, submission rules, NHS 10-Year Plan context |

## 1. The problem we are solving

Patients who are medically well sit in hospital beds waiting to be discharged. Before one person can go home,
**six separate jobs owned by six separate teams** must all finish: the **pharmacy** (take-home medicines / TTOs),
the **lab** (final bloods), the **community nurses** (home visit), the **equipment/OT team**, the **hospital doctor**
(discharge letter), and the **GP practice** (receive, review and file the letter; follow-up). Nobody owns the list,
handoffs are sequential and manual, and things stall. Meanwhile A&E fills up because no beds are free.

**We are building an agentic "discharge conductor"** that watches the inpatient list, works out who is ready,
generates the full discharge checklist up front, drives all six workstreams **in parallel** through each service's
own system, chases blockers, asks a human only when it must, and closes the loop (letter filed at the GP, bed freed).
It runs against the Anima NHS-SIM neighbourhood via its API, and we demo it side-by-side against a
"status quo" world with no conductor.

NHS 10-Year Plan alignment: Ch. 2 (hospital → community: discharge, neighbourhood care), Ch. 3 (analogue → digital:
less manual chasing), Ch. 6 (transparency: live, per-team discharge-delay metrics), Ch. 8 (AI as a big bet).

## 2. Non-negotiables

- **Backend first.** The orchestrator has to actually move patients through the sim. The UI makes it visible and pretty.
- **The backend has evals** (ADK `app.evaluate`) and the eval metrics are surfaced in the UI.
- **Everything is synthetic.** No real patient data, no clinical advice. Every letter/message we generate says so where a
  real system would; the sim enforces "fictional" everywhere.
- **Never hard-code secrets.** Keys come from env vars (below). Never commit `.env`.
- Node **22+**, TypeScript, ESM. Package manager: `npm`.
- Keep the team's demo world clean (see §4). Develop against scratch worlds.

## 3. Secrets / environment

Two secrets are injected as environment variables (Cursor Cloud Agent secrets; locally put them in `.env`, which is gitignored):

| Env var | What it is |
|---|---|
| `SIM_API` | Team bearer key for the NHS-SIM world `team1experiment` (world id `team-f0d29024a66f`). Scopes: gp, hospital, community, pharmacy, diagnostics, referrals, wearables. |
| `OPENAI_KEY` | OpenAI API key. The ADK reads `OPENAI_API_KEY`, so at process start do `process.env.OPENAI_API_KEY ??= process.env.OPENAI_KEY`. |

Verified OpenAI models on this key (Sep 2026): `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.4-nano`, plus `gpt-realtime-2.1`, `text-embedding-3-small`. Default to `gpt-5.4-mini` for
high-volume/structured calls and `gpt-5.6-luna` where quality matters (letter drafting, readiness judgement).

## 4. NHS-SIM essentials (full reference: `docs/SIM_API.md`)

- Base URL `https://sim.animahacks.com`. OpenAPI: `/api/openapi.json`. Handbook JSON: `/docs/handbook.json`.
  Browser: `/control/` (map), `/hospital/`, `/gp/`, `/gp/documents/`, `/pharmacy/`, `/community/`.
- Auth: `Authorization: Bearer <team key>`. One key = one isolated world. Every write is attributed to the team name.
- **Worlds are free.** `POST /api/keys {"teamName": "..."}` (public, no auth) creates-or-joins a world by name and returns
  a reusable `apiKey`. Names are lowercased with whitespace stripped; anyone with the name can join. Every new world gets the
  identical seed (8 A&E attendances incl. 2 inpatients, 61 discharge letters, 50,000-patient population, same pharmacy stock).
  **So we do not need a second key from the organisers: the backend mints `baseline` and `conductor` worlds itself.**
- **Fast reads (<1s):** `GET /api/clock`, `GET /api/sites/hospital/attendances`, `GET /api/sites/hospital/documents`,
  `GET /api/sites/gp/documents`, `GET /api/sites/pharmacy/pharmacy-workspace`, `GET /api/sites/gp/messaging-workspace`.
- **Slow reads:** `GET /api/sites/{site}/view?patient=SIM-…` is ~25s the **first** time a patient is touched in a world
  (lazy materialisation of their history), then ~1s. `GET /api/sites/hospital/view` without a patient filter is ~25s
  every time — avoid it; use the workspace endpoints above.
- **Writes:** `POST /api/sites/{site}/actions` with a typed `{"type": ...}` body. Latency is **2–30s depending on load**
  and the hosted server occasionally returns **502**. Concurrent writes scale (8 in parallel finished in the time of ~2).
  Always send an `Idempotency-Key` header (UUID per logical action; reuse on retry), retry 502/503/504 with backoff,
  and run independent writes concurrently.
- **Optimistic versions:** any update to an existing resource needs `resourceId` + `expectedVersion` (its current
  `version`). Stale → `409 Stale resource version`. Re-read the resource and retry with the new version.
- **Simulation clock:** `POST /api/clock {"paused": true, "advanceMinutes": N}` (max 10080). Advancing executes due jobs:
  lab results (120 min for `collection: "now"`, 240 for `next-round`), community visits (90 min), supplier deliveries.
  It also runs the world's own agents: new A&E arrivals (`acute-flow`), `flow.pressure` bed-shortage events (`bed-flow`),
  GP demand. Advancing 121 min added ~12 A&E arrivals. **Every world has its own clock**; ours starts paused at
  2026-09-12T08:00Z (`now` = 1789200000000 ms). Clock `events` (last 100) is the only event feed — there is no stream.
- Sites (path segment `{site}`): `gp`, `hospital`, `community`, `pharmacy`, `diagnostics`, `referrals`, `wearables`, `patient`.
  Which actions are valid depends on the site *and* the resource's owner/state.
- Body limit 64 KiB. Patient ids look like `SIM-000001`. Everything is UTC.

### The six workstreams → verified sim action chains

| # | Team | Sim chain (site → action) | Notes |
|---|---|---|---|
| 1 | Pharmacy (TTOs) | hospital `draft_prescription` (→ `prescription`, status `draft`, owner pharmacy) → pharmacy `link_prescription_stock` {productId, quantity} → `review` (→ `reviewed`) → `accept` (→ `approved`) → `dispense` (→ `dispensed`, stock deducted) → `collect` (→ `collected`) | 30 catalogue products, several at **0 stock** (metformin, losartan, citalopram, ibuprofen, simvastatin, doxycycline, vitamin-d) → real blocker; order via supplier quotes |
| 2 | Lab | hospital `order_test` {bloodTestOrder: panelId ∈ fbc/ue/hba1c/lft/crp/lipids} (→ `test`, `open`) → advance clock ≥120 min → `diagnostics/view?patient=` shows `test` `available` + `result.available` event | Read analytes from the `report` resources |
| 3 | Community nurses | hospital `schedule_visit` {patientId,title} (→ `visit`, `scheduled`, owner community) → advance ≥90 min → `completed` (or community `complete`) | `capacity-community` total 4 → 409 when exhausted = blocker |
| 4 | Equipment / OT | hospital `create_referral` {patientId,title} (→ `referral`, `open`) → referrals `accept` → `complete` | No native equipment entity; a referral titled "Equipment: …" is the honest stand-in |
| 5 | Doctor's letter | hospital `save_discharge_summary` {title, dischargeSections{reason,course,diagnoses,medicationChanges,results,followUp,gpActions}} (→ `discharge-summary`, `draft`) → hospital `process_document` {documentCommand:"send"} (→ `sent`, visible to GP) | All 7 sections must be non-empty to send |
| 6 | GP practice | gp `process_document` `assign` {clinician} → `review` {text} (→ `reviewed`) → `file` {text} (→ `filed`); gp `annotate` {documentTags, documentSnomedCodes}; gp `create_task`; gp `messaging_action` {kind:"create", subject, body, channel:"sms", allowReply} then {kind:"delivery", entryId, status:"delivered"} | `annotate` is GP-only (403 from hospital) |
| ✓ | Close the loop | hospital `update_attendance` {resourceId, expectedVersion, hospitalCommand:"discharge", disposition} → attendance `discharged` with `dischargedAt` | `disposition` is required |

Attendance lifecycle (to seed extra inpatients identically in both worlds):
`register_attendance` {patientId,title,acuity "1"-"5",location,clinician?} → `update_attendance` `assess` {clinician} →
`refer` → `admit` {location} → (`discharge` {disposition}). Statuses: `waiting → assessing → take → inpatient → discharged`.

## 5. Anima ADK essentials (full reference: `docs/ADK.md`)

`npm i @animahealth/adk zod@^3.25 openai` (`openai` is a peer dep). Docs: https://adk.animahealth.com (`/all.html` = everything on one page).
- `const app = adk({ schema: { session: {...zod} } })` — typed state shared by every runnable in a session.
- `app.tool({ name, description, schema, execute(ctx), retry?, timeout?, prepare?, finalize? })` — the border between model and sim.
- `app.agent({ name, model: openai('gpt-5.4-mini'), context: [app.context.system(...), app.context.history()], tools, output?: { schema } })`.
- Composition: `app.step` (your code, no model; can return a runnable to route), `app.sequence`, `app.parallel`, `app.loop`;
  in-run verbs `ctx.run / ctx.spawn / ctx.dispatch`; `app.ask(prompt, { schema })` for one-shot typed judgements; `fanout(thunks, { limit })`.
- Human-in-the-loop: a tool with `yieldSchema` pauses the run; resume later with the answer.
- Testing without a model: `runTest(runnable, [user(), model({ toolCalls }), model('text')])` from `@animahealth/adk/testing`.
- Evals: `app.evaluate(cases, { metrics, repeat, concurrency, onCase })` with `toolMocks` (strict) and metrics from
  `@animahealth/adk/eval` (`eventSequenceMetric`, `eventCountMetric`, `stateMetric`, `timingMetric`) or custom
  `app.evaluate.metric({ name, evaluate(run) })`. `app.evaluate.report()` → markdown; `summary` → JSON for the UI.
- Verified locally: ADK 0.6.0 + `gpt-5.4-mini` + one tool ran end-to-end in ~5s, `run.usage.cost` populated.

## 6. Repo layout & conventions

```
CLAUDE.md            ← you are here
docs/                ← PLAN, SIM_API, ADK, HACKATHON
server/              ← Node 22 + TS: sim client, ADK agents, scenario runner, evals, HTTP+SSE
web/                 ← Vite + React + TS dashboard (left: work board; right: two-world animation; evals strip)
```
- Branches: work happens on `cursor/*` branches; `main` holds docs and merged, working code only.
- Commit small and often; each commit is one logical change with a clear message.
- Before a sim-writing script runs, make it print which world (team name) it targets. Default to a scratch world.
- Keep temporary probe scripts out of the repo (use `/tmp`).
- Do not narrate code with comments; comment only non-obvious intent or sim quirks.

## 7. Known gotchas (all verified today)

1. `expectedVersion` must be the *current* version; parallel updates to the same resource will 409. Serialise per-resource, parallelise across resources.
2. `share_record` on a discharge letter → 409 "Use the document workflow". Letters move by `process_document` only.
3. `discharge` without `disposition` → 400 "Discharge destination or outcome is required".
4. `annotate` from the hospital site → 403 "GP document processing required".
5. Sending a letter requires every one of the 7 `dischargeSections` to have text; state "none recorded" explicitly rather than leaving blanks.
6. First patient touch is ~25s: pre-warm the cohort's `view?patient=` in parallel at scenario start.
7. The hosted sim 502s under load; treat 502/503/504 as retryable, everything else as a real error.
8. Advancing the clock in one world does not advance another. Baseline and conductor worlds must be advanced in lockstep by our runner.
9. The clock cannot go backwards and worlds cannot be reset — mint a fresh world per demo run (`teamName` with a run suffix).
