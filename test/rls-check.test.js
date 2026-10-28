'use strict';

// Behaviour tests for scripts/rls-check.js: a throwaway Postgres cluster with
// Supabase's roles and default grants, real tables and policies, and the real
// script run end to end, judged on exit code and output as the push gate will.
//
// Needs Postgres binaries (initdb, pg_ctl, psql): found via QA_PG_BIN,
// `pg_config --bindir`, or the usual install paths. Without them these tests
// FAIL, so a missing Postgres can't pass as green. QA_SKIP_PG=1 skips them, loudly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const tmpDir = require('./tmp.js');
const path = require('path');
const { spawnSync } = require('child_process');
const { tomlValue } = require('../scripts/rls-check.js');
const crypto = require('crypto');
// What the query returns: the catalog as text plus its md5.
const seal = (cat) => { const t = JSON.stringify(cat); return { catalog: t, md5: crypto.createHash('md5').update(t, 'utf8').digest('hex') }; };
const { EXE, findPgBin, startCluster, stopCluster } = require('./pg-cluster.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rls-check.js');

const SKIP = process.env.QA_SKIP_PG === '1';
const BIN = SKIP ? null : findPgBin();
const PSQL = BIN && path.join(BIN, `psql${EXE}`);
let PORT, DATA;
let dbn = 0;

const url = (db) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;
function sql(db, text) {
  const r = spawnSync(PSQL, [url(db), '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

// Supabase's shape: auth helpers, and default privileges that hand the API
// roles everything created in public. Fixtures start hostile, as real projects do.
const BOOT = `
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
`;

if (SKIP) console.log('# QA_SKIP_PG=1: rls-check tests SKIPPED. The RLS gate is untested in this run.');

// test/mutate.js passes its own cluster in QA_PG_PORT, so each mutant's run
// skips the ~10 s start. Everything per process gets its own database.
const BOOT_DB = `boot_${process.pid}`;
const made = [];
test.before(() => {
  if (SKIP) return;
  assert.ok(BIN, 'No Postgres found (initdb + psql). Install Postgres, set QA_PG_BIN, or set QA_SKIP_PG=1 to skip on purpose.');
  if (process.env.QA_PG_PORT) PORT = Number(process.env.QA_PG_PORT);
  else ({ port: PORT, data: DATA } = startCluster(BIN));
  sql('postgres', `CREATE DATABASE ${BOOT_DB};`);
  sql(BOOT_DB, BOOT); // copied per test as a template: much faster than re-running it
});

test.after(() => {
  if (DATA) return stopCluster(BIN, DATA);
  // A shared cluster outlives this process: drop what it made, so databases
  // don't pile up across mutants until a CREATE DATABASE fails.
  if (PORT) for (const db of [...made, BOOT_DB]) sql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
});

// A table done right: RLS on, owner-only policies.
const OWNED = `
CREATE TABLE notes (id serial PRIMARY KEY, user_id uuid NOT NULL, body text);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON notes FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
`;

function project(setupSql, rls = {}, files = {}) {
  const db = `t${process.pid}_${++dbn}`;
  made.push(db);
  sql('postgres', `CREATE DATABASE ${db} TEMPLATE ${BOOT_DB};`);
  sql(db, setupSql);
  const dir = tmpDir('qa-rls-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const cfg = { gates: [], rls: { sql: [PSQL, url(db), '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], ...rls } };
  const all = { '.qa-ai-os.json': JSON.stringify(cfg), ...files };
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const run = (dir) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};

const pgTest = (name, fn) => test(name, { skip: SKIP }, fn);

pgTest('a stock project done right passes (trigger function, extension in public, invoker view)', () => {
  const dir = project(OWNED + `
CREATE EXTENSION pg_stat_statements;  -- extension views land in public; nobody can fix those
CREATE FUNCTION handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
CREATE VIEW my_notes WITH (security_invoker = on) AS SELECT * FROM notes;
`);
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /1 tables, 1 policies, 1 views\/other, 0 definer functions/);
  assert.match(r.out, /skipped \d+ objects owned by extensions/);
  assert.match(r.out, /storage\.objects .* not checked/);
});

