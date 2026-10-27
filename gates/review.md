---
stage: review
status: v0
---

# Review gate

**When:** after the Build gate passes, before merge.

## Business questions
- Does the change still match the requirement as the *customer* would state it?
- If this goes wrong in production, who notices first — us or a customer? What
  does it cost them?

## Technical checks
1. **A critic who isn't the author reviewed it**: another model, a fresh agent
   with no build context, or a human. The critic does not edit the branch.
   Evidence: who/what reviewed, with which mandate (QUALITY.md §2).
2. **The verdict names the current commit.** A review of an older commit
   doesn't count. Evidence: reviewed commit == HEAD.
3. **Every finding answered**: fixed (with commit) or rebutted (with reason).
4. **Verify round run** after fixes, using the verify mandate — not a generic
   re-review.
5. **Density and budget check**: 3+ correctness findings on a behaviour change
   → split it; round budget (QUALITY.md §0) spent → split or hand to a human.
   Evidence: finding count and rounds used of the budget; if over, the plan.
6. **The reviewer's blind spot covered**: reviews read the diff. Evidence that
   the twin sweep (Build #3) and claim sweep (Ship #3) were done, since no diff
   review can see them.
7. **Revert trigger written** for FULL changes: what signal means revert, and
   which mechanism gets reverted.

## Verdict
- **PASS**: 1–6 have evidence (7 for FULL). For a **MINIMAL** change, 1–5 are
  N/A with the stated reason it is MINIMAL (QUALITY.md §3); 6 still applies.
- **HOLD**: open findings, stale verdict, or density over the line.
- **KILL**: the critic shows the approach is unsound → back to plan.
