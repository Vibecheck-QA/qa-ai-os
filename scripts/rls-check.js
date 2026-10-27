#!/usr/bin/env node
// QA AI OS data-isolation check: reads the live Supabase/Postgres catalog and
// fails when the API roles (anon, authenticated) can reach rows that row-level
// security doesn't guard. Configured under "rls" in .qa-ai-os.json.
//
// Rules (each can be allow-listed per object, with a reason):
//   rls-off            table the API roles can touch, with RLS off
//   open-policy        permissive policy whose condition never reads the row
//                      (`true`, `auth.uid() IS NOT NULL`, ...): every user, every row
//   user-metadata     policy trusting auth.jwt() user_metadata, which users can edit
//   definer-view       view the API roles can read that runs as its owner (bypasses RLS)
//   no-rls-object      materialized view / foreign table the API roles can read (RLS can't apply)
//   definer-function   SECURITY DEFINER function the API roles can call (bypasses RLS via RPC)
//
// A clause that is never true for an API caller (`false`, `auth.role() =
// 'service_role'`) grants nothing, so it counts as closed, not open.
//
// What no catalog check can see: whether a policy reads the RIGHT column
// (`auth.uid() = id` vs `= user_id`). The two-user behaviour tests written by
// /qa-ai-os:first-tests cover that.
//
// Vendored into the user's repo by /qa-ai-os:first-tests and run as a push gate:
//   { "name": "rls", "run": "node scripts/qa-rls-check.js" }
//
// Without a local database (a free check, or a hosted project only):
//   node rls-check.js --print-query [--schemas public,api] > query.sql
//     paste it into the Supabase SQL editor (read-only: it reads the catalog,
//     never a row of your data) and save the one cell it returns to a file;
//   node rls-check.js --catalog result.json [--schemas public,api]
//     checks that file. Accepts the raw cell, a CSV export or a JSON export.
// No dependencies. Exit 0 = pass, 1 = a rule failed, 2 = could not check.
// Unknown is never a pass.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROLES = ['anon', 'authenticated'];
const CMDS = { r: ['select'], a: ['insert'], w: ['update'], d: ['delete'], '*': ['select', 'insert', 'update', 'delete'] };

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The one catalog query. Returns one line: the catalog as text, sealed with its md5
 * (a result edited, cut short or mangled on its way back fails the seal). */
