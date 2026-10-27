---
stage: spec
status: stub
---

# Spec gate (stub)

**When:** before the first real build.

## Business questions
- What does 'done' mean in the customer's words?
- What must NEVER happen (double-charge, message the wrong person, leak data)?

## Technical questions
- Data model and where each fact has exactly one owner.
- Failure modes: what happens when each dependency is slow, down, or returns garbage?
- Limits: row caps, rate limits, payload sizes, timeouts.

## Verdict
PASS / HOLD / KILL with evidence for each question. Stub: questions only — evidence rules come in a later version.
