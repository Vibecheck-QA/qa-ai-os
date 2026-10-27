# Contributing

Thanks for helping. QA AI OS holds itself to the contract it ships
(`rules/QUALITY.md`), so a change is welcome when it comes with evidence.

## Setup

```
npm test          # behaviour tests: drive the real scripts against real git repos
npm run mutate    # every guard in every script must have a killed mutant
npm run validate  # claude plugin validate ./
```

The RLS tests start a throwaway Postgres: they need `initdb` and `psql` on your
PATH (or `QA_PG_BIN` pointing at them). `QA_SKIP_PG=1` skips them, loudly; a
pull request that touches `scripts/rls-check.js` needs them run.

## What a good pull request has

- **One concern.** A fix, a new check, or a doc change, not all three.
- **A behaviour test.** Tests run the real script on a real repo or database
  and assert what a user would see (exit code and message), not that a string
  exists in the source.
- **A killed mutant for every new guard.** Add an entry to `test/mutate.js`
  that breaks your guard, and show `npm run mutate` kills it. A guard no test
  can catch breaking is not a guard.
- **Unknown is never a pass.** If a check can't tell, it exits 2 and says why.
- **Rules edits go in `rules/QUALITY.md`**, then `npm run sync-agents` to
  refresh `AGENTS.md`. Don't edit the synced block by hand.

## Economics

More checking is not better checking. A new check should name the bug it
catches and why a cheaper check (a script before an AI, one review round
before two) can't. Checks that never catch anything get cut.

## Reporting a security issue

Please don't open a public issue for a way to bypass a gate or leak data.
Use GitHub's private vulnerability reporting on this repo (Security tab →
Report a vulnerability).

## License

By contributing you agree your work is released under the MIT License
(`LICENSE`).