function catalogQuery(schemas) {
  const sch = `ARRAY[${schemas.map(sqlText).join(',')}]::text[]`;
  const notExt = (cls, oid) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cls}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
  const privs = ROLES.map((r) => `'${r}', json_build_object(
        'select', has_any_column_privilege('${r}', c.oid, 'SELECT'),
        'insert', has_any_column_privilege('${r}', c.oid, 'INSERT'),
        'update', has_any_column_privilege('${r}', c.oid, 'UPDATE'),
        'delete', has_table_privilege('${r}', c.oid, 'DELETE'))`).join(',\n        ');
  const funcsIn = (expr) => `(SELECT coalesce(json_agg(DISTINCT pn.nspname || '.' || pp.proname), '[]')
        FROM regexp_matches(coalesce(${expr}::text, ''), ':funcid (\\d+)', 'g') m
        JOIN pg_proc pp ON pp.oid = m[1]::oid JOIN pg_namespace pn ON pn.oid = pp.pronamespace)`;
  return `SELECT json_build_object('catalog', c::text, 'md5', md5(c::text)) FROM (SELECT json_build_object(
  'version', current_setting('server_version_num')::int,
  'roles', (SELECT coalesce(json_agg(rolname), '[]') FROM pg_roles WHERE rolname IN (${ROLES.map(sqlText).join(',')})),
  'schemas', (SELECT coalesce(json_agg(nspname), '[]') FROM pg_namespace WHERE nspname = ANY(${sch})),
  'migrations', CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN NULL
    ELSE to_json((xpath('//v/text()', query_to_xml('SELECT version AS v FROM supabase_migrations.schema_migrations', false, false, '')))::text[]) END,
  'skipped', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${sch}) AND c.relkind IN ('r','p','v','m','f') AND NOT ${notExt('pg_class', 'c.oid')}),
  'relations', (SELECT coalesce(json_agg(json_build_object(
      'name', n.nspname || '.' || c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity,
      'partition', c.relispartition,
      'invoker', coalesce((SELECT lower(split_part(o, '=', 2)) IN ('true','on','1','yes')
        FROM unnest(c.reloptions) o WHERE split_part(o, '=', 1) = 'security_invoker'), false),
      'privs', json_build_object(${privs}))), '[]')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${sch}) AND c.relkind IN ('r','p','v','m','f') AND ${notExt('pg_class', 'c.oid')}),
  'policies', (SELECT coalesce(json_agg(json_build_object(
      'table', n.nspname || '.' || c.relname, 'name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive,
      'roles', (SELECT coalesce(json_agg(CASE WHEN r = 0 THEN 'public' ELSE (SELECT rolname FROM pg_roles WHERE oid = r) END), '[]') FROM unnest(p.polroles) r),
      -- A policy applies to a role that is, or inherits, one of its roles (as Postgres checks it).
      'applies', json_build_object(${ROLES.map((r) => `'${r}', EXISTS (SELECT 1 FROM unnest(p.polroles) pr WHERE pr = 0 OR pg_has_role('${r}', pr, 'USAGE'))`).join(', ')}),
      'qualTree', p.polqual::text, 'checkTree', p.polwithcheck::text,
      -- Functions each clause calls (WITH CHECK falls back to USING): does it ask who the caller is?
      'qualFuncs', ${funcsIn('p.polqual')}, 'checkFuncs', ${funcsIn('coalesce(p.polwithcheck, p.polqual)')},
      'qual', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid))), '[]')
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${sch}) AND ${notExt('pg_class', 'c.oid')}),
  'functions', (SELECT coalesce(json_agg(json_build_object(
      'name', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      'exec', json_build_object(${ROLES.map((r) => `'${r}', has_function_privilege('${r}', p.oid, 'EXECUTE')`).join(', ')}))), '[]')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ANY(${sch}) AND p.prosecdef AND p.prokind = 'f'
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype) AND ${notExt('pg_proc', 'p.oid')})
) AS c) sealed;`;
}

// ---------- evaluation (pure) ----------

const has = (privs, cmd) => ROLES.filter((r) => privs[r] && privs[r][cmd]);
const appliesTo = (pol, role) => Boolean(pol.applies[role]);

/**
 * Does a stored policy expression (pg_node_tree text) read a column of the row
 * it guards? The guarded table is range-table entry 1, so that's a Var with
 * varno 1 whose varlevelsup equals the number of subqueries it sits inside.
 * A Var with varno 1 inside a subquery is the subquery's own table, not the row.
 */
function readsTargetRow(tree) {
  if (!tree) return false;
  const stack = [];
  let depth = 0;
  for (let i = 0; i < tree.length; i++) {
    const ch = tree[i];
    if (ch === '\\') { i++; continue; } // nodeToString escapes braces in tokens
    if (ch === '{') {
      const name = (/^[A-Z_]+/.exec(tree.slice(i + 1, i + 40)) || [''])[0];
      stack.push(name);
      if (name === 'QUERY') depth++;
      if (name === 'VAR') {
        const body = tree.slice(i, tree.indexOf('}', i));
        const no = /:varno (\d+)/.exec(body), up = /:varlevelsup (\d+)/.exec(body);
        if (no && up && Number(no[1]) === 1 && Number(up[1]) === depth) return true;
      }
    } else if (ch === '}') {
      if (stack.pop() === 'QUERY') depth--;
    }
  }
  return false;
}

/** Strip parentheses that wrap the whole expression. */
function unwrap(text) {
  let s = String(text || '').trim();
  const wraps = (t) => {
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') d++;
      else if (t[i] === ')' && --d === 0 && i < t.length - 1) return false;
    }
    return true;
  };
  while (s.startsWith('(') && s.endsWith(')') && wraps(s)) s = s.slice(1, -1).trim();
  return s;
}

