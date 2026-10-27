# First tests: data isolation (Supabase)

Goal: (1) a push gate that fails when the database lets the API reach rows
RLS doesn't guard, and (2) one behaviour test per user-owned table proving
user B can't read or change user A's rows, each **proven able to fail**. Ask
before every write.

Economics (QUALITY.md §0): the catalog check is a script, so it costs no AI
and runs on every push. The behaviour tests catch what no catalog read can:
a policy that checks the **wrong** column (`auth.uid() = id` where it should
be `= user_id`).

**Local database only.** Every step here runs against the local Supabase stack
(`supabase start`). Never point anything at a hosted project, and never run a
write against one: no `ALTER`, no test users, no inserts.

## 1. Read what exists
- Supabase? `supabase/config.toml`, `supabase/migrations/`, `@supabase/supabase-js`
  (or `supabase-py`, `supabase-flutter`). No Supabase → say this pack doesn't
  apply yet and stop.
- Local stack running? `supabase status`. Not running → ask the user to run
  `supabase start` (it needs Docker). Don't install the gate without it.
  No local stack at all (a hosted project only, no Docker) → offer the one-off
  check first: `node ${CLAUDE_PLUGIN_ROOT}/scripts/rls-check.js --print-query`,
  the user pastes it into the Supabase SQL editor (read-only: it reads the
  catalog, never a row), saves the cell it returns, then `--catalog <file>`.
  It reads production as it is today, not the commit, so it is a check, never a gate.
- Migrations applied? `supabase migration list --local`. Behind → `supabase migration up`.
- The test runner the repo already uses (`vitest`, `jest`, `pytest`, …). None →
  offer the smallest one for the stack; don't add a second runner.

## 2. Install the catalog check
Copy `${CLAUDE_PLUGIN_ROOT}/scripts/rls-check.js` to `scripts/qa-rls-check.js`
and add to `.qa-ai-os.json`:

```json
"rls": {},
"gates": [ …, { "name": "rls", "run": "node scripts/qa-rls-check.js", "timeoutSeconds": 30 } ]
```

With `"rls": {}` it finds the database by `project_id` in `supabase/config.toml`
(`docker exec -i supabase_db_<project_id> psql …`) and the API schemas from its
`[api] schemas`. Override only when needed:
- `"sql"`: any command that reads SQL on stdin and prints the result, as a list,
  e.g. `["psql", "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"]`.
  Use a real executable (on Windows, not a `.cmd` shim). Never put a hosted
  project's connection string here: this file is committed.
- `"schemas"`: the schemas the API exposes. `"migrations"`: if not `supabase/migrations`.

Run it. It exits 0 (pass), 1 (a rule failed) or 2 (couldn't check: stack down,
database behind the migrations, bad config). Exit 2 blocks the push too;
unknown is never a pass.

| Rule | Means | Usual fix |
|---|---|---|
| `rls-off` | the API can reach a table with RLS off | `alter table … enable row level security;` plus owner policies |
| `open-policy` | a policy never reads the row (`true`, `auth.uid() IS NOT NULL`, a subquery that never ties back to the row): every user gets every row | compare a row column to `auth.uid()` |
| `user-metadata` | a policy trusts `user_metadata`, which users edit themselves | use `app_metadata` |
| `definer-view` | a view runs as its owner and bypasses RLS | `with (security_invoker = on)` (Postgres 15+), or revoke access |
| `no-rls-object` | a materialized view / foreign table the API can read | revoke access, or move it out of the API schemas |
| `definer-function` | an RPC-callable `SECURITY DEFINER` function bypasses RLS | `security invoker`, or `revoke execute … from anon, authenticated` |

Trigger functions (like Supabase's `handle_new_user`) and objects owned by
extensions are skipped. A policy no API caller can pass (`false`, `auth.role() = 'service_role'`) grants nothing, so it isn't reported. An `open-policy` that checks the caller but not the row (an admin check) says so; allow it if it is one. `storage.objects` (file uploads) isn't checked; say so
in the report, and review its policies by hand.

**Fix in a migration**, never in Studio (the gate reads the local database,
and a Studio-only fix never reaches production). Write the migration, apply it
locally, rerun. **The user applies migrations to production themselves.**

Some findings are intended: a public product catalog (`open-policy`), an
`is_admin()` helper used inside policies (`definer-function`). Allow each one
exactly, with a reason the user agrees with:

```json
"rls": { "allow": [
  { "rule": "open-policy", "object": "public.products", "policy": "read all", "why": "public product catalog" }
] }
```

`open-policy` and `user-metadata` entries need the policy name. An entry
covers one rule on one object; an entry that matches nothing fails the check
(remove it).

## 3. Write the two-user tests
Pick the **user-owned** tables: a column holding a user id (`user_id`,
`owner_id`, `created_by`, `profile_id` …) or a policy that compares to
`auth.uid()`. For each, one test file in the repo's runner:

- **Setup** with the local service-role key (`supabase status` prints it; read
  it from the environment, never hard-code it): create users A and B through
  the auth admin API, and insert one row owned by A.
- **As B** (a client signed in as B, anon key):
  - select A's row → **0 rows** (RLS hides rows; it doesn't error)
  - update and delete A's row → **0 rows affected**, and A's row unchanged
    (check with the service-role client)
  - insert a row with A's user id → **refused**
- **As A**: can read their own row (proves the test isn't passing because
  nothing works).
- **Teardown**: delete both users and their rows, even when the test fails.

Name the test after the promise: "user B can't read or change user A's notes".

## 4. Prove each test can fail
A test that can't fail protects nothing. With the user's approval, on the
**local** database only, break each table two ways, run its test, put it back:

1. `alter table <t> disable row level security;` → the test must FAIL.
2. Replace its owner policy with `using (true)` (save the original first with
   `select pg_get_expr(polqual, polrelid) … from pg_policy`) → must FAIL.

Restore in a `finally` (re-enable RLS, recreate the original policy) and rerun:
it must PASS again. The safest restore is `supabase db reset`, which rebuilds
the local database from the migrations; ask before it, since it wipes local data.
Report any test that didn't fail; it's not done.

## 5. Report
Plain English first: which tables are protected and proven, what was allowed
and why, what isn't covered (storage files, tables with no user owner, Studio
changes that never made it into a migration). Then the files written and the
gate added.
