# NHS-SIM API reference (verified 12 Sep 2026)

Everything here was checked live against `https://sim.animahacks.com` using the team key and a scratch world.
Where the official docs and observed behaviour differ, observed behaviour is recorded.

Official sources: OpenAPI 3.1 at `/api/openapi.json` (73 paths), handbook at `/docs/` (JSON at `/docs/handbook.json`),
interactive explorer at `/docs/explorer/`. The API's own description: *"Synthetic healthcare simulation APIs. Start with
POST /api/keys, copy apiKey, then authorize using TeamKey. Try it out performs real changes within your team's simulated world."*

## 1. Worlds, keys, auth

```bash
# create-or-join a world by name (public; no auth). Same normalised name → same world & same reusable key.
curl -s https://sim.animahacks.com/api/keys -H 'Content-Type: application/json' \
  -d '{"teamName":"team1experiment"}'
# → {"apiKey":"…","team":"team1experiment","teamName":"team1experiment","world":"team-…","scopes":[...],"created":false}

# who am I
curl -s https://sim.animahacks.com/api/team -H "Authorization: Bearer $SIM_API"
# → {"team":"team1experiment","world":"team-f0d29024a66f","scopes":["gp","hospital","community","pharmacy","diagnostics","referrals","wearables"]}
```

- Names are lowercased with all whitespace removed (`Team 1 Experiment` ≡ `team1experiment`). Anyone who knows a name can join.
- Optional `site` in `POST /api/keys` restricts scope; omit it to get every participant scope.
- Every write is attributed `{"actor":{"kind":"team","name":"<teamName>"}}` in the resource's `provenance`.
- Up to 5,000 worlds per deployment. Worlds cannot be reset or deleted by participants; clocks only move forward.
- Operator endpoints (`/api/control/*`, `?world=`) need the organisers' token — not available to us.
- Our team world: `team1experiment` / `team-f0d29024a66f` (key in `SIM_API`). Treat it as the *demo* world; develop in scratch worlds.

## 2. Reading the world

| Endpoint | Returns | Latency (observed) |
|---|---|---|
| `GET /api/clock` | `{now, paused, speed, events[≤100]}` — sim time in ms + most recent visible events | ~0.5s |
| `GET /api/catalogue` | sites, workspaces, NHS adapters, incident scenarios, docs links | ~1s |
| `GET /api/sites/hospital/attendances` | **Workspace**: all `hospital-attendance` resources + `patients[]` + `now` | ~0.5s |
| `GET /api/sites/hospital/documents` | Workspace: all `discharge-summary` (draft/sent/reviewed/filed) + patients | ~0.8s |
| `GET /api/sites/gp/documents` | Workspace: letters visible to GP (sent/reviewed/filed) | ~0.8s |
| `GET /api/sites/pharmacy/pharmacy-workspace` | Workspace: `prescription`, `pharmacy-product`, `pharmacy-quote`, `pharmacy-movement`, `pharmacy-referral`, `pharmacy-basket`, orders | ~0.6s |
| `GET /api/sites/gp/messaging-workspace` | conversations + message templates | fast |
| `GET /api/sites/patient/messaging-workspace?patientId=` | one patient's delivered conversations | fast |
| `GET /api/sites/{site}/patients?q=&offset=` | patient directory search (name/id/condition/need), page size 30 | ~3s |
| `GET /api/sites/{site}/view?patient=SIM-…&limit=&offset=` | **View**: that patient's resources visible to `site` + shared service resources + `counters`, `staffing`, `events` | **~25s first touch per patient per world**, then ~1s |
| `GET /api/sites/{site}/view` (no patient) | every resource visible to the site (≤500/page) | ~25s always — avoid |
| `GET /api/sites/{site}/appointments?date=YYYY-MM-DD` | GP diary: sessions + appointments | fast |
| `GET /api/sites/wearables/devices|readings?patient=&metric=` | wearable data | fast |
| `GET /api/nhs/pds/Patient?family=&given=&birthdate=` / `/api/nhs/pds/Patient/{id}` | FHIR R4 Patient (read-only) | fast |
| `GET /api/nhs/ods/Organization[/{id}]` | FHIR Organization: `SIM-RIVERSIDE` (GP), Northbank General, Riverside Community, Riverside Pharmacy | fast |