// The role an API caller says it is: never 'service_role' (that key skips RLS anyway).
const ROLE_OF = String.raw`(?:auth\.role\(\)|\(?auth\.jwt\(\)\s*->>\s*'role'(?:::text)?\)?|CURRENT_USER|CURRENT_ROLE|SESSION_USER|current_user|current_role|session_user)`;
const SERVICE = String.raw`'service_role'(?:::(?:text|name))?`;
// Case-sensitive: pg_get_expr prints functions in lower case and CURRENT_USER in
// upper (both spellings kept: keywords aren't caller data), and JSON keys are
// case-sensitive, so a custom 'ROLE' claim the caller can set is not 'role'.
const SERVICE_ONLY = new RegExp(String.raw`^(?:${ROLE_OF}\s*=\s*${SERVICE}|${SERVICE}\s*=\s*${ROLE_OF})$`);

/** Is a whole clause never true for an API caller: `false`, or a service-role-only check? */
function neverTrue(text) {
  const s = unwrap(text);
  return s === 'false' || SERVICE_ONLY.test(s);
}

/**
 * Does a clause ask who the caller is? Only words the message: an admin check
 * (asks, never reads the row) is told apart from a plain open policy. Any
 * function outside pg_catalog counts (auth.uid(), or a helper we can't see
 * inside); built-ins ask through current_setting() or the session role, matched
 * outside string literals and quoted names.
 */
function asksCaller(text, funcs) {
  if ((funcs || []).some((f) => !f.startsWith('pg_catalog.') || f === 'pg_catalog.current_setting')) return true;
  const code = String(text || '').replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, '');
  return /\b(current_user|current_role|session_user)\b/i.test(code);
}

const clauseText = (pol, side) => (side === 'using' ? pol.qual : (pol.check ?? pol.qual));
const clauseFuncs = (pol, side) => (side === 'using' ? pol.qualFuncs : pol.checkFuncs);

/**
 * How one clause of a policy guards the rows:
 *   closed  never true for an API caller
 *   open    never reads the row: every caller, every row
 *   ok      reads the row
 * USING picks the rows a caller can see or touch, WITH CHECK (or USING, when
 * there's no WITH CHECK) the rows it can write.
 */
function clauseState(pol, side) {
  const tree = side === 'using' ? pol.qualTree : (pol.checkTree ?? pol.qualTree);
  if (neverTrue(clauseText(pol, side))) return 'closed';
  return readsTargetRow(tree) ? 'ok' : 'open';
}

/** The clauses a command uses. An UPDATE uses both, judged separately: USING (true) lets anyone take over any row. */
function sides(cmd) {
  const out = [];
  if (cmd === 'select' || cmd === 'delete' || cmd === 'update') out.push('using');
  if (cmd === 'insert' || cmd === 'update') out.push('check');
  return out;
}

/** The clauses of a policy, for this command, in one of the given states. */
const clausesIn = (pol, cmd, states) => sides(cmd).filter((c) => states.includes(clauseState(pol, c)));

