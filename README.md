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

## What's in v0.7

| Piece | What it does |
|---|---|
| **Push gate** (hook) | When an AI agent runs `git push`, re-runs your gates on the exact commit being pushed and blocks the push if any fails. Catches the classic `tests \| grep FAIL && git push` lie. Remembers a pass per commit; never remembers a failure. Fails closed. |
| `/qa-ai-os:init` | Detects your stack, proposes honest gate commands, proves they can pass *and* fail, and installs the quality contract into `AGENTS.md` so every AI agent (Claude, Codex, Cursor) reads the same rules. |
| `/qa-ai-os:gate <stage>` | Runs a lifecycle gate — asks technical and business questions, collects evidence, returns PASS / HOLD / KILL, saves the verdict. |
| `/qa-ai-os:review` | The critic loop: classify the change from the diff, spend only that tier's budget, send it to your configured reviewer (Codex, Claude, Gemini, a PR bot, a fresh session, or a human), answer every finding, verify, split when findings or rounds pile up. |
| `/qa-ai-os:design` | Agrees a short `DESIGN.md` with you from what your repo already has, then turns every rule a script can check into a push gate: text contrast in every mode (light, dark) read from your tokens, and banned patterns such as light-grey text. Only the rules no script can check go to AI review, inside the normal review round. |
| `/qa-ai-os:first-tests` | The first tests that matter: user A can never read or change user B's data. For Supabase apps, a push gate reads the database's own catalog and fails on tables with RLS off, policies that let every user through, and views or functions that bypass RLS; then it writes two-user tests in your own test runner. For Stripe apps, tests that nobody gets paid access for free, a forged webhook does nothing, a payment is fulfilled exactly once, the price comes from the server, and refunds and cancellations remove access. Every test is proven able to fail. No local database? A one-query check reads your hosted project's catalog from the SQL editor. |
| `/qa-ai-os:mutate` | Break a guard on purpose and prove a test catches it. |
| `rules/QUALITY.md` | The engineering contract. |
| `gates/` | Idea · Validate · Spec · **Build** · **Review** · **Ship** · Operate · Grow · Sunset/sale (bold = full; others are question lists). |

## Install (Claude Code)

```
/plugin marketplace add Vibecheck-QA/qa-ai-os
/plugin install qa-ai-os@qa-ai-os
```

Then in your repo: `/qa-ai-os:init`.

Repos opt in: the push gate does nothing in a repo without `.qa-ai-os.json`.

## Can strangers read your Supabase data? (one query, no install)

```
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

## `.qa-ai-os.json`

```json
{
  "gates": [
    { "name": "types", "run": "npx tsc --noEmit", "timeoutSeconds": 120 },
    { "name": "tests", "run": "npm run test:ci", "timeoutSeconds": 300 }
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