`{site}` ∈ `gp | hospital | community | pharmacy | diagnostics | referrals | wearables | patient` (`control` is operator-only).

### Resource envelope (every record)

```jsonc
{
  "id": "r-3831", "kind": "hospital-attendance", "title": "Community-acquired pneumonia",
  "status": "inpatient", "owner": "hospital", "visibleTo": ["hospital"],
  "patientId": "SIM-000010", "priority": "routine",            // "routine" | "urgent"
  "createdAt": 1789200000000, "dueAt": 1789286400000,         // sim ms
  "data": { /* kind-specific */ }, "version": 4,
  "provenance": { "created": {"time","actor":{"kind":"team|simulation","name"},"action","source","version"}, "changes": [ … ] }
}
```

### Patient (directory / workspace `patients[]`)

```json
{"id":"SIM-000001","name":"Amira Khan","birthDate":"1952-05-12","synthetic":true,
 "localIds":{"gp":"RIV-0","legacy":"WH-90000","hospital":"NBG-10000"},
 "conditions":["Heart failure","CKD"],"needs":["Home visit","Carer involvement"],
 "goals":["Understand the next step","Avoid unnecessary travel","Stay at home with a clear contact for help"]}
```

The GP view also carries an `ehr-record` resource per patient with `data.problems[] {code,term,status,date}`,
`allergies[]`, `medications[]`, `miscCodes[]`, plus `encounter` resources with narrative `text` and `sections{history,context,plan}`.
Blood history: 6 panels × 6 dated `report` resources per patient (`data.analytes`), visible to gp/hospital/diagnostics.

## 3. Writing: `POST /api/sites/{site}/actions`

Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`, **`Idempotency-Key: <uuid>`** (or body `clientRequestId`).
Body: `{"type": "<action>", ...fields}`. Response: the created/updated **Resource**. Errors: `{"error": "...", "message"?: "..."}`.

Rules:
- Creating: `patientId` + `title` (+ kind-specific object). Updating: `resourceId` + `expectedVersion` (+ command field).
- Same idempotency key + same payload → same result (safe retry). Same key + different payload → 409.
- Validation errors come back as `400` with a Zod issue list in `error`.
- Status codes: 400 invalid, 401 bad key, 403 wrong scope/site, 404 unknown, 409 stale version / invalid transition / capacity, 413 body > 64 KiB, 5xx server.

### 3.1 Hospital attendance (bed occupancy)

```jsonc
// register (site: hospital) → status "waiting"
{"type":"register_attendance","patientId":"SIM-000010","title":"Community-acquired pneumonia","acuity":"3","location":"Majors 3","clinician":"Dr Alex Morgan"}
// progress (site: hospital). hospitalCommand ∈ assign | assess | refer | admit | discharge
{"type":"update_attendance","resourceId":"r-3831","expectedVersion":1,"hospitalCommand":"assess","clinician":"Dr Alex Morgan"}   // → assessing, data.assessmentAt
{"type":"update_attendance","resourceId":"r-3831","expectedVersion":2,"hospitalCommand":"refer"}                                   // → take, data.referredAt
{"type":"update_attendance","resourceId":"r-3831","expectedVersion":3,"hospitalCommand":"admit","location":"AMU bed 4"}            // → inpatient, data.admittedAt
{"type":"update_attendance","resourceId":"r-3831","expectedVersion":4,"hospitalCommand":"discharge","disposition":"Home with community nursing follow-up"} // → discharged, data.dischargedAt
```
`data`: `stage, acuity, location, arrivalAt, clinician, presentingComplaint, assessmentAt?, referredAt?, admittedAt?, dischargedAt?, disposition?`.
`assign` updates location/acuity/clinician without changing stage. `discharge` without `disposition` → 400.
Discharging does **not** write or send a letter.

Seed per world: 8 attendances — SIM-000001..3 `waiting`, 000004 `assessing`, 000005..6 `take`, **000007 & 000008 `inpatient`** (AMU bed 2/3).
Also a seeded `bed` resource `r-47` "Acute medical bed 12" for SIM-000001 with `data: {ward:"AMU", barrier:"medicines and home monitoring", expectedDischarge:"today"}`,
`capacity-beds {total:2, remaining:2}`, `capacity-hospital {total:2, remaining:2}`, 8 `staff` resources, an open `message` on channel `discharge-and-flow`
("Discharge & flow: confirm medication handover"), and a `care-package` "Home care assessment awaiting allocation" (`fundingDecision: pending`) for SIM-000006.

### 3.2 Discharge letter (hospital → GP)

```jsonc
// draft (site: hospital) → discharge-summary "draft", visibleTo [hospital]
{"type":"save_discharge_summary","patientId":"SIM-000010","title":"Discharge summary · pneumonia admission",
 "dischargeSections":{"reason":"…","course":"…","diagnoses":"…","medicationChanges":"…","results":"…","followUp":"…","gpActions":"…"}}