/** Evaluate a catalog snapshot. Returns [{ rule, object, policy?, msg }]. */
function evaluate(cat) {
  const out = [];
  const byName = new Map(cat.relations.map((r) => [r.name, r]));
  for (const rel of cat.relations) {
    const reach = ROLES.map((r) => [r, ['select', 'insert', 'update', 'delete'].filter((c) => rel.privs[r] && rel.privs[r][c])])
      .filter(([, cs]) => cs.length).map(([r, cs]) => `${r} can ${cs.join('/')}`);
    if (!reach.length) continue;
    if (rel.kind === 'r' || rel.kind === 'p') {
      if (!rel.rls) {
        out.push({
          rule: 'rls-off', object: rel.name,
          msg: `RLS is off: ${reach.join('; ')} every row${rel.partition ? ' (a partition: RLS on the parent table does not cover direct access to it)' : ''}`,
        });
      }
    } else if (rel.kind === 'v') {
      if (has(rel.privs, 'select').length && !rel.invoker) {
        out.push({
          rule: 'definer-view', object: rel.name,
          msg: cat.version < 150000
            ? 'view runs as its owner, so it bypasses RLS; Postgres < 15 has no security_invoker, so revoke the API roles\' access instead'
            : 'view runs as its owner, so it bypasses RLS; set security_invoker = true or revoke the API roles\' access',
        });
      }
    } else if (has(rel.privs, 'select').length) {
      out.push({ rule: 'no-rls-object', object: rel.name, msg: `${rel.kind === 'm' ? 'materialized view' : 'foreign table'}: RLS can't apply, and the API can read it; revoke access or move it out of the API schemas` });
    }
  }

  for (const pol of cat.policies) {
    const rel = byName.get(pol.table);
    if (!rel || !rel.rls) continue; // policies don't apply with RLS off (rls-off reports it)
    const text = `${pol.qual || ''} ${pol.check || ''}`;
    if (/user_metadata/.test(text)) {
      out.push({ rule: 'user-metadata', object: pol.table, policy: pol.name, msg: `policy "${pol.name}" trusts user_metadata, which any user can edit; use app_metadata` });
    }
    if (!pol.permissive) continue;
    const open = [];
    for (const cmd of CMDS[pol.cmd] || []) {
      const clauses = clausesIn(pol, cmd, ['open']);
      if (!clauses.length) continue;
      for (const role of ROLES) {
        if (!appliesTo(pol, role) || !(rel.privs[role] && rel.privs[role][cmd])) continue;
        // Restrictive policies AND onto each clause separately, so every open clause
        // needs a restrictive policy (same command and role) that isn't open there.
        const guarded = clauses.every((c) => cat.policies.some((g) => g.table === pol.table && !g.permissive
          && (CMDS[g.cmd] || []).includes(cmd) && appliesTo(g, role) && !clausesIn(g, cmd, ['open']).includes(c)));
        if (!guarded) open.push(`${role} ${cmd}`);
      }
    }
    if (open.length) {
      const admin = ['using', 'check'].some((c) => clauseState(pol, c) === 'open' && asksCaller(clauseText(pol, c), clauseFuncs(pol, c)));
      out.push({
        rule: 'open-policy', object: pol.table, policy: pol.name,
        msg: admin
          ? `policy "${pol.name}" never reads the row: it checks who is calling, not which row, so whoever passes gets every row (${open.join(', ')}); fine for an admin-only check (allow it with a reason), a leak otherwise`
          : `policy "${pol.name}" never reads the row, so it lets every caller through (${open.join(', ')})`,
      });
    }
  }

  for (const fn of cat.functions) {
    const who = ROLES.filter((r) => fn.exec[r]);
    if (who.length) out.push({ rule: 'definer-function', object: fn.name, msg: `SECURITY DEFINER, callable by ${who.join(', ')} through the API, so it bypasses RLS` });
  }
  return out;
}

/** Split findings into fails and allowed; allow entries that match nothing are errors. */
function applyAllow(findings, allow) {
  const fails = [], allowed = [], errors = [];
  const used = new Set();
  allow.forEach((a, i) => {
    if (!a || !a.rule || !a.object) errors.push(`allow[${i}]: needs "rule" and "object"`);
    else if (a.rule === 'open-policy' || a.rule === 'user-metadata') { if (!a.policy) errors.push(`allow[${i}]: ${a.rule} needs "policy" (the policy name)`); }
    if (!/\w{2,}/.test(String((a && a.why) || ''))) errors.push(`allow[${i}]: needs a reason in "why"`);
  });
  if (errors.length) return { fails, allowed, errors };
  for (const f of findings) {
    const i = allow.findIndex((a) => a.rule === f.rule && a.object === f.object && (a.policy === undefined || a.policy === f.policy));
    if (i >= 0) { used.add(i); allowed.push(`${f.rule} ${f.object}${f.policy ? ` "${f.policy}"` : ''}: ${allow[i].why}`); } else fails.push(f);
  }
  allow.forEach((a, i) => { if (!used.has(i)) errors.push(`allow[${i}] (${a.rule} ${a.object}) matches nothing; remove it`); });
  return { fails, allowed, errors };
}

