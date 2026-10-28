# QA AI OS

Quality gates and critical thinking across the whole software lifecycle — idea
to sunset or sale — technical **and** business.

QA AI OS doesn't replace your test tools. It sits above them: it runs your real
tests, type checks, linters, mutation checks and reviewers, judges their **real
results**, and refuses to call work done without evidence. Any stack, any skill
level.

> AI made everyone a builder. It didn't make anyone a tester.

## Economics first

More checking is not better checking. Spend follows risk: a MINIMAL change
runs only your deterministic gates, a STANDARD change gets one review and one
verify (2 diff rounds max), a FULL change adds a plan critique (plus 3 diff
rounds max).
Scripts run before any AI, the cheap model does the routing, a pass is never
re-earned, and a check that never catches anything gets cut. See
`rules/QUALITY.md` §0.

## What's in v0.12

| Piece | What it does |
|---|---|
| **Push gate** (hook) | When an AI agent runs `git push`, re-runs your gates on the exact commit being pushed and blocks the push if any fails. Catches the classic `tests \| grep FAIL && git push` lie. Can also require that the tests [ran the lines you changed](#did-the-tests-run-the-change). Every pass leaves a [receipt](#receipts): the commit, each command, its exit code and output. Remembers a pass per commit; never remembers a failure. Fails closed. |
| `/qa-ai-os:init` | Detects your stack, proposes honest gate commands, proves they can pass *and* fail, and installs the quality contract into `AGENTS.md` so every AI agent (Claude, Codex, Cursor) reads the same rules. On a Next.js app with no tests, it offers the [recommended stack](#the-recommended-stack-nextjs). |
| `/qa-ai-os:gate <stage>` | Runs a lifecycle gate — asks technical and business questions, collects evidence, returns PASS / HOLD / KILL, saves the verdict. |
| `/qa-ai-os:review` | The critic loop: classify the change from the diff, spend only that tier's budget, send it to your configured reviewer (Codex, Claude, Gemini, a PR bot, a fresh session, or a human), answer every finding, verify, split when findings or rounds pile up. |
| `/qa-ai-os:design` | Agrees a short `DESIGN.md` with you from what your repo already has, then turns every rule a script can check into a push gate: text contrast in every mode (light, dark) read from your tokens, and banned patterns such as light-grey text. Only the rules no script can check go to AI review, inside the normal review round. |
| `/qa-ai-os:first-tests` | The first tests that matter: user A can never read or change user B's data. For Supabase apps, a push gate reads the database's own catalog and fails on tables with RLS off, policies that let every user through, and views or functions that bypass RLS; then it writes two-user tests in your own test runner. For Stripe apps, tests that nobody gets paid access for free, a forged webhook does nothing, a payment is fulfilled exactly once, the price comes from the server, and refunds and cancellations remove access. Every test is proven able to fail. No local database? A one-query check reads your hosted project's catalog from the SQL editor. |
| `/qa-ai-os:mutate` | Break a guard on purpose and prove a test catches it. Saves the breaks so a [mutation gate](#mutation-gate) re-checks them on every push. |
| `rules/QUALITY.md` | The engineering contract. |
| `gates/` | Idea · Validate · Spec · **Build** · **Review** · **Ship** · Operate · Grow · Sunset/sale (bold = full; others are question lists). |

## Install (Claude Code)

```
/plugin marketplace add Vibecheck-QA/vibecheck
/plugin install qa-ai-os@qa-ai-os
```

Then in your repo: `/qa-ai-os:init`.

Repos opt in: the push gate does nothing in a repo without `.qa-ai-os.json`.

## The recommended stack (Next.js)

Most AI-built apps start with no tests at all, and "use whatever runner you
have" gives them nothing. On a Next.js app, `/qa-ai-os:init` offers the setup a
live $3.8k MRR Next.js app runs on, with stricter defaults:

| Piece | Default |
|---|---|
| **Vitest + Testing Library** (unit, component) | Coverage on, so the push gate can require tests that [ran the changed lines](#did-the-tests-run-the-change). Each test starts on a clean screen. |
| **Playwright** (end to end) | A `@smoke` test runs on every push. Playwright builds and starts the app itself. In CI a failing test is retried once for its trace, but a test that only passes on retry still fails: flaky is a bug. |
| **`tsc --noEmit`** | A push gate. |
| **CI workflow** | Every check on every pull request. No "docs-only" or "migration-only" skip: a skipped check is how a broken build ships green. |

What `init` adds to the push gate:

```json
{ "gates": [
  { "name": "types", "run": "npm run typecheck", "timeoutSeconds": 180 },
  { "name": "tests", "run": "npm run test:coverage", "timeoutSeconds": 300, "minTests": 3,
    "changedLines": { "lcov": "coverage/lcov.info", "include": ["lib/", "components/"] } },
  { "name": "smoke", "run": "npm run test:smoke", "timeoutSeconds": 420, "minTests": 1 }
] }
```

- **It never overwrites.** A file you already have is kept; a script with the
  same name is kept (and `init` tells you if its command differs); a layer you
  already cover (Jest, Cypress, ...) is skipped whole.
- **Proven end to end** on every change to this repo: CI applies the stack to a
  fresh Next.js app, installs it, runs every check, then drives the real push
  gate and requires it to pass good code and block three kinds of bad code:
  untested new code, a type error, and a page that throws in the browser.
- Needs Node 22.13 or newer (Vitest 5). `node <plugin>/scripts/stack.js plan`
  shows what it would add without changing anything.

## When to use what

| You're here | Run |
|---|---|
| Just installed, nothing set up yet | `/qa-ai-os:init` |
| Supabase app: can one user see another's data? | `/qa-ai-os:first-tests` (no local database? the [one-query check](#can-strangers-read-your-supabase-data-one-query-no-install)) |
| Taking money with Stripe | `/qa-ai-os:first-tests` (the money paths) |
| Finished a change and want it checked | `/qa-ai-os:review` |
| "Would this test even notice if the check broke?" | `/qa-ai-os:mutate` |
| UI text is hard to read, or dark mode is off | `/qa-ai-os:design` |
| Deciding whether to build an idea | `/qa-ai-os:gate idea` |
| About to ship | `/qa-ai-os:gate ship` |

You don't run anything before a push: the push gate does that on its own.

## Your first hour

1. **Install, then `/qa-ai-os:init`.** It finds your test command and writes
   `.qa-ai-os.json`:

   ```json
   { "gates": [ { "name": "tests", "run": "npm test", "timeoutSeconds": 120 } ] }
   ```

   Then it proves the gate can fail: it adds a test that must fail, runs the
   gate, checks it goes red, removes the test and checks it goes green again.
   A gate that can't fail protects nothing.

2. **Let your agent work as normal.** Say it "simplifies" a price function
   and drops the quantity:

   ```diff
   - module.exports.total = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);
   + module.exports.total = (items) => items.reduce((s, i) => s + i.price, 0);
   ```

   It commits and runs `git push`. The push gate runs your tests on that exact
   commit first:

   ```
   QA AI OS push gate: "tests" failed (exit 1). Push blocked.
   Command: npm test
   Last 25 lines:
       Expected values to be strictly equal:

       5 !== 15
   ...
   # pass 0
   # fail 1
   ```

   Nothing reaches the remote. The agent sees the reason and has to fix the
   code, not the report. A failure is never remembered, so every retry
   re-checks.

   Once the fix is committed, the push goes through and leaves a
   [receipt](#receipts) for that commit in `.qa-ai-os/receipts/`. Pushing the
   same commit again doesn't re-run the gates.

3. **Write the tests that matter.** On a Supabase or Stripe app, run
   `/qa-ai-os:first-tests`. It adds the checks for the bugs that hurt most
   (user A reading user B's rows, paid features for free) and proves each test
   can fail.

4. **Before you merge, `/qa-ai-os:review`.** It sizes the change from the
   diff and spends only that size's review budget.

## Can strangers read your Supabase data? (one query, no install)

All it needs is Node 18+: no plugin, no packages, no database access from
your machine.

```
git clone https://github.com/Vibecheck-QA/vibecheck.git
cd vibecheck
node scripts/rls-check.js --print-query > query.sql
```

Paste `query.sql` into your Supabase project's SQL editor and run it. It is
read-only: it reads the database's own catalog (tables, grants, policies),
never a row of your data. Save the one cell it returns (or the CSV/JSON
export, or your AI assistant's answer) to a file, then:

```
node scripts/rls-check.js --catalog result.json
```

It names every table anyone with your public anon key can read or change,
every policy that lets every user see every row, and every view or function
that skips RLS. The result carries its own md5, so a copy that was edited or
cut short on the way back is refused, never checked. Exit 0 = pass,
1 = findings, 2 = couldn't check. Other API
schemas: add `--schemas public,api` to both commands.

## Receipts

"Done" should come with receipts. Every push the gate lets through writes
`.qa-ai-os/receipts/<commit>.json`: what ran, on which commit, the exit code,
how long it took, how many tests passed and were skipped (when the runner
prints a summary), how many changed lines the tests ran (with
[`changedLines`](#did-the-tests-run-the-change)), and the last 25 lines of
output. From the walkthrough above,
after the fix:

```json
{
  "receipt": "qa-ai-os push gate",
  "result": "pass",
  "commit": "7f2ccd713a840b07074afe8acc7237615425d382",
  "config": "b7595aef2d46",
  "dirty": false,
  "ranAt": "2026-10-28T00:03:48.349Z",
  "gates": [
    {
      "name": "tests",
      "run": "npm test",
      "exit": 0,
      "ms": 6232,
      "output": "...\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# duration_ms 107.458"
    }
  ]
}
```

- **Written by the gate, not by the AI.** It's code that runs after every gate
  passed, so it can't be talked into one. A blocked push leaves no receipt.
- **No receipt, no pass.** A cached pass only counts while its receipt exists
  and matches the commit and gate config. Delete it and the gates run again. A
  receipt written by hand doesn't skip anything: the gate also checks its own
  record of the pass, kept outside the repo.
- **If the receipt can't be written, the push is blocked.**
- **`dirty: true`** means `allowDirty` let uncommitted changes in, so the gates
  ran on more than the commit. The receipt says so instead of vouching for the
  commit alone.
- **Receipts are local and untracked.** Add `.qa-ai-os/receipts/` to
  `.gitignore` to keep them out of `git status`, or commit them as an audit
  trail.

## Mutation gate

A test that stays green when the code is broken protects nothing. List the
ways your code could break in `.qa-ai-os/mutants.json` (`/qa-ai-os:mutate`
writes it with you):

```json
{
  "run": "npm test",
  "mutants": [
    { "name": "total ignores quantity", "file": "price.js", "find": "i.price * i.qty", "replace": "i.price" },
    { "name": "total starts at 1", "file": "price.js", "find": ", 0)", "replace": ", 1)" },
    { "name": "total counts only the first item", "file": "price.js", "find": "items.reduce", "replace": "items.slice(0, 1).reduce" }
  ]
}
```

and add the gate that ships with the plugin:

```json
{ "gates": [
  { "name": "tests", "run": "npm test" },
  { "name": "mutation", "builtin": "mutate" }
] }
```

On every push it breaks your code one way at a time, runs the tests and
requires them to fail. The walkthrough's price function, whose only test uses
one item:

```
killed    total ignores quantity (price.js)
killed    total starts at 1 (price.js)
SURVIVED  total counts only the first item (price.js)

2 of 3 mutants killed, 1 survived (a test that can't catch that break).
```

The push is blocked until a test with two items catches it. Then the receipt
records `3 of 3 mutants killed`.

- **It can't fake a result:** it refuses a red baseline, keeps a byte copy of
  each file, proves each break landed, restores from the copy and checks the
  bytes match.
- **A hang is no verdict.** A test that hangs is killed with everything it
  started, and counts as "couldn't check", never as caught.
- **A killed run is put back.** Each file is backed up to
  `.qa-ai-os/mutate-backup/` before it's broken; the next run restores it,
  and the push gate refuses to push while a backup is waiting.
- Exit 0 = every mutant killed, 1 = one survived, 2 = couldn't check (a
  `find` that doesn't match exactly once, a timeout, a red baseline).

Run it by hand from your repo root with `node <plugin>/scripts/mutate.js`.

## Did the tests run the change?

Green tests prove the tests pass, not that any of them touched what you just
changed. Add `changedLines` to your test gate and run it with coverage on:

```json
{ "gates": [
  { "name": "tests",
    "run": "npx vitest run --coverage.enabled --coverage.reporter=lcov",
    "changedLines": { "lcov": "coverage/lcov.info", "include": ["src/"] } }
] }
```

After the tests pass, the gate takes the lines added since your default branch
(`origin/main`) and checks each one against the lines the run executed. A
change that adds a `discount()` function and a `slug.js` file, with no new
tests:

```
QA AI OS push gate: "tests" passed, but 8 of 9 changed lines never ran in any test (11.1%, minimum 100%; changes since origin/main). Push blocked.
  src/price.js: 6-9
  src/slug.js: no test loaded this file (lines 1-4)
Write tests that run these lines, then push again. If a file above was tested, its path in the coverage file may not match the repo's.
```

With tests for both, the push goes through and the receipt records it:

```json
"changedLines": { "base": "origin/main", "covered": 9, "total": 9, "min": 100 }
```

- **A file no test loads counts as never run.** Node, Jest and pytest leave
  such files out of the coverage report entirely; reading "missing" as
  "nothing to check" is the hole this closes.
- **Only code counts.** Comments, blank lines and braces the coverage report
  doesn't list don't count either way. Test files, `.d.ts` files and anything
  outside `include` aren't changes that need tests.
- **Unknown blocks.** No coverage file from this run (an old one is deleted
  first, so it can't vouch), nothing to compare against, or a bad config: the
  push is blocked, never waved through.
- **Options:** `"min": 80` allows a percentage instead of every line;
  `"exclude": ["src/generated/"]`; `"base": "origin/develop"` (default: the
  remote's default branch, else the upstream). With `allowDirty`, uncommitted
  changes are measured too.
- **Ran is not checked.** Coverage proves a line ran, not that a test would
  notice it breaking. The [mutation gate](#mutation-gate) proves that part.

Coverage commands that write the lcov file (all tested):

| Runner | `run` | `lcov` |
|---|---|---|
| Vitest | `npx vitest run --coverage.enabled --coverage.reporter=lcov` (needs `@vitest/coverage-v8`) | `coverage/lcov.info` |
| Jest | `npx jest --coverage --coverageReporters=lcov` | `coverage/lcov.info` |
| node | `node --test --experimental-test-coverage "--test-coverage-include=src/**" --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=lcov.info` | `lcov.info` |
| pytest | `pytest --cov=src --cov-report=lcov:coverage/lcov.info` (needs `pytest-cov`) | `coverage/lcov.info` |

## `.qa-ai-os.json`

```json
{
  "gates": [
    { "name": "types", "run": "npx tsc --noEmit", "timeoutSeconds": 120 },
    { "name": "tests", "run": "npm run test:ci", "timeoutSeconds": 300, "minTests": 850, "maxSkipped": 0 }
  ],
  "allowDirty": false,
  "roles": {
    "orchestrator": { "tool": "claude" },
    "builder": { "tool": "claude" },
    "reviewer": { "tool": "codex" }
  }
}
```

`roles` is optional and swappable: use whatever AI you have. The reviewer
should be a different model family than the builder; with only one AI, set
`"reviewer": { "tool": "fresh-session" }` and the kit will say the review is
weaker. The push gate only reads `gates`.

**`minTests` / `maxSkipped`:** an exit code can't tell "850 tests passed" from
"0 ran" or "18 files silently skipped". With either limit set, the gate reads
the runner's own summary line (node, Vitest, Jest, Mocha, pytest, Playwright)
and blocks the push when fewer than `minTests` passed, when more than
`maxSkipped` were skipped, or when it can't find a summary at all: unknown is
never a pass. Counts land in the receipt either way:

```json
"tests": { "runner": "vitest", "passed": 852, "failed": 0, "skipped": 0 }
```

**`changedLines`:** require the tests to run the lines this push changes. See
[Did the tests run the change?](#did-the-tests-run-the-change)

## Developing

```
npm test          # behaviour tests: drive the real scripts against real git repos
                  # (the RLS tests start a throwaway Postgres: needs initdb + psql,
                  #  or QA_PG_BIN; QA_SKIP_PG=1 skips them, loudly)
npm run mutate    # every guard in every script must have a killed mutant
npm run validate  # claude plugin validate ./
```

Edit rules in `rules/QUALITY.md`, then `npm run sync-agents`.

Contributions welcome: see `CONTRIBUTING.md`. MIT licensed (`LICENSE`).
