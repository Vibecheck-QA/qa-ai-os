---
name: init
description: Install QA AI OS into the current repo — detect the stack, propose the push-gate commands (.qa-ai-os.json), prove each gate can actually pass AND fail, and vendor the quality contract into AGENTS.md so every AI agent reads the same rules. Use when the user says "set up QA AI OS", "install the gates", "qa init", or opens a repo with no .qa-ai-os.json.
---

# QA AI OS — init

Goal: this repo ends with (1) a `.qa-ai-os.json` whose gates are real, honest
commands, (2) the contract from `${CLAUDE_PLUGIN_ROOT}/rules/QUALITY.md` inside
`AGENTS.md`, and (3) `CLAUDE.md` pointing at `AGENTS.md`. Ask before every
write. Works for any stack and any skill level: explain in plain English what
each gate protects against.

## 1. Read the repo
Find the repo root (`git rev-parse --show-toplevel`). Detect the stack from its
files and collect candidate gate commands **from what the repo already has** —
never invent a script that doesn't exist:

| Signal | Candidate gates (prefer CI variants when present) |
|---|---|
| `package.json` scripts | `test:ci` › `test`; `typecheck` / `tsc --noEmit`; `lint`; `build` |
| `pyproject.toml` / `pytest.ini` | `pytest -q`; `ruff check .`; `mypy .` if configured |
| `go.mod` | `go test ./...`; `go vet ./...` |
| `Cargo.toml` | `cargo test`; `cargo clippy -- -D warnings` |
| `Gemfile` | `bundle exec rspec` / `rake test` |
| none of the above | ask what command proves the code works |

If there are no tests at all, say so plainly. Don't create a fake gate; offer
to write the first behaviour test instead.

## 2. Check each gate is honest
For each candidate, run it **on the current commit** and record exit code and
duration. Then check for known lies:

- **Zero tests counts as a pass?** (e.g. `--passWithNoTests`, a runner that
  exits 0 with no files, a filter that silently skips whole files). Set
  `"minTests"` on every test gate to the passing count you just saw (round down
  a little if it varies), and `"maxSkipped"` to today's skipped count. The push
  gate reads the runner's summary (node, Vitest, Jest, Mocha, pytest,
  Playwright) and blocks below the minimum, or when it can't find a summary at
  all. Rerun the gate to confirm the count reads; if it doesn't, say so and
  leave the limits off rather than install a gate that always blocks.
- **Green tests that never touch the change?** Offer `"changedLines"` on the
  test gate: run it with coverage writing an lcov file (commands per runner in
  the README, "Did the tests run the change?") and set
  `{ "lcov": "<that file>", "include": [<the source folders>] }`. Pick `include`
  from where the app code lives (`src/`, `app/`, `lib/`), never the whole repo.
  Confirm with the user before installing it: from then on every push needs
  tests that run its changed lines. Check the base resolves
  (`git rev-parse origin/HEAD`; if not, set `"base"`), add the lcov file to
  `.gitignore`, and run the gate once on a branch with a small change to
  confirm it reads. If the lcov file's paths don't match the repo's, say so and
  leave it off.
- **Pipelines** (`| grep`, `| tail`, `| tee`) hide the real exit code. A gate
  must be a command whose own exit code means pass/fail.
- **Type check excludes the tests?** (check `tsconfig` `exclude`, etc.) Say so.
- **Too slow for every push?** (> ~5 min) Offer a faster subset for the push
  gate and leave the full suite to CI. Set `timeoutSeconds` per gate.

A gate that's **red on the current commit** would block every push. Report it;
let the user fix it first or leave it out knowingly. Never install a red gate
silently.

**Prove one gate can fail** (with approval): add a temporary deliberately
failing test, run the gate, confirm it exits non-zero, delete the test,
confirm green again. A gate that can't fail protects nothing.

## 3. Write `.qa-ai-os.json`
Show the proposal, then write it on approval:

```json
{
  "gates": [
    { "name": "types", "run": "npx tsc --noEmit", "timeoutSeconds": 120 },
    { "name": "tests", "run": "npm run test:ci", "timeoutSeconds": 300 }
  ],
  "allowDirty": false
}
```

Order fastest-first so failures come back quickly. Keep the push gate under
~5 minutes in total; anything slower (full mutation runs, end-to-end suites)
goes to CI, not every push (QUALITY.md §0).

**Pick the AI lineup.** Ask one question: "Which AI coding tools do you pay
for or have installed?" (Claude Code, Codex / ChatGPT, Cursor, Gemini, Copilot,
other). Confirm each with **one real, tiny model call** (e.g. "Reply OK"), not
just `<cli> --version`: a CLI can be installed and still unable to run a model
(wrong model for the plan, expired login). Only list tools that answered.

**Rule:** builder and orchestrator = the tool they work in. Reviewer = an
answering tool from the review skill's list (`codex`, `claude`, `gemini`) whose
model family **differs from the builder's**. None → `fresh-session` (say: a
weaker review, same family). Cursor and Copilot take the family of whatever
model they're set to, so ask which model before pairing.

| They have | orchestrator / builder | reviewer |
|---|---|---|
| Claude Code + Codex | `claude` / `claude` | `codex` |
| Claude Code + Gemini | `claude` / `claude` | `gemini` |
| Codex + Claude Code | `codex` / `codex` | `claude` |
| One tool only (any) | that tool | `fresh-session` |
| Cursor or Copilot + a CLI above | `cursor` or `copilot` / same | the CLI, if its family differs from Cursor's/Copilot's model; else `fresh-session` |

Add it to the config as `"roles"`. The push gate ignores `roles`; it only runs
`gates`.

```json
"roles": {
  "orchestrator": { "tool": "claude" },
  "builder": { "tool": "claude" },
  "reviewer": { "tool": "codex" }
}
```

Explain: from now on, when an
AI agent in Claude Code runs `git push`, the push gate re-runs these on the
commit being pushed and blocks the push if any fails. Every pass writes a
receipt to `.qa-ai-os/receipts/<commit>.json` (each command, exit code,
duration, output tail); offer to add `.qa-ai-os/receipts/` to `.gitignore`. A
pass is remembered per commit while its receipt exists, so an unchanged commit
doesn't re-run.

## 4. Vendor the contract into AGENTS.md
- Read `${CLAUDE_PLUGIN_ROOT}/rules/QUALITY.md`.
- If `AGENTS.md` has `<!-- BEGIN QA-AI-OS -->` … `<!-- END QA-AI-OS -->`,
  replace only what's between the markers. Otherwise append the block. Never
  touch the user's own content outside the markers.
- Above the block, add a short repo section listing the gates from
  `.qa-ai-os.json` so agents without the plugin (Codex, Cursor) know them too.
- If `CLAUDE.md` exists and doesn't reference `AGENTS.md`, offer to add one line:
  "Read AGENTS.md — it is the engineering contract for this repo."
- Cursor users: offer `.cursor/rules/qa-ai-os.mdc` containing a pointer to
  `AGENTS.md` (`alwaysApply: true`).

## 5. Report
Plain English first: what's protected now, what isn't yet (no tests? no type
check? gate too slow?), and the one next step that adds the most safety. Then
the files written. Suggest running `/qa-ai-os:gate build` on the next change,
and `/qa-ai-os:design` if the repo has a UI, `/qa-ai-os:first-tests` if it
uses Supabase or Stripe.
