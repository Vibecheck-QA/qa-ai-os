# Lifecycle gates

Each gate asks **technical and business** questions, demands **evidence**, and
returns one verdict:

- **PASS** — every required check has evidence.
- **HOLD** — something is missing or unproven; list exactly what would flip it.
- **KILL** — evidence says stop (or a kill rule set in advance fired).

"I believe it's fine" is not evidence. Evidence is a command's real output, a
file:line, a measured number, or a quoted customer.

| Stage | File | Status |
|---|---|---|
| Idea | `idea.md` | stub |
| Validate | `validate.md` | stub |
| Spec | `spec.md` | stub |
| **Build** | `build.md` | v0 |
| **Review** | `review.md` | v0 |
| **Ship** | `ship.md` | v0 |
| Operate | `operate.md` | stub |
| Grow | `grow.md` | stub |
| Sunset / sale | `sunset.md` | stub |

Run one with `/qa-ai-os:gate <stage>`. Verdicts are saved to
`.qa-ai-os/verdicts/` in the repo so the history is auditable.

Planned add-ons ("-ilities"): security, performance, accessibility,
reliability, privacy, cost.
