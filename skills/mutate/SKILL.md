---
name: mutate
description: Mutation-test a guard, check, or fix — break it on purpose, one way at a time, and prove a test goes red for each break; any surviving mutant is an untested guard. Works with any language and test runner. Use when the user says "mutation test this", "prove the test catches it", "is this guard tested", or after adding any guard/fix.
argument-hint: "<file or function> [test command]"
---

# QA AI OS — mutate

A test that stays green when the code is broken protects nothing. This proves
the tests would catch the bug coming back.

## Rules (each one exists because breaking it faked a result)
1. **Baseline green first.** Run the test command untouched. If it's red, stop:
   a red baseline reports every mutant as "caught".
2. **Byte copy before mutating.** Copy the file's exact bytes; restore from the
   copy — never by reversing your edit.
3. **Prove each mutation applied.** After editing, confirm the file changed.
   A replace that didn't match is a fake "survived" or fake "killed".
4. **One mutation at a time.** Run the suite, record killed/survived, restore,
   next.
5. **Verify the restore** at the end: file bytes identical to the copy, and
   `git status`/`git diff` clean for that file.
6. **Never run the suite elsewhere** while mutations are in place.

## Run them with the shipped runner
Don't mutate by hand: write the mutants to `.qa-ai-os/mutants.json` (ask
first) and run `node ${CLAUDE_PLUGIN_ROOT}/scripts/mutate.js` from the repo
root. It enforces every rule above (green baseline, byte copy, proof each
mutation landed, one at a time, verified restore, put back after a killed run)
and kills a hung test with everything it started.

```json
{
  "run": "npm test",
  "timeoutSeconds": 300,
  "mutants": [
    { "name": "total ignores quantity", "file": "src/price.ts", "find": "i.price * i.qty", "replace": "i.price" },
    { "name": "webhook skips the signature check", "file": "app/api/webhooks/stripe/route.ts", "find": "constructEvent(", "replace": "JSON.parse(", "run": "npx vitest run webhooks" }
  ]
}
```

`find` must match exactly once (add surrounding text until it does). A mutant's
own `run` narrows it to the tests that cover it (QUALITY.md §0). Exit 0 = all
killed, 1 = a mutant survived, 2 = couldn't check.

## Choosing mutants
For the target guard/fix, break each thing it depends on:
- flip or drop the condition (`if (x)` → `if (true)` / `if (false)`)
- off-by-one the boundary (`<` ↔ `<=`, cap 1000 → 999)
- skip the write / always write
- swap the order of two steps (check before vs after consuming state)
- drop one field from a key, one item from a list, one branch of a switch
- fail open instead of closed in the error path
- advance a cache/marker on failure instead of success

Aim for the mutants that match **real bugs** in this code's history, not
cosmetic ones.

## Report
Table: mutant → killed/survived → which test caught it. For each survivor:
either write the test that kills it, or mark it `EXPECTED-SURVIVOR` with a
reason (e.g. equivalent mutant), and take it out of `mutants.json`.

Then offer to make it a push gate, so the proof re-runs on every push and lands
in the receipt: add `{ "name": "mutation", "builtin": "mutate" }` to `gates` in
`.qa-ai-os.json` (after the tests: it re-runs them per mutant). Add
`.qa-ai-os/mutate-backup/` to `.gitignore`.
