# QUALITY.md — the QA AI OS engineering contract

Installed by QA AI OS (`/qa-ai-os:init`) into this repo's `AGENTS.md` between
`BEGIN QA-AI-OS` / `END QA-AI-OS` markers. Every AI agent that reads `AGENTS.md`
(Claude Code via `CLAUDE.md`, Codex, Cursor, others) reads the same rules.

Every rule here exists because breaking it shipped a real bug. Origins are in
the QA AI OS repo; this file states the rule, not the war story.

---

## 0. Economics — every check earns its cost

More checking is not better checking. Time, tokens and money are the budget;
spend them where the risk is.

| Tier (§3) | Runs | AI review budget |
|---|---|---|
| **MINIMAL** | the repo's deterministic gates | none |
| **STANDARD** | gates → review → verify; mutation-test new or changed guards | 2 diff rounds |
| **FULL** | plan critique → gates → review → verify; mutation-test new or changed guards | 1 plan critique + 3 diff rounds |

A "round" is one reviewer call on the diff (review or verify). The FULL plan
critique is budgeted separately because it happens before any code exists.

- **Deterministic before AI.** Types, lint, tests and generated checks run
  first; they are cheap and never hallucinate. Never ask a model to do what a
  script can.
- **Match the model to the job.** Classifying, routing and summarising go to a
  small, cheap model. The strongest model is for critique of risky diffs.
- **Round budget hit → split the change or hand it to a human.** Never answer
  a spent budget by shipping unreviewed, and never by "one more round".
- **Never redo work.** A pass is remembered per commit; an unchanged diff is not
  re-reviewed; mutation testing covers the guards that changed, not the codebase.
- **Slow checks belong in CI, not on every push.** A push gate over ~5 minutes
  gets bypassed; keep the fast subset on push.
- **Measure it.** Record each check's time, cost and catches. An AI check that
  has caught nothing in ~20 changes becomes optional or goes. Cheap regression
  tests are exempt (staying green is their job) unless they are slow.

## 1. Roles

Three roles. Any AI tool (or a human) can fill each; the repo's
`.qa-ai-os.json` `roles` says which.

| Role | Job | Never |
|---|---|---|
| **Orchestrator** | classifies the change, plans, routes work, decides when it is done | declares done without the evidence in §6 |
| **Builder** | writes the change and owns it end to end; fixes review findings | grades its own work as the review |
| **Reviewer** | attacks the plan or diff with the mandates in §2 | edits the branch |

- **The reviewer should be a different model family than the builder.** The
  same model shares the builder's blind spots.
- **With one AI only:** the reviewer is a fresh session with no build context,
  given the diff, these rules and the mandate — not the builder's reasoning.
  This is a weaker review; say so in the verdict.
- A review is an argument, not an order. If a finding is wrong, say why and
  record it, so the next round doesn't relitigate it.

## 2. The loop

```
1. Plan     understand the code, NAME THE PATHS the change will touch
0. Classify those paths → FULL | STANDARD | MINIMAL   (§3)
2. Critique the plan                                   (FULL only, before code)
3. Build    run ALL the repo's gates before pushing   (§6)
4. Review   the critic attacks the diff
5. Fix      the author fixes; push; re-request
6. Verify   "were the previous findings actually resolved? any new regressions?"
```

- **Trace the reported symptom to its exact code path before proposing an edit.**
- **Critique mandate (stage 2):** "Attack this plan. What is missing,
  unnecessarily complex, architecturally risky, or inconsistent with this
  codebase? Do not write code."
- **Review mandate (stage 4):** "Review for correctness, regressions, security,
  race conditions, edge cases, missing tests, unnecessary complexity, and
  requirement mismatches."
- **Verify mandate (stage 6):** "Verify that the previous findings were actually
  resolved, and identify any new regressions introduced by the fixes. Do not
  suggest stylistic changes."
- **Three or more findings on a behaviour-changing change → stop fixing and
  split it.** Each correctness bug after the second says the change is too dense
  for one review. Rounds are capped by tier (§0).
- **MINIMAL skips stages 2 and 4–6.** STANDARD skips stage 2.
- **Write the revert trigger down before shipping**, naming the mechanism to
  revert — not "the PR".
- **Never declare done on push** (STANDARD and FULL): the pushed commit needs
  its own review or verify round, and that round counts toward the budget.

## 3. Classify — pick the path from the diff, not from memory

"Is this risky?" answered from memory drifts toward "no". Derive it from the
paths and the diff. **Classify twice**: once on the planned paths, once on the
real diff before review. If the second pass escalates to FULL, stop and get the
plan critique — and be genuinely willing to discard the implementation.

| Path | Requires | When |
|---|---|---|
| **FULL** | plan critique before the approach is accepted, then the loop; a guard audit (§5.1) if a conditional was added over a write | the diff can corrupt data, move money, widen access, or message a customer |
| **STANDARD** | build → review → fix → verify | the default |
| **MINIMAL** | no review verdict required | the diff provably cannot change runtime behaviour *or* instruct a future agent |

Escalates to FULL: schema/migrations · CI/deploy config · auth, permissions,
credentials · billing, pricing, entitlements · concurrency (locks, queues, cron,
claims) · anything that sends to a customer · destructive data operations ·
**a conditional added beside a write**.

