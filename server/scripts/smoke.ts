/**
 * Smoke test: mints a fresh scratch world and walks one patient through the whole discharge plumbing.
 * Never touches the team demo world. Run with `npm run smoke` (≈1–3 real minutes depending on sim load).
 */
import { env } from '../src/env.js'
import { SimClient, type SimCallLog } from '../src/sim/client.js'
import type { Attendance, Resource } from '../src/sim/types.js'
import { mintWorld } from '../src/sim/worlds.js'

const calls: SimCallLog[] = []
const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const teamName = `homeward-smoke-${runId}`

function printCallTable(): void {
  console.log('\nCall log:')
  for (const c of calls) {
    const what = c.actionType ? `${c.site}:${c.actionType}` : c.path.replace(/\?.*$/, '')
    console.log(`  ${c.ok ? 'ok ' : 'ERR'} ${String(c.ms).padStart(6)}ms x${c.attempts} ${c.method} ${what}${c.error ? ` — ${c.error}` : ''}`)
  }
}
process.on('exit', printCallTable)

console.log(`Target world: ${teamName} (fresh scratch world; the team demo world is untouched)`)
const key = await mintWorld(env.simBaseUrl, teamName)
console.log(`  world=${key.world} created=${key.created} scopes=${key.scopes.join(',')}`)

const sim = new SimClient({ baseUrl: env.simBaseUrl, apiKey: key.apiKey, world: key.teamName, onCall: (log) => calls.push(log) })

const clock = await sim.clock()
console.log(`  clock now=${new Date(clock.now).toISOString()} paused=${clock.paused}`)

const before = await sim.attendances()
const stages = before.resources.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})
console.log(`  seeded attendances: ${JSON.stringify(stages)}`)

const patientId = 'SIM-000010'
console.log(`\nAdmitting ${patientId} …`)
let attendance = await sim.act<Attendance>('hospital', {
  type: 'register_attendance',
  patientId,
  title: 'Community-acquired pneumonia',
  acuity: '3',
  location: 'Majors 3',
  clinician: 'Dr Alex Morgan',
})
for (const step of [
  { hospitalCommand: 'assess', clinician: 'Dr Alex Morgan' },
  { hospitalCommand: 'refer' },
  { hospitalCommand: 'admit', location: 'AMU bed 4' },
]) {
  attendance = await sim.update<Attendance>('hospital', attendance.id, attendance.version, { type: 'update_attendance', ...step })
  console.log(`  → ${attendance.status} (v${attendance.version})`)
}

console.log('\nFiring the delayed workstreams in parallel …')
const [visit, test] = await Promise.all([
  sim.act<Resource>('hospital', { type: 'schedule_visit', patientId, title: 'Post-discharge community nurse visit' }),
  sim.act<Resource>('hospital', {
    type: 'order_test',
    patientId,
    title: 'Pre-discharge CRP',
    bloodTestOrder: { panelId: 'crp', panel: 'C-reactive protein', specimen: 'Serum', priority: 'urgent', collection: 'now', clinicalDetails: 'Synthetic pre-discharge check' },
  }),
])
console.log(`  visit ${visit.id} ${visit.status}; test ${test.id} ${test.status}`)

console.log('\nAdvancing the clock 121 minutes …')
const advanced = await sim.advance(121)
console.log(`  now=${new Date(advanced.now).toISOString()} events=${advanced.events.length}`)
const arrivals = advanced.events.filter((e) => e.type === 'emergency.arrived').length
console.log(`  world agents: ${arrivals} new A&E arrivals, ${advanced.events.filter((e) => e.type === 'flow.pressure').length} flow.pressure events`)

const [community, diagnostics] = await Promise.all([sim.view('community', patientId), sim.view('diagnostics', patientId)])
const visitNow = community.resources.find((r) => r.id === visit.id)
const testNow = diagnostics.resources.find((r) => r.id === test.id)
console.log(`  visit → ${visitNow?.status}; test → ${testNow?.status}`)

console.log('\nDischarging …')
attendance = await sim.update<Attendance>('hospital', attendance.id, attendance.version, {
  type: 'update_attendance',
  hospitalCommand: 'discharge',
  disposition: 'Home with community nursing follow-up',
}, () => sim.currentVersion(() => sim.attendances(), attendance.id))
const stayMinutes = Math.round(((attendance.data.dischargedAt ?? 0) - (attendance.data.admittedAt ?? 0)) / 60000)
console.log(`  → ${attendance.status} at ${new Date(attendance.data.dischargedAt ?? 0).toISOString()} (${stayMinutes} sim-minutes after admission)`)

const writes = calls.filter((c) => c.method === 'POST')
const p50 = [...writes].sort((a, b) => a.ms - b.ms)[Math.floor(writes.length / 2)]?.ms ?? 0
const retried = calls.filter((c) => c.attempts > 1).length
console.log(`\nSummary: ${calls.length} calls, ${writes.length} writes, p50 write ${p50}ms, max ${Math.max(...writes.map((w) => w.ms))}ms, ${retried} retried, ${calls.filter((c) => !c.ok).length} failed`)

const checks = [
  ['attendance discharged', attendance.status === 'discharged'],
  ['visit completed after 121 min', visitNow?.status === 'completed'],
  ['test available after 121 min', testNow?.status === 'available'],
  ['no failed calls', calls.every((c) => c.ok)],
] as const
let failed = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
