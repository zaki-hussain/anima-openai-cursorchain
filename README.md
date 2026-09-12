# Homeward — an agentic discharge conductor

OpenAI x Anima Healthtech Hackathon, 12 Sep 2026 · Team 1.

Medically fit patients wait in hospital beds because six teams (pharmacy, lab, community nurses, equipment, the ward doctor,
the GP practice) each own one piece of the discharge and nobody owns the list. Homeward owns the list: it finds who is ready,
runs all six workstreams in parallel through each team's own system in the Anima NHS-SIM neighbourhood, chases blockers,
asks a human only when it must, and frees the bed — demoed side-by-side against the world as it is today.

Start with [`CLAUDE.md`](CLAUDE.md), then:

- [`docs/PLAN.md`](docs/PLAN.md) — what we are building, architecture, order of work, demo script
- [`docs/SIM_API.md`](docs/SIM_API.md) — verified NHS-SIM API reference and action lifecycles
- [`docs/ADK.md`](docs/ADK.md) — Anima ADK cheat sheet (tools, agents, testing, evals)
- [`docs/HACKATHON.md`](docs/HACKATHON.md) — deadlines, judging, submission, NHS 10-Year Plan context

Secrets are environment variables: `SIM_API` (NHS-SIM team key) and `OPENAI_KEY` (OpenAI). Copy `.env.example` to `.env` locally; never commit `.env`.
