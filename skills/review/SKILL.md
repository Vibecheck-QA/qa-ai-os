---
name: review
description: Run the QA AI OS critic loop on the current change — classify it FULL/STANDARD/MINIMAL from the diff, spend only that tier's review budget, send the diff to the repo's configured reviewer (Codex, Claude, Gemini, a fresh session, or a human) with a fixed mandate, answer every finding, verify, and split when findings or rounds pile up. Use when the user says "review this", "get a second opinion", "critique the plan", or before merging.
argument-hint: "[plan|diff|verify]"
---

# QA AI OS — review

Rules: `${CLAUDE_PLUGIN_ROOT}/rules/QUALITY.md` §0–3. The reviewer never edits
the code; the builder fixes.

## 1. Classify from the diff, then set the budget
List changed paths (`git diff --name-only <base>...HEAD` plus uncommitted).
Apply QUALITY.md §3 and state the tier with the specific signal that set it.
Unknown or empty diff → FULL.

| Tier | Do |
|---|---|
| MINIMAL | **Stop here.** No AI review; the repo's gates are the check. Say why it is MINIMAL. |
| STANDARD | diff review + verify, **2 diff rounds max** |
| FULL | plan critique first (if none happened, run **plan** mode and be willing to discard the code), then diff review + verify: **1 plan critique + 3 diff rounds max** |

Run the repo's deterministic gates **before** spending a review round: a red
test is a finding a model doesn't need to find.

## 2. Pick the reviewer
Read `roles.reviewer` from `.qa-ai-os.json`. If it is missing, use the first
available from this list and suggest saving it.

**Commit first.** A verdict only counts if it names a commit (QUALITY.md §7),
and `git diff <base>...HEAD` cannot see uncommitted or untracked files. If
`git status --porcelain` is not empty, commit (or stash what isn't part of the
change) before calling the reviewer. Then save `SHA=$(git rev-parse HEAD)` and
the branch name; every step below uses them.

**Build the packet.** Every reviewer gets the same input, written to a temp
file (`packet.md`, outside the repo) and piped on stdin. What goes in depends
on the mode:

| Mode | Packet |
|---|---|
| plan | `Reviewed commit: <SHA>`, then the **plan text** (no code exists yet, so no diff) |
| diff | `Reviewed commit: <SHA>`, then `git diff <base>...<SHA>` |
| verify | `Reviewed commit: <SHA>`, `Previously reviewed: <old SHA>`, every prior finding with its answer (fixed in `<commit>` / rebutted because …), the fix delta `git diff <old SHA>..<SHA>`, then the full `git diff <base>...<SHA>` |

Append to every mandate: "Begin your reply with `Reviewed: <SHA>`." A reply
that names another commit, or none, is not a verdict; it doesn't count, but
it does spend the round.

| `tool` | How to run it | Notes |
|---|---|---|
| `codex` | `codex exec -s read-only "<mandate>" < packet.md` (the packet arrives as a `<stdin>` block; it can also read the repo) | Separate model family from Claude. Not `codex review`: its `--base` / `--uncommitted` / `--commit` modes reject a custom prompt, so the mandate can't be given (codex-cli 0.149). |
| `claude` | `claude -p "<mandate>" --allowedTools "Read,Grep,Glob" < packet.md` | Mandate **before** `--allowedTools` (it takes several values and would swallow the mandate). Read-only tools only. Separate family from Codex/GPT builders. |
| `gemini` | `gemini -p "<mandate>" < packet.md` | Confirm with one real call first (`/qa-ai-os:init` does). No read-only flag assumed; the edit check below covers it. |
| `pr-bot` | comment the mandate on the PR (e.g. `@codex review …`), plus the prior findings for a verify round; wait for a verdict that names `<SHA>` | Free on some plans; slower. Diff mode only: a PR bot reviews the PR, not a plan. |
| `fresh-session` | a subagent / new chat with **no build context**: the packet, QUALITY.md and the mandate only — never your reasoning | One-AI mode. **Weaker:** same model family as the builder. Say so in the report. |
| `human` | ask the user to review, with the packet | |

**Custom command:** a `run` string in `roles.reviewer` replaces the command.
The packet is piped on stdin and `{mandate}` in the string is replaced with the
mandate text, shell-quoted as one argument, e.g. `"run": "my-ai --ask {mandate}"` runs `my-ai --ask '<mandate>'`. No `{mandate}` → refuse
and ask the user to fix the config (the reviewer would get a packet with no
instructions).

**The reviewer never edits.** After any local reviewer call, the branch must
still be checked out, `git rev-parse HEAD` must equal `<SHA>`, and
`git status --porcelain` must be empty. If not, put it back: `git checkout -f
<branch>`, `git reset --hard <SHA>` (safe: everything was committed first),
`git clean -fd` (everything untracked is the reviewer's, for the same reason).
Discard that round's verdict and report the reviewer as broken. A `restore` or
`clean` alone can't undo a commit the reviewer made.

If the reviewer is the same model family as `roles.builder`, warn once. Cursor,
Copilot and similar tools take the family of whatever model they're set to.

## 3. Mandates (use verbatim)
- **plan:** "Attack this plan. What is missing, unnecessarily complex,
  architecturally risky, or inconsistent with this codebase? Do not write code."
- **diff:** "Review for correctness, regressions, security, race conditions,
  edge cases, missing tests, unnecessary complexity, and requirement
  mismatches. For any new conditional that decides whether to write, list every
  assumption it makes and the code that enforces each. List every other place in
  the codebase that implements the same behaviour and say whether the change
  covers it. Report only real defects — no style notes."
- **verify:** "Verify that the previous findings were actually resolved, and
  identify any new regressions introduced by the fixes. Do not suggest stylistic
  changes."
- **UI diffs, same round:** if the diff touches UI files and `DESIGN.md` has
  `review` rules, append to the diff mandate: "Also check the UI changes
  against these rules only: <the review rules>. Contrast and banned patterns
  are already checked by script; don't re-check them." Design never gets a
  round of its own.

Ask for findings as: severity (P1 breaks users / P2 real bug / P3 risk), file:line,
failure scenario, suggested fix.

## 4. Answer every finding
Fix it (note the commit) or rebut it with evidence. A review is an argument:
push back when a finding is wrong, and record why.

**Stop rules:**
- 3+ correctness findings on a behaviour change → stop patching; propose a split
  into one-concern changes.
- Round budget spent and still not clean → split or hand to a human. Never ship
  unreviewed, never "one more round".

## 5. Verify, then report
Run the **verify** mandate on the fixed commit, with the verify packet (prior
findings, answers and the fix delta; it counts toward the budget).
Done only when a clean verdict names the current commit. Report: tier, reviewer
used (and whether it was same-family), findings (fixed / rebutted), rounds used
of the budget, and whether the twin sweep and claim sweep were done — the two
things no diff review can see.
