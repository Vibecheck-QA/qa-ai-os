---
stage: ship
status: v0
---

# Ship gate

**When:** before merge/deploy to users.

## Business questions
- What will the customer notice? Is there anything they must be told (changelog,
  email, in-app note)?
- What does success look like in numbers, decided **now**, before shipping? (A
  metric the change itself forces to move proves nothing.)
- What's the rollback plan, and who can run it?

## Technical checks
1. **All gates pass on the exact commit being shipped** (the push gate enforces
   this for `git push`). Evidence: commit SHA + gate results.
2. **No gate is lying**: test files actually loaded (count > 0), type checks
   cover the files that changed, CI didn't skip this change via path filters.
   Evidence: test count, and which CI jobs ran.
3. **Claim sweep** (customer-visible changes): searched docs, help, marketing,
   in-app copy for the feature names *and* negative claims ("doesn't", "can't",
   "not available"). Evidence: the searches and what changed.
4. **Changelog / version** updated if the repo has them.
5. **Silent-failure check**: if this breaks in production, what alerts? Does
   that alert depend on the thing it reports on? (An alert sent by a broken
   service never arrives.)
6. **Data safety** for FULL changes: migrations reversible or backed up;
   destructive operations scoped and confirmed.

## Verdict
- **PASS**: 1–5 have evidence (6 for FULL).
- **HOLD**: missing evidence, a lying gate, or no rollback plan.
- **KILL**: shipping would break a promise to customers that can't be undone.