// ---------- config and transport ----------

function readToml(root) {
  try { return fs.readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8'); } catch { return null; }
}

/** Minimal TOML read: a key's value inside a [section] (or top level when section is ''). */
function tomlValue(toml, section, key) {
  let cur = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const s = /^\[([^\]]+)\]$/.exec(line);
    if (s) { cur = s[1].trim(); continue; }
    const m = new RegExp(`^${key}\\s*=\\s*(.+)$`).exec(line);
    if (m && cur === section) return m[1].trim();
  }
  return undefined;
}

function settings(rls, root) {
  const toml = readToml(root);
  let cmd = rls.sql;
  if (!cmd) {
    const id = toml && tomlValue(toml, '', 'project_id');
    if (!id) throw new Error('rls.sql is not set and supabase/config.toml has no project_id to find the local database container');
    cmd = ['docker', 'exec', '-i', `supabase_db_${JSON.parse(id)}`, 'psql', '-U', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  }
  if (!Array.isArray(cmd) || !cmd.length || cmd.some((a) => typeof a !== 'string')) throw new Error('rls.sql must be a list: the command and its arguments');
  let schemas = rls.schemas;
  if (!schemas) {
    const api = toml && tomlValue(toml, 'api', 'schemas');
    schemas = api ? JSON.parse(api) : ['public'];
  }
  if (!Array.isArray(schemas) || !schemas.length) throw new Error('rls.schemas must be a non-empty list');
  return { cmd, schemas, migrations: rls.migrations || 'supabase/migrations', allow: rls.allow || [] };
}

function runQuery(cmd, sql) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 28,
    env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '3' },
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error(`can't run "${cmd[0]}": not installed or not on PATH (use the real executable, not a .cmd shim)`);
    throw new Error(`"${cmd[0]}" failed: ${r.error.message}`);
  }
  const err = (r.stderr || '').trim();
  if (r.status !== 0) {
    if (/no such container|is not running|could not connect|connection refused|Cannot connect to the Docker daemon/i.test(err)) {
      throw new Error(`the local database isn't reachable: run \`supabase start\` (${err.split('\n')[0]})`);
    }
    throw new Error(`query failed (exit ${r.status}): ${err.split('\n')[0] || 'no error text'}`);
  }
  const line = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).pop();
  let cat;
  try { cat = JSON.parse(line); } catch { cat = null; }
  if (!cat || typeof cat !== 'object') throw new Error(`query returned no JSON (got ${JSON.stringify((line || '').slice(0, 80))})`);
  return checkShape(unseal(cat));
}

/** Migration versions on disk. */
function migrationsOnDisk(root, dir) {
  let files;
  try { files = fs.readdirSync(path.join(root, dir)); } catch { return []; }
  return files.map((f) => /^(\d+)_.*\.sql$/.exec(f)).filter(Boolean).map((m) => m[1]).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

function findRoot(start) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : start;
}

/** Text pasted from the Supabase SQL editor (raw cell, CSV export or JSON export) -> the catalog. */
function parsePasted(text, depth = 0) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (depth > 3) throw new Error("that file isn't the query's result (no JSON object in it): paste the whole cell the query returned");
  const tries = [t];
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const body = t.slice(a, b + 1);
    tries.push(body, body.replace(/""/g, '"')); // a CSV cell doubles its quotes
  }
  for (const x of tries) {
    let v;
    try { v = JSON.parse(x); } catch { continue; }
    for (let i = 0; i < 4; i++) { // unwrap [{ json_build_object: "{...}" }] and the like
      // A string that isn't JSON may wrap it (an AI tool's "here is the result: [...]")
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return parsePasted(v, depth + 1); } }
      // one key or one row: [{ json_build_object: {...} }] (Object.keys of a one-row array is ['0'])
      else if (v && typeof v === 'object' && !('catalog' in v) && Object.keys(v).length === 1) v = Object.values(v)[0];
      else break;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  throw new Error("that file isn't the query's result (no JSON object in it): paste the whole cell the query returned");
}

