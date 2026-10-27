---
stage: build
status: v0
---

# Build gate

**When:** before asking for review, on every change.

## Business questions
- What was asked, in one sentence? Does the diff do exactly that and nothing
  more? (Scope creep is what draws review findings.)
- Who sees this change? (customer-visible → Ship gate's claim sweep applies)

## Technical checks (evidence required for each)
1. **Paths named and classified** FULL / STANDARD / MINIMAL from the diff, not
   memory (QUALITY.md §3). Evidence: the file list + the tier + why.
2. **Symptom traced** (bug fixes): the exact function/line the broken output
   came from. Evidence: file:line, and how you know it's that one.
3. **Every twin covered**: every site sharing the behaviour. Evidence: the
   search you ran and the full list, each marked fixed or excluded-with-reason.
4. **Guard audit** if a conditional now decides whether to write: each
   precondition + the lines that enforce it (QUALITY.md §5.1).
5. **Tests drive behaviour**: a test that exercises the real entry point, with
   hostile fixtures (empty, missing, duplicate, over-limit, out of order).
6. **Mutation-tested** every new or changed guard/check (STANDARD and FULL):
   baseline green → break it → a test goes red → restore. Evidence: the
   mutation and the failing test name. Only the changed guards, not the codebase.
7. **All repo gates pass** (`.qa-ai-os.json`), judged on real exit codes.
   Evidence: the commands and their results. "Tests ran 0 files" is a FAIL.

## Verdict
- **PASS**: all 7 have evidence (4 and 6 may be N/A with a reason).
- **HOLD**: list the missing evidence.
- **KILL** (rare here): the approach is wrong — e.g. classification escalated to
  FULL and the plan critique rejects the approach.
