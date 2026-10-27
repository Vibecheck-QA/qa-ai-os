---
name: gate
description: Run a QA AI OS lifecycle gate (idea, validate, spec, build, review, ship, operate, grow, sunset) against the current work — asks the technical AND business questions, collects real evidence, and returns PASS / HOLD / KILL saved to .qa-ai-os/verdicts/. Use when the user says "run the build gate", "is this ready to ship", "gate this", "qa check", or before a review or release.
argument-hint: "<stage> [what is being gated]"
---

# QA AI OS — gate

## 1. Pick the gate
Stage from the argument; if missing, infer it from the situation (uncommitted
code → build; open PR → review; about to release → ship; a new idea → idea) and
say which you picked. Read `${CLAUDE_PLUGIN_ROOT}/gates/<stage>.md` and
`${CLAUDE_PLUGIN_ROOT}/rules/QUALITY.md`. If the repo's `AGENTS.md` has repo
rules, those apply too.

## 2. Collect evidence — don't assume it
For every question and check in the gate file, get **evidence**:
- run the command and read its real exit code and output (never a pipeline
  ending in `grep`/`tail` — capture the exit code);
- cite `file:line`;
- quote the measured number or the customer's words.

"Looks fine", "should work", and "the AI said it passed" are not evidence. If
you can't get evidence, the item is **missing**, not passed. A check you could
not run is UNKNOWN, and unknown is never PASS.

For business questions, look in the repo first (`core/`, `bets/`, `decisions/`
if it's a Main Branch business repo; README/docs otherwise). Ask the user only
for what the repo can't answer.

Use the repo's reviewer (`roles.reviewer`, see `/qa-ai-os:review`) as a critic
for anything you wrote yourself in this session — the author grading their own
work is the weakest evidence there is. Skip it for MINIMAL changes, and collect
deterministic evidence (commands, file:line) before spending an AI call
(QUALITY.md §0).

## 3. Verdict
- **PASS** — every required item has evidence.
- **HOLD** — list each missing/failed item and the exact action that flips it.
- **KILL** — evidence says stop, or a kill rule set in advance fired.

Never upgrade a verdict to be encouraging. A HOLD with a clear fix list is the
useful outcome.

## 4. Save it
Write `.qa-ai-os/verdicts/YYYY-MM-DD-<stage>-<short-slug>.md` (ask first the
first time; create the folder):

```markdown
---
stage: build
verdict: HOLD
commit: <sha or "uncommitted">
date: YYYY-MM-DD
---
# Build gate — <what>
| # | Check | Result | Evidence |
|---|---|---|---|
## To flip to PASS
```

## 5. Report
Lead with the verdict and the shortest path to PASS, in plain English. Keep the
evidence table in the file, not the chat.