// Every field a rule reads, with its type. A missing or mistyped field would read
// as "no access" and pass, so it stops the check instead: unknown is never a pass.
const ACT = ['select', 'insert', 'update', 'delete'];
const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const strOrNull = (v) => v === null || isStr(v);
const strList = (v) => Array.isArray(v) && v.every(isStr);
const perRole = (v, ok) => !!v && typeof v === 'object' && ROLES.every((r) => ok(v[r]));
const SHAPE = {
  relations: {
    name: isStr, kind: (v) => ['r', 'p', 'v', 'm', 'f'].includes(v), rls: isBool, partition: isBool, invoker: isBool,
    privs: (v) => perRole(v, (p) => !!p && typeof p === 'object' && ACT.every((a) => isBool(p[a]))),
  },
  policies: {
    table: isStr, name: isStr, cmd: (v) => Object.hasOwn(CMDS, v), permissive: isBool, roles: strList,
    applies: (v) => perRole(v, isBool), qualTree: strOrNull, checkTree: strOrNull,
    qualFuncs: strList, checkFuncs: strList, qual: strOrNull, check: strOrNull,
  },
  functions: { name: isStr, exec: (v) => perRole(v, isBool) },
};

/** The sealed result -> the catalog, only if it is byte for byte what the query produced. */
function unseal(sealed) {
  if (!sealed || typeof sealed.catalog !== 'string' || typeof sealed.md5 !== 'string') {
    throw new Error("that isn't this version's query result (no seal): run the query from --print-query again");
  }
  if (crypto.createHash('md5').update(sealed.catalog, 'utf8').digest('hex') !== sealed.md5) {
    throw new Error('the result was changed or cut short after the query ran (its seal does not match): run the query again and send the whole cell');
  }
  return JSON.parse(sealed.catalog);
}