Stays at least STANDARD: agent-instruction files (`AGENTS.md`, `CLAUDE.md`,
rules files). A wrong rule is executed by every later change.

- **Unknown escalates.** Unreadable diff, unknown base, empty file list → FULL.
- **MINIMAL is earned, never defaulted into.**
- A test-only change is capped at STANDARD: a test cannot move money.
- Raising your own tier is always fine; lowering it needs a stated reason.

## 4. Git and the build

- Add explicit paths; never `git add -A` in a tree another agent may share.
- Check the remote branch before pushing; someone may have pushed to it.
- Gitignored build artifacts are missing in a fresh checkout and look like test
  failures. Build them first.
- Never symlink or junction dependency folders (e.g. `node_modules`) into a
  worktree: removing the worktree deletes through the link.
- Merge the main branch rather than rebasing when a version or changelog file is
  involved, and pick the version last.

## 5. Correctness rules

### 5.1 Audit any guard you put over a write
Trigger: the diff adds a conditional that decides whether to write — skip-when,
only-if, dedup, "skip if unchanged", cache check, early return in a loop, batch
flush condition, new pagination.

1. **List the guard's preconditions**: completeness (the lookup holds *every*
   row — beware silent row caps), freshness (it reflects earlier writes in the
   same run), sort stability (pages don't overlap), invalidation, snapshot
   consistency.
2. **Point at the code that enforces each one.** If you can't cite the lines,
   it's a bug in flight.
3. Ask the critic: "List every assumption this guard makes. For each, identify
   the code that enforces it. Flag any precondition that is implicit, depends on
   caller behaviour, or depends on a helper that isn't visibly correct."

Known traps:
- A rename/delete branch must force the write the "skip if unchanged" gate
  would skip.
- **Never advance a "seen" or cache marker on failure** — only after success.
- A skip over a bounded query must make the row *leave* the queue, or it is
  re-fetched forever and starves everything behind it.
- Every external await at startup needs a timeout.
- **A guard can ship a worse bug than it fixes.** A guard that consumes shared
  state (counter, lock, slot) must reject *before* consuming it.

### 5.2 Fix every twin, not the first match
A clean review is not proof a fix is complete: reviewers read the diff and are
blind to the sibling you should have changed.
1. Trace the symptom to its exact path first.
2. Enumerate every site that shares the behaviour (grep the field, helper,
   event type). Fix all of them, or write down why one is excluded.
3. Duplicated logic is the root enabler — prefer extracting one shared helper.

Diff-blind omissions: renamed a field but missed a reader; added an enum case but
missed a `switch`; added a producer but missed its parallel producer.

### 5.3 Fix the premise, not the instance
When many callers can hit a bug, change a type or a data source so the compiler
finds the rest, instead of patching call sites one by one.

### 5.4 Unknown is not false
A missing value is not `false`, `0`, "free" or "passed". A cancelled check is not
a passing check. Model absence explicitly and branch on it.

### 5.5 "The check failed" is not "the check said no"
Any authorization answer (401, 403, denied, not entitled) **fails closed**.
The inconclusive branch is only for "no answer at all" (host unreachable, object
not deployed yet): degrade, emit a distinct reason, retry. If you can't tell
which one you're in, treat it as a denial.

### 5.6 One reason code per cause
One error message for N causes turns diagnosis into a guess.

### 5.7 Prove it even runs
Before asking why something is wrong, confirm it runs at all. A filter that
returns nothing proves nothing until it has matched a known-positive.

### 5.8 Never drive logic from a display value
Prices, labels and display names change. Order and gate by stable identifiers or
position.

## 6. Definition of done

1. **All of the repo's gates pass** — every one listed in `.qa-ai-os.json`, not
   just the tests you think are related. Judge the real exit code: never gate on
   a pipeline ending in `grep`, `tail` or `tee`.
2. **A test file that fails to load runs nothing.** "No tests ran" is not green.
3. **Tests bind to behaviour**: drive the real entry point. Where a source check
   is unavoidable, assert a count or scope it to one function, so a sibling
   holding the string can't make it pass.
4. **Every new or changed guard is mutation-tested**: break it on purpose, confirm a test goes
   red, restore. **Check the baseline is green first** (a red baseline "catches"
   every mutant), prove each mutation actually applied, restore from a byte copy.
5. **Fixtures are hostile**: include the empty, missing, duplicate, out-of-order
   and over-the-limit cases. A fixture that pre-fills the value the code is
   supposed to set hides the bug. A mock looser than the real platform certifies
   broken fixes.
6. **User-visible change → sweep the claims**: search docs, help, marketing and
   in-app copy for the feature's names *and* for negative claims ("doesn't",
   "can't", "not available"). The stale sentence usually denies the feature.
7. The changelog is updated if the repo has one and the change is user-visible.
8. Unless classified MINIMAL, the critic returned a clean verdict on the
   **current** commit (check the reviewed commit, not just "approved").
9. Scope is exactly what was asked. Scope creep is what draws review findings.

## 7. Trusting signals

- A verdict counts only if it names the commit you're shipping.
- When a watcher or query sees nothing, suspect the match condition before the
  interval. Test it on a known-positive.
- A metric your change forces to move tests nothing. Decide the outcome measure
  before shipping.
- Never suppress a tool's stderr when its output decides anything.