pgTest('rls-off: a table with RLS off that the API can reach fails', () => {
  const r = run(project(OWNED + 'CREATE TABLE secrets (id int, v text);'));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /FAIL\s+rls-off public\.secrets: RLS is off: anon can select\/insert\/update\/delete/);
  assert.doesNotMatch(r.out, /public\.notes/);
});

pgTest('rls-off: a column-level grant still counts as reachable', () => {
  const r = run(project('CREATE TABLE secrets (id int, v text); REVOKE ALL ON secrets FROM anon, authenticated; GRANT SELECT (id) ON secrets TO anon;'));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /rls-off public\.secrets: RLS is off: anon can select every row/);
});

pgTest('rls-off: a table the API roles have no grant on is fine', () => {
  const r = run(project(OWNED + 'CREATE TABLE internal (id int); REVOKE ALL ON internal FROM anon, authenticated;'));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('rls-off: a partition with RLS off fails even when its parent has RLS on', () => {
  const r = run(project(`
CREATE TABLE ev (user_id uuid, at date) PARTITION BY RANGE (at);
ALTER TABLE ev ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON ev FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TABLE ev_2026 PARTITION OF ev FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /rls-off public\.ev_2026: .*a partition/);
  assert.doesNotMatch(r.out, /rls-off public\.ev:/);
});

const LEAKS = [
  ['USING (true)', 'FOR SELECT TO authenticated USING (true)', /authenticated select/],
  ['any logged-in user', 'FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL)', /authenticated select/],
  ['a subquery that never ties back to the row', 'FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()))', /authenticated delete/],
  ['INSERT WITH CHECK (true), for the public role', 'FOR INSERT WITH CHECK (true)', /anon insert, authenticated insert/],
  ['ALL with an owner USING but WITH CHECK (true)', 'FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (true)', /authenticated insert, authenticated update/],
  // USING picks the rows B may touch; WITH CHECK only judges the result. B takes over A's row.
  ['UPDATE USING (true) with an owner WITH CHECK', 'FOR UPDATE TO authenticated USING (true) WITH CHECK (user_id = auth.uid())', /authenticated update/],
  // The inner p.id is the subquery's table two levels down, not the row.
  ['a nested subquery that never ties back to the row', 'FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND EXISTS (SELECT 1 FROM profiles q WHERE q.id = p.id)))', /authenticated select/],
];
for (const [name, clause, who] of LEAKS) {
  pgTest(`open-policy: ${name}`, () => {
    const r = run(project(`CREATE TABLE profiles (id uuid); REVOKE ALL ON profiles FROM anon, authenticated;
CREATE TABLE notes (id serial, user_id uuid); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY leak ON notes ${clause};`));
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /FAIL\s+open-policy public\.notes: policy "leak" never reads the row/);
    assert.match(r.out, who);
  });
}

pgTest('open-policy: a subquery that ties back to the row reads it, so it passes', () => {
  const r = run(project(`CREATE TABLE members (team uuid, user_id uuid); REVOKE ALL ON members FROM anon, authenticated;
CREATE TABLE docs (id serial, team uuid); ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY team ON docs FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM members m WHERE m.team = docs.team AND m.user_id = auth.uid()));
CREATE POLICY deep ON docs FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM members m WHERE m.user_id = auth.uid() AND EXISTS (SELECT 1 FROM members n WHERE n.team = docs.team)));`));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('open-policy: a policy on a role that authenticated inherits applies to authenticated', () => {
  const r = run(project(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_app_user') THEN CREATE ROLE qa_app_user; END IF; END $$;
GRANT qa_app_user TO authenticated;
CREATE TABLE notes (id serial, user_id uuid); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY leak ON notes FOR SELECT TO qa_app_user USING (true);`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /open-policy public\.notes: policy "leak" .*authenticated select/);
  assert.doesNotMatch(r.out, /anon select/);
});