function checkShape(cat) {
  if (!cat || typeof cat !== 'object') throw new Error('query result is not an object');
  if (!Number.isInteger(cat.version)) throw new Error('query result is missing "version"');
  for (const k of ['roles', 'schemas']) if (!strList(cat[k])) throw new Error(`query result is missing "${k}"`);
  for (const [k, fields] of Object.entries(SHAPE)) {
    if (!Array.isArray(cat[k])) throw new Error(`query result is missing "${k}"`);
    cat[k].forEach((item, i) => {
      const bad = !item || typeof item !== 'object' ? '(not an object)' : Object.keys(fields).find((f) => !fields[f](item[f]));
      if (bad) throw new Error(`query result is incomplete: ${k}[${i}] has a missing or wrong "${bad}", so it can't be checked`);
    });
  }
  // Well-typed isn't enough: evaluate() skips what it can't resolve, so the parts must agree.
  const names = new Set();
  for (const rel of cat.relations) {
    if (names.has(rel.name)) throw new Error(`query result is incomplete: relation ${rel.name} appears twice, so it can't be checked`);
    names.add(rel.name);
  }
  cat.policies.forEach((pol, i) => {
    if (!names.has(pol.table)) throw new Error(`query result is incomplete: policies[${i}] is on ${JSON.stringify(pol.table)}, which isn't in its relations, so it can't be checked`);
    for (const [text, tree] of [['qual', 'qualTree'], ['check', 'checkTree']]) {
      const ok = pol[text] === null ? pol[tree] === null : pol[tree] !== null && pol[tree].startsWith('{');
      if (!ok) throw new Error(`query result is incomplete: policies[${i}] "${text}" and "${tree}" don't match, so it can't be checked`);
    }
  });
  return cat;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function report(cat, schemas, allow) {
  const missingRoles = ROLES.filter((r) => !cat.roles.includes(r));
  if (missingRoles.length) { console.error(`rls check: no ${missingRoles.join('/')} role, so this isn't a Supabase database; nothing to check`); return 2; }
  const missingSchemas = schemas.filter((x) => !cat.schemas.includes(x));
  if (missingSchemas.length) { console.error(`rls check: schema ${missingSchemas.join(', ')} doesn't exist in the database`); return 2; }

  const { fails, allowed, errors } = applyAllow(evaluate(cat), allow);
  for (const a of allowed) console.log(`allowed  ${a}`);
  for (const e of errors) console.error(`UNKNOWN  ${e}`);
  for (const f of fails) console.error(`FAIL     ${f.rule} ${f.object}: ${f.msg}`);
  const tables = cat.relations.filter((r) => r.kind === 'r' || r.kind === 'p').length;
  if (!cat.relations.length && !cat.functions.length) {
    console.error(`rls check: no tables, views or functions in ${schemas.join(', ')}, so it checks nothing`);
    return 2;
  }
  console.log(`rls check: ${tables} tables, ${cat.policies.length} policies, ${cat.relations.length - tables} views/other, ${cat.functions.length} definer functions in ${schemas.join(', ')}; ${fails.length} failures, ${errors.length} unknown, ${allowed.length} allowed`);
  if (cat.skipped) console.log(`rls check: skipped ${cat.skipped} objects owned by extensions`);
  console.log('rls check: storage.objects (file uploads) is not checked; review its policies by hand');
  if (errors.length) return 2;
  return fails.length ? 1 : 0;
}

function main(args = process.argv.slice(2)) {
  const root = findRoot(process.cwd());
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, '.qa-ai-os.json'), 'utf8'));
  } catch (e) {
    if (!args.length) { console.error(`rls check: can't read .qa-ai-os.json (${e.message})`); return 2; }
  }

  let file, schemas;
  try {
    const list = flag(args, '--schemas');
    schemas = list && list.split(',').map((x) => x.trim()).filter(Boolean);
    if (list !== undefined && !schemas.length) throw new Error('--schemas must name at least one schema');
    file = flag(args, '--catalog');
    const values = [file, list].filter((v) => v !== undefined);
    const unknown = args.filter((a) => !['--print-query', '--catalog', '--schemas'].includes(a) && !values.includes(a));
    if (unknown.length) throw new Error(`unknown argument ${unknown[0]} (use --print-query, --catalog <file>, --schemas a,b)`);
    if (args.includes('--print-query') && file !== undefined) throw new Error('use --print-query or --catalog, not both');
  } catch (e) {
    console.error(`rls check: ${e.message}`);
    return 2;
  }

  if (args.includes('--print-query')) {
    process.stdout.write(`-- QA AI OS data-isolation check. Read-only: reads the catalog, never a row of your data.\n${catalogQuery(schemas || ['public'])}\n`);
    return 0;
  }

  // From a saved result: no database, no migrations to compare, allow-list if there is one.
  if (file !== undefined) {
    let cat;
    try {
      cat = checkShape(unseal(parsePasted(fs.readFileSync(file === '-' ? 0 : file, 'utf8'))));
    } catch (e) {
      console.error(`rls check: ${e.code === 'ENOENT' ? `no file ${file}` : e.message}`);
      return 2;
    }
    const allow = (config && config.rls && config.rls.allow) || [];
    return report(cat, schemas || ['public'], allow);
  }

  if (!config.rls) { console.error('rls check: .qa-ai-os.json has no "rls" section; run /qa-ai-os:first-tests'); return 2; }

  let s, cat;
  try {
    s = settings(config.rls, root);
    cat = runQuery(s.cmd, catalogQuery(s.schemas));
  } catch (e) {
    console.error(`rls check: ${e.message}`);
    return 2;
  }

  // The gate reads the local database, not the commit. If any committed migration
  // isn't applied (newest, or one skipped in the middle), a pass would describe
  // some other schema.
  const applied = new Set(cat.migrations || []);
  const missing = migrationsOnDisk(root, s.migrations).filter((v) => !applied.has(v));
  if (missing.length) {
    console.error(`rls check: the local database is missing ${missing.length} committed migration(s) (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}): run \`supabase migration up\`, or \`supabase db reset\` for one skipped in the middle`);
    return 2;
  }
  return report(cat, s.schemas, s.allow);
}

if (require.main === module) process.exit(main());

module.exports = { catalogQuery, evaluate, applyAllow, tomlValue, readsTargetRow, neverTrue, parsePasted, unseal };