// edit a draft: same type + resourceId + expectedVersion
// send (site: hospital) → "sent", visibleTo [hospital, gp]; text locked
{"type":"process_document","resourceId":"r-3850","expectedVersion":1,"documentCommand":"send"}
// GP processing (site: gp)
{"type":"process_document","resourceId":"r-3850","expectedVersion":2,"documentCommand":"assign","clinician":"Dr Maya Shah"}      // stays "sent", data.assignee
{"type":"process_document","resourceId":"r-3850","expectedVersion":3,"documentCommand":"review","text":"Reviewed…"}              // → "reviewed", data.reviewNote/reviewedAt/reviewedBy
{"type":"process_document","resourceId":"r-3850","expectedVersion":4,"documentCommand":"file","text":"Filed to record."}          // → "filed", data.filingNote/filedAt/filedBy
{"type":"process_document","resourceId":"r-3850","expectedVersion":5,"documentCommand":"annotate","documentTags":["Follow-up needed"],"documentSnomedCodes":[{"code":"195967001","display":"Asthma"}]} // gp only; both arrays required
```
All 7 sections must contain text to send. `file` requires a prior `review`. `annotate` from hospital → 403. `share_record` on a letter → 409.
Seed: 61 letters per world (37 sent, 12 reviewed, 8 filed, 4 draft) across 60 patients, authored by fictional "Dr Morgan Bell" etc.
Every seeded inpatient already has an *old* sent letter from a previous episode — do not confuse it with the current admission's letter.

### 3.3 Prescriptions (hospital/GP → pharmacy)

```jsonc
// draft (site: hospital or gp) → prescription "draft", owner pharmacy, visibleTo [pharmacy, hospital, patient]
{"type":"draft_prescription","patientId":"SIM-000010","title":"TTO · Amoxicillin",
 "medicationOrder":{"drug":"Amoxicillin capsules","dose":"500","unit":"mg","route":"Oral","frequency":"Three times daily","duration":"3 days","quantity":9,"indication":"Completion of pneumonia course (synthetic)"}}
// pharmacy (site: pharmacy), each needs current expectedVersion
{"type":"link_prescription_stock","resourceId":"r-3852","expectedVersion":1,"productId":"pharmacy-product-amoxicillin","quantity":9} // draft, data.productId/quantity/supplyDrug
{"type":"review","resourceId":"r-3852","expectedVersion":2}    // → reviewed
{"type":"accept","resourceId":"r-3852","expectedVersion":3}    // → approved
{"type":"dispense","resourceId":"r-3852","expectedVersion":4}  // → dispensed; product stock −quantity (105 → 96 observed)
{"type":"collect","resourceId":"r-3852","expectedVersion":5}   // → collected
```
Dispensing with insufficient stock fails; receive a delivery first. Product ids: `pharmacy-product-<slug>`; 30 products per world, e.g.
furosemide(112), atorvastatin(168), amlodipine(84), salbutamol(8), paracetamol(320), **metformin(0)**, omeprazole(56), lansoprazole(84), ramipril(112),
**losartan(0)**, bisoprolol(28), levothyroxine(56), sertraline(84), **citalopram(0)**, fluoxetine(150), cetirizine(30), loratadine(60), **ibuprofen(0)**,
naproxen(112), aspirin(140), clopidogrel(28), **simvastatin(0)**, gliclazide(84), empagliflozin(112), amoxicillin(105), **doxycycline(0)**, nitrofurantoin(28),
ferrous-fumarate(84), folic-acid(112), **vitamin-d(0)**. Each product has 3 `pharmacy-quote`s (supplier, packSize, packCostPence, minimumPacks, leadDays).

Buying: `update_pharmacy_basket {resourceId: basketId, expectedVersion, quoteId, quoteVersion, quantity(packs), requiredUnits}` →
`checkout_pharmacy_basket {resourceId, expectedVersion}` (or `place_pharmacy_order {resourceId: quoteId, expectedVersion, quantity}`) →
advance clock past `dueAt` → `receive_pharmacy_order {resourceId: orderId, expectedVersion, quantity, text}`. `cancel_pharmacy_order`, `receive_stock`, `update_stock_price` also exist.
Pharmacy First: `receive_pharmacy_referral {patientId,title,pharmacyPathway,referralSource}` → `update_pharmacy_referral {pharmacyCommand: accept|consult|complete}`.

### 3.4 Lab tests

```jsonc
// (site: hospital or gp) → test "open", owner diagnostics
{"type":"order_test","patientId":"SIM-000010","title":"Pre-discharge CRP",
 "bloodTestOrder":{"panelId":"crp","panel":"C-reactive protein","specimen":"Serum","priority":"urgent","collection":"now","clinicalDetails":"…"}}