pgTest('open-policy: a restrictive owner policy on the same command still guards an open one', () => {
  const r = run(project(OWNED + `CREATE POLICY everyone ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY only_own ON notes AS RESTRICTIVE FOR SELECT TO authenticated USING (user_id = auth.uid());`));
  assert.strictEqual(r.status, 0, r.out);
});

// Restrictive expressions AND onto USING and WITH CHECK separately.
pgTest('open-policy: restrictive policies guarding different UPDATE clauses combine', () => {
  const r = run(project(OWNED + `CREATE POLICY open_upd ON notes FOR UPDATE TO authenticated USING (true) WITH CHECK (user_id = auth.uid());
CREATE POLICY own_rows ON notes AS RESTRICTIVE FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (true);`));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('open-policy: a restrictive policy guarding only USING leaves an open WITH CHECK open', () => {
  const r = run(project(OWNED + `CREATE POLICY open_upd ON notes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY own_rows ON notes AS RESTRICTIVE FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (true);`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /open-policy public\.notes: policy "open_upd" .*authenticated update/);
});

pgTest('open-policy: a role without the table privilege can\'t use the open policy', () => {
  const r = run(project(OWNED + 'CREATE POLICY anyone ON notes FOR SELECT USING (true); REVOKE SELECT ON notes FROM anon, authenticated;'));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('open-policy: an admin-style check says it checks the caller, not the row', () => {
  const r = run(project(`CREATE TABLE profiles (id uuid, is_admin boolean); REVOKE ALL ON profiles FROM anon, authenticated;
CREATE TABLE notes (id serial, user_id uuid); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins ON notes FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_admin));
CREATE POLICY leak ON notes FOR DELETE TO authenticated USING (true);`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /policy "admins" never reads the row: it checks who is calling, not which row/);
  assert.match(r.out, /policy "leak" never reads the row, so it lets every caller through \(authenticated delete\)\n/);
});

// A clause no API caller can satisfy grants nothing.
const AUTH_ROLE = "CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;";
const NEVER = [
  ['USING (false)', 'FOR SELECT USING (false)'],
  ['auth.role() = service_role', "FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')"],
  ['the role claim in the JWT = service_role', "FOR SELECT USING ((auth.jwt() ->> 'role') = 'service_role')"],
  ['service_role = current_user, reversed', "FOR DELETE USING ('service_role' = current_user)"],
];
for (const [name, clause] of NEVER) {
  pgTest(`never true: ${name} grants nothing, so it passes`, () => {
    const r = run(project(AUTH_ROLE + OWNED + `CREATE POLICY dead ON notes ${clause};`));
    assert.strictEqual(r.status, 0, r.out);
  });
}

pgTest('never true: a service_role check OR-ed with something open is still open', () => {
  const r = run(project(AUTH_ROLE + OWNED + "CREATE POLICY leak ON notes FOR SELECT USING (auth.role() = 'service_role' OR auth.uid() IS NOT NULL);"));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /open-policy public\.notes: policy "leak"/);
});

pgTest('admin wording: identity words inside string literals or quoted names do not count as asking', () => {
  const r = run(project(`CREATE TABLE notes (id serial, kind text, "current_user" text); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY leak ON notes FOR SELECT USING ('current_user' IS NOT NULL);`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /policy "leak" never reads the row, so it lets every caller through/);
});

pgTest('admin wording: current_setting() counts as asking who is calling', () => {
  const r = run(project(`CREATE TABLE notes (id serial); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins ON notes FOR SELECT USING (current_setting('request.jwt.claim.role', true) = 'admin');`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /policy "admins" never reads the row: it checks who is calling/);
});

pgTest('never true: a custom ROLE claim is not the role claim, so it is still open', () => {
  const r = run(project(OWNED + "CREATE POLICY leak ON notes FOR SELECT USING ((auth.jwt() ->> 'ROLE') = 'service_role');"));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /open-policy public\.notes: policy "leak"/);
});

pgTest('never true: a restrictive USING (false) guards an open policy', () => {
  const r = run(project(OWNED + `CREATE POLICY everyone ON notes FOR SELECT USING (true);
CREATE POLICY nobody ON notes AS RESTRICTIVE FOR SELECT USING (false);`));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('user-metadata: a policy trusting user_metadata fails', () => {
  const r = run(project(`CREATE TABLE notes (id serial, user_id uuid); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins ON notes FOR SELECT TO authenticated USING (user_id = auth.uid() OR (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');`));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /user-metadata public\.notes: policy "admins" trusts user_metadata/);
});

pgTest('definer-view: a view without security_invoker fails; a materialized view fails', () => {
  const r = run(project(OWNED + 'CREATE VIEW all_notes AS SELECT * FROM notes; CREATE MATERIALIZED VIEW note_counts AS SELECT count(*) FROM notes;'));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /definer-view public\.all_notes: view runs as its owner/);
  assert.match(r.out, /no-rls-object public\.note_counts: materialized view/);
});

pgTest('definer-view: a view the API roles can\'t read is fine', () => {
  const r = run(project(OWNED + 'CREATE VIEW all_notes AS SELECT * FROM notes; REVOKE ALL ON all_notes FROM anon, authenticated;'));
  assert.strictEqual(r.status, 0, r.out);
});

pgTest('definer-function: an RPC-callable SECURITY DEFINER function fails; revoked EXECUTE passes', () => {
  const open = run(project(OWNED + 'CREATE FUNCTION all_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS $$ SELECT body FROM notes $$;'));
  assert.strictEqual(open.status, 1, open.out);
  assert.match(open.out, /definer-function public\.all_bodies\(\): SECURITY DEFINER, callable by anon, authenticated/);
  const closed = run(project(OWNED + `CREATE FUNCTION all_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS $$ SELECT body FROM notes $$;
REVOKE EXECUTE ON FUNCTION all_bodies() FROM PUBLIC, anon, authenticated;`));
  assert.strictEqual(closed.status, 0, closed.out);
});

const ADMIN = OWNED + 'CREATE TABLE products (id int, name text); ALTER TABLE products ENABLE ROW LEVEL SECURITY; CREATE POLICY "read all" ON products FOR SELECT USING (true); REVOKE INSERT, UPDATE, DELETE ON products FROM anon, authenticated;';

pgTest('allow: an entry with a reason allows exactly that rule, object and policy', () => {
  const r = run(project(ADMIN, { allow: [{ rule: 'open-policy', object: 'public.products', policy: 'read all', why: 'public product catalog' }] }));
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /allowed\s+open-policy public\.products "read all": public product catalog/);
});

pgTest('allow: an entry for one rule does not hide another rule on the same object', () => {
  const r = run(project(OWNED + ' CREATE TABLE public_log (id int);', { allow: [{ rule: 'definer-view', object: 'public.public_log', why: 'wrong rule for this object' }] }));
  assert.strictEqual(r.status, 2, r.out); // the entry matches nothing, and the real finding still fails
  assert.match(r.out, /FAIL\s+rls-off public\.public_log/);
  assert.match(r.out, /allow\[0\].*matches nothing/);
});

pgTest('allow: no reason, or no policy name for open-policy, is exit 2', () => {
  const a = run(project(ADMIN, { allow: [{ rule: 'open-policy', object: 'public.products', policy: 'read all', why: ' ' }] }));
  assert.strictEqual(a.status, 2, a.out);
  assert.match(a.out, /needs a reason/);
  const b = run(project(ADMIN, { allow: [{ rule: 'open-policy', object: 'public.products', why: 'catalog' }] }));
  assert.strictEqual(b.status, 2, b.out);
  assert.match(b.out, /needs "policy"/);
});

const MIG = 'CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);';

pgTest('migrations: a database behind the committed migrations is exit 2', () => {
  const files = { 'supabase/migrations/20261001000000_init.sql': '', 'supabase/migrations/20261019120000_more.sql': '' };
  const behind = run(project(OWNED + MIG + "INSERT INTO supabase_migrations.schema_migrations VALUES ('20261001000000');", {}, files));
  assert.strictEqual(behind.status, 2, behind.out);
  assert.match(behind.out, /missing 1 committed migration\(s\) \(20261019120000\): run `supabase migration up`/);
  const current = run(project(OWNED + MIG + "INSERT INTO supabase_migrations.schema_migrations VALUES ('20261001000000'), ('20261019120000');", {}, files));
  assert.strictEqual(current.status, 0, current.out);
  const none = run(project(OWNED, {}, files));
  assert.strictEqual(none.status, 2, none.out);
  assert.match(none.out, /missing 2 committed migration/);
});

pgTest('migrations: one skipped in the middle is exit 2, even with the newest applied', () => {
  const files = { 'supabase/migrations/20261001000000_a.sql': '', 'supabase/migrations/20261010000000_b.sql': '', 'supabase/migrations/20261019000000_c.sql': '' };
  const r = run(project(OWNED + MIG + "INSERT INTO supabase_migrations.schema_migrations VALUES ('20261001000000'), ('20261019000000');", {}, files));
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /missing 1 committed migration\(s\) \(20261010000000\)/);
});

pgTest('an unreachable database is exit 2 and says how to fix it', () => {
  const dir = project(OWNED, { sql: [PSQL, `postgresql://postgres@127.0.0.1:${PORT === 56999 ? 56998 : PORT + 1}/x`, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'] });
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /isn't reachable: run `supabase start`/);
});

pgTest('a command that prints no JSON, or isn\'t installed, is exit 2', () => {
  const noJson = run(project(OWNED, { sql: [PSQL, url('postgres'), '-X', '-A', '-t', '-c', 'select 1'] }));
  assert.strictEqual(noJson.status, 2, noJson.out);
  assert.match(noJson.out, /no JSON/);
  const missing = run(project(OWNED, { sql: ['qa-no-such-psql'] }));
  assert.strictEqual(missing.status, 2, missing.out);
  assert.match(missing.out, /can't run "qa-no-such-psql"/);
});

pgTest('a missing schema, or one with nothing in it, is exit 2', () => {
  const missing = run(project(OWNED, { schemas: ['public', 'api'] }));
  assert.strictEqual(missing.status, 2, missing.out);
  assert.match(missing.out, /schema api doesn't exist/);
  const empty = run(project('CREATE SCHEMA api;', { schemas: ['api'] }));
  assert.strictEqual(empty.status, 2, empty.out);
  assert.match(empty.out, /checks nothing/);
});

pgTest('schemas come from supabase/config.toml [api] when not configured', () => {
  const dir = project(OWNED + `CREATE SCHEMA api; CREATE TABLE api.leak (id int); GRANT USAGE ON SCHEMA api TO anon; GRANT SELECT ON api.leak TO anon;
CREATE SCHEMA graphql_public; CREATE TABLE graphql_public.gleak (id int); GRANT SELECT ON graphql_public.gleak TO anon;`, {},
    { 'supabase/config.toml': 'project_id = "demo"\n\n[api]\nschemas = ["public", "api", "graphql_public"]\n' });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /rls-off api\.leak/);
  assert.match(r.out, /rls-off graphql_public\.gleak/); // an exposed schema is scanned whatever its name
  assert.match(r.out, /in public, api, graphql_public;/);
});

test('with no "sql", the command is docker exec into supabase_db_<project_id>', () => {
  const dir = tmpDir('qa-rls-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ gates: [], rls: {} }));
  fs.mkdirSync(path.join(dir, 'supabase'));
  fs.writeFileSync(path.join(dir, 'supabase', 'config.toml'), 'project_id = "qa_rls_nope"\n');
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  // Docker installed: "No such container: supabase_db_qa_rls_nope". Not installed: can't run "docker".
  assert.match(r.out, /supabase_db_qa_rls_nope|can't run "docker"/);
});

test('no "rls" section, or no way to find the database, is exit 2', () => {
  const dir = tmpDir('qa-rls-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ gates: [] }));
  assert.match(run(dir).out, /no "rls" section/);
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ gates: [], rls: {} }));
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /no project_id/);
});

// The free check: no local database and no repo. The owner pastes --print-query's
// output into the Supabase SQL editor and sends back what it returns.
const runArgs = (dir, args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};
function pasted(setupSql, args = []) {
  const db = `t${process.pid}_${++dbn}`;
  made.push(db);
  sql('postgres', `CREATE DATABASE ${db} TEMPLATE ${BOOT_DB};`);
  sql(db, setupSql);
  const dir = tmpDir('qa-rls-');
  const q = runArgs(dir, ['--print-query', ...args]);
  assert.strictEqual(q.status, 0, q.out);
  return { dir, cell: sql(db, q.out).trim() };
}
const shapes = (cell) => ({
  'the raw cell': cell,
  'a CSV export': `json_build_object\n"${cell.replace(/"/g, '""')}"\n`,
  'a JSON export': JSON.stringify([{ json_build_object: JSON.parse(cell) }]),
  "an AI tool's wrapped answer": JSON.stringify({ result: `Below is the result of the SQL query.\n<data>\n${JSON.stringify([{ json_build_object: JSON.parse(cell) }])}\n</data>` }),
});

pgTest('free check: the pasted result fails a leak, in every shape the SQL editor or an AI tool gives it', () => {
  // Non-ASCII in the catalog: the seal is an md5 of UTF-8 bytes on both sides.
  const { dir, cell } = pasted(OWNED + `CREATE TABLE secrets (id int, v text);
CREATE POLICY "lecture — élève 読む" ON notes FOR SELECT TO authenticated USING (user_id = auth.uid());`);
  assert.match(cell, /é/);
  for (const [shape, body] of Object.entries(shapes(cell))) {
    fs.writeFileSync(path.join(dir, 'result.txt'), body);
    const r = runArgs(dir, ['--catalog', 'result.txt']);
    assert.strictEqual(r.status, 1, `${shape}: ${r.out}`);
    assert.match(r.out, /FAIL\s+rls-off public\.secrets/, shape);
    assert.match(r.out, /1 failures/, shape);
  }
});

pgTest('free check: a project done right passes from the pasted result', () => {
  const { dir, cell } = pasted(OWNED);
  fs.writeFileSync(path.join(dir, 'result.txt'), cell);
  const r = runArgs(dir, ['--catalog', 'result.txt']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /1 tables, 1 policies/);
});

pgTest('free check: --schemas reaches the query and the check', () => {
  const { dir, cell } = pasted(OWNED + 'CREATE SCHEMA api; CREATE TABLE api.leak (id int); GRANT USAGE ON SCHEMA api TO anon; GRANT SELECT ON api.leak TO anon;', ['--schemas', 'public,api']);
  fs.writeFileSync(path.join(dir, 'result.txt'), cell);
  const r = runArgs(dir, ['--catalog', 'result.txt', '--schemas', 'public,api']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /rls-off api\.leak/);
  const other = runArgs(dir, ['--catalog', 'result.txt', '--schemas', 'public,nope']);
  assert.strictEqual(other.status, 2, other.out);
  assert.match(other.out, /schema nope doesn't exist/);
});

pgTest('free check: an allow-list in .qa-ai-os.json still applies', () => {
  const { dir, cell } = pasted(OWNED + 'CREATE TABLE secrets (id int, v text);');
  fs.writeFileSync(path.join(dir, 'result.txt'), cell);
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ gates: [], rls: { allow: [{ rule: 'rls-off', object: 'public.secrets', why: 'test' }] } }));
  const r = runArgs(dir, ['--catalog', 'result.txt']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /allowed\s+rls-off public\.secrets/);
});

pgTest('free check: a result with a missing or mistyped field is exit 2, never a pass', () => {
  const { dir, cell } = pasted(OWNED + `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC, anon, authenticated;`);
  const breaks = {
    'privs left out': (c) => { c.relations[0].privs = {}; },
    'one privilege left out': (c) => { delete c.relations[0].privs.anon.select; },
    'rls as a string': (c) => { c.relations[0].rls = 'false'; },
    'kind left out': (c) => { delete c.relations[0].kind; },
    'policy roles applied left out': (c) => { c.policies[0].applies = {}; },
    'policy command unknown': (c) => { c.policies[0].cmd = 'x'; },
    'policy clause a number': (c) => { c.policies[0].qual = 1; },
    'policy funcs left out': (c) => { delete c.policies[0].qualFuncs; },
    'function exec left out': (c) => { delete c.functions[0].exec; },
    'relations not a list': (c) => { c.relations = {}; },
    'a relation that is null': (c) => { c.relations[0] = null; },
    'version a string': (c) => { c.version = '170000'; },
    'relation kind empty': (c) => { c.relations[0].kind = ''; },
    'relation kind unknown': (c) => { c.relations[0].kind = 'x'; },
    'policy on a table not in the result': (c) => { c.policies[0].table = ''; },
    'relation listed twice': (c) => { c.relations.push({ ...c.relations[0] }); },
    'policy clause without its tree': (c) => { c.policies[0].qualTree = null; },
    'policy tree without its clause': (c) => { c.policies[0].qual = null; },
    'policy tree not a tree': (c) => { c.policies[0].qualTree = ''; },
    'check clause without its tree': (c) => { c.policies[0].checkTree = null; },
  };
  // Each case re-seals what it breaks: this tests the shape checks behind the seal.
  const clean = JSON.parse(JSON.parse(cell).catalog);
  assert.strictEqual(clean.functions.length, 1); // the cases below have something to break
  for (const [name, breakIt] of Object.entries(breaks)) {
    const c = JSON.parse(JSON.parse(cell).catalog);
    breakIt(c);
    fs.writeFileSync(path.join(dir, 'result.txt'), JSON.stringify(seal(c)));
    const r = runArgs(dir, ['--catalog', 'result.txt']);
    assert.strictEqual(r.status, 2, `${name}: ${r.out}`);
    assert.match(r.out, /missing|incomplete|not an object/, name);
  }
});

pgTest('free check: a result edited or cut short after the query ran fails its seal, exit 2', () => {
  const { dir, cell } = pasted(OWNED + 'CREATE TABLE secrets (id int, v text);');
  const sealed = JSON.parse(cell);
  const edits = {
    'one flag flipped': { ...sealed, catalog: sealed.catalog.replace('"rls" : false', '"rls" : true') },
    'cut short': { ...sealed, catalog: sealed.catalog.slice(0, -1) },
    'seal left out': { catalog: sealed.catalog },
    'not sealed at all': JSON.parse(sealed.catalog),
  };
  assert.notStrictEqual(edits['one flag flipped'].catalog, sealed.catalog); // the edit really changed something
  for (const [name, body] of Object.entries(edits)) {
    fs.writeFileSync(path.join(dir, 'result.txt'), JSON.stringify(body));
    const r = runArgs(dir, ['--catalog', 'result.txt']);
    assert.strictEqual(r.status, 2, `${name}: ${r.out}`);
    assert.match(r.out, /seal/.test(name) ? /no seal/ : /seal does not match/, name);
  }
});

test('free check: a file that is not the result, or is missing a part, is exit 2', () => {
  const dir = tmpDir('qa-rls-');
  fs.writeFileSync(path.join(dir, 'junk.txt'), 'Success. No rows returned');
  let r = runArgs(dir, ['--catalog', 'junk.txt']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /isn't the query's result/);
  fs.writeFileSync(path.join(dir, 'part.json'), JSON.stringify(seal({ version: 170000, roles: ['anon', 'authenticated'], schemas: ['public'], relations: [], policies: [] })));
  r = runArgs(dir, ['--catalog', 'part.json']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /missing "functions"/);
  r = runArgs(dir, ['--catalog', 'nope.json']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /no file nope\.json/);
  r = runArgs(dir, ['--catalgo', 'x.json']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /unknown argument --catalgo/);
});

test('tomlValue reads a key in its section only', () => {
  const t = 'project_id = "a"\n[api]\nschemas = ["public"] # comment\n[db]\nport = 54322\n';
  assert.strictEqual(tomlValue(t, '', 'project_id'), '"a"');
  assert.strictEqual(tomlValue(t, 'api', 'schemas'), '["public"]');
  assert.strictEqual(tomlValue(t, 'api', 'port'), undefined);
});
