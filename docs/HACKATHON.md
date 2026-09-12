# OpenAI x Anima Healthtech Hackathon — what matters for us

**Saturday 12 September 2026 · OpenAI London HQ.** Discord for all coordination: animahacks.com/discord.
We are **Team 1**: Zaki Hussain, Clement Tong, Sadaf Sohrabi, Lorcan Purcell.

## The brief

> Build and present a working product that directly advances one or more priorities in the NHS 10-Year Health Plan.

It must: address an identifiable priority in the plan; work well enough to demonstrate by end of day; be substantially built today.

## Hard deadlines (today)

| Time | What |
|---|---|
| 13:30–15:15 | Build; **Mentor clinic 2 is 15:15–16:15** (one 20-min slot per team — bring specific questions/decisions) |
| 16:15–18:15 | Final build |
| 18:15–18:30 | Final uploads; check video link and repo access work |
| **18:30** | **Submissions close** (project-submission form; only the latest complete submission counts) |
| 18:30–19:30 | Live demo stalls — judges *and* participants visit; keep ≥1 person at the stall; People's Choice voting |
| 19:30 | People's Choice voting closes |
| 19:50 | Awards |

## Submission requirements

- Submit via the OpenAI x Anima project-submission form before 18:30.
- **Video** hosted somewhere judges can watch without signing in (Loom / unlisted YouTube / Vimeo / Drive). It must show:
  1. the problem we chose, 2. the working product, 3. how it could improve patient care or NHS work.
- Repo: public, or give judges access before the deadline (shun@animahealth.com, wulfie@openai.com, souradip@animahealth.com, tt@openai.com).
- Technical problems with submission → hackathon-support@animahealth.com.

## Judging (each criterion scored 1–10, equal weight; panel agrees final awards)

1. **NHS relevance and impact** — how directly the product advances a 10-Year Plan priority and how important the outcome is.
2. **Quality of the working product** — how well it works in the demo, coherence, how effectively the stated problem becomes a working product built today.
3. **Originality** — fresh approach via technology, product, clinical/operational model, or the combination.

Judges: Shun Pang (CEO, Anima), Wulfie Bain (Applied AI Lead, OpenAI), Souradip Mookerjee (Clinical Engineering Lead, Anima), Tricia Troth (EMEA Head of Startups, OpenAI).
Judges record scores during demos, each nominate up to three finalists, then the panel evaluates finalists.

Prizes: 1st £7.5k + an Eight Sleep; 2nd £5k; 3rd £2.5k. Track prizes: best voice-based solution (Pocket note-takers); People's Choice (Hilo BP monitors).

## Our mentors

- Voice-of-customer (Teams 1–3): **Laura Walker**, Head of Operations, Royal Primary Care, Derbyshire — treat the clinic like a customer interview: does a GP practice ops lead recognise the discharge-letter/TTO/community chaos? What would make them trust an agent to chase it?
- Technical (Teams 1–4): **Souradip Mookerjee**, Clinical Engineering Lead, Anima — also a judge. Good person to sanity-check the "medically fit" judgement boundary and the ADK/sim integration.
- Floating support: Celso Milne (Chief of Staff), Iggy Clavel Briz, Kathryn Hagerty (Anima); Max Greenbury, Juhana Peltomaa (OpenAI).

## NHS 10-Year Health Plan (July 2025) — the parts we stand on

Three radical shifts: **hospital → community**, **analogue → digital**, **sickness → prevention**. Organisers highlighted chapters 2, 3, 4, 6, 8.

- **Ch. 2 From hospital to community.** The NHS is organised around institutions, not people; primary care, community, hospitals, social care operate separately and patients navigate the boundaries. The plan's Neighbourhood Health Service covers *discharge and rehabilitation*, urgent community response, virtual wards, shared care plans, community pharmacy. Delivering it means moving information and accountability across organisational boundaries while keeping continuity and safety. **← our core.**
- **Ch. 3 From analogue to digital.** Staff spend clinical time finding, entering and duplicating information; records don't follow patients between settings. Tools that reduce administrative work for staff; interoperability. **← the conductor removes the manual chasing.**
- **Ch. 6 A new transparency of quality care.** Timely, comparable, useful information that reaches the teams able to act. **← our live per-team delay metrics and evals.**
- **Ch. 8 Powering transformation.** Five big bets incl. interoperable health data and **AI**; the gap between a successful trial and routine use. **← agentic operational AI with evals is exactly the "evidence" story.**
- Ch. 4 prevention is not our focus (mention only that a safe, timely discharge with community follow-up prevents readmission).

Problem framing numbers to verify before the pitch: NHS England delayed-discharge sitreps have consistently reported on the order of 12,000–14,000 patients a day in acute beds who no longer meet the criteria to reside; discharge delays are a primary driver of A&E crowding and ambulance handover delays. Cite the sitrep, not a memory.

## Suggested-problem list from the organisers (for positioning)

Their "if you're stuck" list: closed-loop referrals; ambient scribing; automating incoming letters/discharge correspondence processing (HSSIB investigation into electronic communications on patient discharge); voice agents for every accent; preventative care gaps; surfacing quality signals.
Our idea sits at the intersection of #1 (closed loop across services) and #3 (discharge correspondence), but is framed around **bed flow and the six-team handoff**, which none of the suggestions do — that is our originality angle. Remember: 1/3 of marks are originality.

## Tools available

- NHS-SIM neighbourhood (`https://sim.animahacks.com/control/`, docs `/docs/`): 50,000 synthetic patients per team world; GP records, hospital EPR, pharmacy, community visit board, home wearables, NHS-shaped adapters; team-controlled simulation clock. See `docs/SIM_API.md`.
- Anima ADK (TypeScript agent framework, MIT): tools, multi-agent workflows, human-in-the-loop pause/resume, context control, scripted-model tests, eval suites; OpenAI/Gemini/Claude. See `docs/ADK.md`.
- OpenAI models via the per-team API key (`OPENAI_KEY`); Codex.

Discarded from the brief as irrelevant to us: other teams' rosters, People's Choice voting mechanics beyond the times above, prize logistics, the voice track, breakfast/lunch logistics.