```
`panelId ∈ fbc | ue | hba1c | lft | crp | lipids`; `collection: "now"` → result after 120 sim-min, `"next-round"` → 240. `priority ∈ routine|urgent`.
After advancing the clock: `GET /api/sites/diagnostics/view?patient=` shows the `test` as `available`; clock event `result.available` (actor `laboratory`).
A "pathology-outage" incident (operator) can hold results — handle "still open" gracefully.

### 3.5 Community visits

```jsonc
// (site: hospital, gp or community) → visit "scheduled", owner community, visibleTo [community, hospital, patient], due +90 sim-min
{"type":"schedule_visit","patientId":"SIM-000010","title":"Post-discharge community nurse visit · observations and medicines check"}
// manual completion (site: community)
{"type":"complete","resourceId":"r-3856","expectedVersion":1}
```
Consumes `capacity-community` (total 4 per world). Exhausted → **409** (a real blocker to surface). Auto-completes when the clock passes `dueAt` (`visit.completed` event).

### 3.6 Referrals, tasks, messages

```jsonc
{"type":"create_referral","patientId":"SIM-000010","title":"Equipment: commode and bed rails before discharge"}   // site hospital/gp → referral "open", visibleTo [hospital, patient, referrals]
{"type":"accept","resourceId":"r-3848","expectedVersion":1}     // site referrals → accepted
{"type":"complete","resourceId":"r-3848","expectedVersion":2}   // site referrals → completed   (reject also exists)

{"type":"create_task","patientId":"SIM-000010","title":"Confirm TTO medicines ready","text":"…"}   // site hospital or gp → task "open", owner = that site
{"type":"complete","resourceId":"r-3836","expectedVersion":1}                                       // → completed  (review, accept also valid on tasks)

{"type":"send_message","patientId":"SIM-000010","title":"Discharge coordination · equipment team","text":"…"}  // site hospital → message "open", owner patient

// GP ↔ patient conversation (site gp). Never leaves the sim.
{"type":"messaging_action","patientId":"SIM-000010","messagingCommand":{"kind":"create","subject":"Coming home","body":"…","channel":"sms","allowReply":true}}  // → conversation, entries[0].delivery[0].status "queued"
{"type":"messaging_action","resourceId":"r-3858","expectedVersion":1,"messagingCommand":{"kind":"delivery","entryId":"r-3858-1","status":"delivered"}}
// other kinds: send{body,channel} · reply{body} (site patient, needs patientId) · note{body} · assign{assignee} · complete · reopen · retry{entryId} · save_template · archive_template
```

### 3.7 Other hospital/GP record actions

- `hospital_note {patientId,title,hospitalNoteCommand:{kind:"save",template:"free-text|history-physical|progress",sections:[{id,heading,text}]}}` → then `{kind:"sign"}` or `{kind:"addendum",text}` with resourceId/expectedVersion. Signed notes are immutable.
- `save_consultation {patientId,title,text,mode:"in-person|telephone|video|online",consultationStatus:"draft|saved"}` (gp).
- `save_problem {patientId,title,problemStatus:"active|resolved",problemCode?,onsetDate?}`, `save_allergy {patientId,title,allergyStatus,reaction?}` (gp).
- Appointments (gp): `GET /api/sites/gp/appointments?date=`; `book_appointment {sessionId,sessionVersion,startsAt,patientId,title}`; `arrive_appointment`, `complete`, `cancel_appointment`; `create_appointment_session`, `set_appointment_slot`. Seven days of sessions are seeded (Dr Maya Shah in-person, Dr Daniel Brooks telephone, Nurse Alex Morgan) at 08:00–12:00 and 13:00–17:00 UTC, 15-min slots.
- `connect_device {patientId}` (wearables) → first reading after 10 sim-min.
- `dispatch_robot`, `report_absence`, `restore_staff`, `allocate_shift` exist for other scenarios; not needed here.

## 4. The clock

```jsonc
POST /api/clock  {"paused": true, "advanceMinutes": 121}      // pause + step; advancing a running clock → 409
POST /api/clock  {"paused": false, "speed": 60}               // run at 60× (sim-minutes per real minute, 0–3600)
GET  /api/clock  → {"now": 1789207260000, "paused": true, "speed": 60, "events": [ … ≤100 newest first … ]}
```
Observed on a 121-minute advance in a fresh world: lab result delivered, visit completed, **13 new A&E arrivals** (`acute-flow`),
`flow.pressure` "Demand exceeds staffed bed availability" (`bed-flow`), GP `request.arrived` (`patient-demand`), `service.requested` (new referral),
`observation.received` (wearables). Event shape: `{id, time, type, actor, detail, resourceId?, patientId?, visibleTo[]}`.
Event `type`s seen: our action names (`create_task`, `process_document`, `dispense`, …), `clock.changed`, `emergency.arrived`, `assessment.completed`,
`flow.pressure`, `request.arrived`, `service.requested`, `result.available`, `visit.completed`, `observation.received`.

Each world's clock is independent. All timestamps are sim-time ms (UTC). Our worlds start paused at `1789200000000` = 2026-09-12T08:00:00Z.

## 5. Performance & reliability facts (measured)

| Operation | Typical | Worst seen |
|---|---|---|
| Workspace GETs, clock | 0.5–0.8s | 3s (patients search) |
| `view?patient=` first touch | 25s | 26s |
| `view?patient=` warm | 0.7–1.2s | — |
| `POST …/actions` (any type) | 2–9s when server is quiet | 22–50s under load |
| 8 concurrent writes | 55s wall total (≈ 2 sequential) | — |
| `POST /api/clock` advance 121 min | 2.4s | — |
| Transient failures | `502 Bad Gateway`, empty body | bursts of ~1 min |

Implications for the client:
- Retry 502/503/504 (and network errors) with exponential backoff (3s, 6s, 9s…), reusing the same `Idempotency-Key`.
- Run independent writes concurrently (limit ~8). Serialise writes to the *same* resource (version chain).
- Pre-warm patient views for the cohort at start (in parallel) so the demo's first LLM read is not a 25s stall.
- Show optimistic "in flight" states in the UI; a write can take 30s under hackathon load.
- Read-after-write: the action response *is* the updated resource; use it rather than re-fetching.

## 6. Verified end-to-end run (scratch world `cursorchainscratchprobe7827`, patient SIM-000010)

1. `register_attendance` → `assess` → `refer` → `admit` "AMU bed 4" → **inpatient** (4 writes).
2. In parallel: `save_discharge_summary` (draft), `draft_prescription` (amoxicillin ×9), `schedule_visit`, `order_test` (CRP now), `create_referral` (equipment), gp `messaging_action create` (SMS), `send_message`, `create_task`. All 200.
3. In parallel chains: pharmacy `link_prescription_stock → review → accept → dispense → collect` (stock 105→96); hospital `send` → gp `assign → review → file → annotate`; referrals `accept → complete`; hospital task `complete`.
4. `POST /api/clock advanceMinutes 121` → visit `completed`, test `available`, 13 new A&E arrivals, `flow.pressure`.
5. `update_attendance discharge` with disposition → **discharged**, `dischargedAt` = 08:00 + 121 min.

Total sim writes for one full discharge: ~20. At 8-way concurrency and 5–25s per write that is ~1–3 real minutes per patient; a 6-patient cohort in parallel fits comfortably in a demo.
