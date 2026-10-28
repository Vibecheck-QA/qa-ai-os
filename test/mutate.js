#!/usr/bin/env node
// Mutation check for the plugin's guards (push gate, design, RLS checks): break a
// guard on purpose, one way at a time, and require its tests to FAIL. A mutant
// that survives means a guard nobody is testing. Run: node test/mutate.js

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Each target runs only the tests that cover it: never redo work (QUALITY.md §0).
// No test file drives another target's script, so the targets run side by side,
// one lane each; within a lane, one mutant at a time.
const TARGETS = {
  'scripts/push-gate.js': 'test/push-gate.test.js',
  'scripts/design-check.js': 'test/design-check.test.js',
  'scripts/rls-check.js': 'test/rls-check.test.js',
  'scripts/mutate.js': 'test/mutate-runner.test.js',
  'scripts/run-timed.js': 'test/mutate-runner.test.js',
  'scripts/test-counts.js': 'test/test-counts.test.js',
};

const PUSH_GATE = [
  {
    name: 'cache a result before the gates run (failure remembered as pass)',
    find: '  for (const gate of gates) {',
    replace: '  if (cacheFile) { cache[cacheKey] = 1; fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); }\n  for (const gate of gates) {',
  },
  { name: 'drop the dirty-tree check', find: 'if (dirty && !config.allowDirty) {', replace: 'if (false) {' },
  { name: 'drop config hash from cache key', find: '`${root}::${sha}::${configHash}`', replace: '`${root}::${sha}`' },
  { name: 'hash the whole config (roles edits re-run every gate)', find: '.update(JSON.stringify(gates))', replace: '.update(JSON.stringify(config))' },
  { name: 'drop sha from cache key', find: '`${root}::${sha}::${configHash}`', replace: '`${root}::${configHash}`' },
  { name: 'treat any exit code as pass', find: 'if (r.status !== 0) {', replace: 'if (false) {' },
  { name: 'check only the first gate', find: 'for (const gate of gates) {', replace: 'for (const gate of gates.slice(0, 1)) {' },
  { name: 'fail open on internal error', find: 'Push blocked (fail closed).\\n`);\n    process.exit(2);', replace: 'Push blocked (fail closed).\\n`);\n    process.exit(0);' },
  { name: 'fail open on bad input', find: 'Push blocked.\\n`);\n    process.exit(2);\n  }\n  const command', replace: 'Push blocked.\\n`);\n    process.exit(0);\n  }\n  const command' },
  { name: 'ignore pushes chained after &&', find: "cmd.split(/\\|\\||&&|[;|\\n]/)", replace: "cmd.split(/[;\\n]/)" },
  { name: 'ignore git -C', find: "if (flag === '-C') {", replace: "if (false) {" },
  { name: 'treat --dry-run as a real push', find: "if (rest.includes('--dry-run') || ", replace: "if (" },
  { name: 'a pass leaves no receipt', find: '    fs.renameSync(`${receiptFile}.tmp`, receiptFile);', replace: '' },
  { name: 'a cached pass needs no receipt', find: 'if (cache[cacheKey] && receiptVouches(receiptFile, sha, configHash))', replace: 'if (cache[cacheKey])' },
  { name: "another config's receipt vouches", find: ' && r.config === configHash', replace: '' },
  { name: 'the receipt never says dirty', find: 'dirty: Boolean(dirty),', replace: 'dirty: false,' },
  { name: 'an interrupted mutation run is not blocked', find: 'if (fs.existsSync(path.join(root, MUTATE_BACKUP))) {', replace: 'if (false) {' },
  { name: 'a gate with nothing to run is not refused', find: 'const unrunnable = gates.find((g) => !gateCommand(g));', replace: 'const unrunnable = null;' },
  { name: 'minTests is ignored', find: 'if (gate.minTests !== undefined && counts.passed < gate.minTests) {', replace: 'if (false) {' },
  { name: 'maxSkipped is ignored', find: 'if (gate.maxSkipped !== undefined && counts.skipped > gate.maxSkipped) {', replace: 'if (false) {' },
  { name: 'no summary counts as a pass', find: "      if (!counts) {\n        return { allow: false, reason: `QA AI OS push gate: \"${name}\" exited 0", replace: "      if (!counts) { return { allow: true };\n        return { allow: false, reason: `QA AI OS push gate: \"${name}\" exited 0" },
  { name: 'a bad limit is accepted', find: 'const isCount = (v) => v === undefined || (Number.isInteger(v) && v >= 0);', replace: 'const isCount = () => true;' },
  { name: 'counts never reach the receipt', find: '...(counts ? { tests: counts } : {}), ', replace: '' },
  { name: 'a receipt that cannot be written still allows the push', find: '  } catch (err) {\n    return {\n      allow: false,', replace: '  } catch (err) {\n    return { allow: true };\n    return {\n      allow: false,' },
];

const DESIGN = [
  { name: 'a ratio below the minimum passes', find: 'if (ratio + 1e-9 < min)', replace: 'if (false)' },
  { name: 'check only the first mode (dark never checked)', find: 'for (const mode of p.modes || Object.keys(modes))', replace: 'for (const mode of p.modes || Object.keys(modes).slice(0, 1))' },
  { name: 'ignore opacity on text', find: 'const alpha = tc.a * (p.alpha ?? 1);', replace: 'const alpha = 1;' },
  { name: 'could-not-check counts as pass', find: 'if (errors.length) return 2;', replace: 'if (false) return 2;' },
  { name: 'a config that checks nothing passes', find: 'if (c.checked + b.checked === 0 && !errors.length) {', replace: 'if (false) {' },
  { name: 'design-allow without a reason is accepted', find: 'if (/\\w{2,}/.test(reason))', replace: 'if (m)' },
  { name: 'earlier mode blocks override later ones', find: '|| x.specIdx - y.specIdx', replace: '|| y.specIdx - x.specIdx' },
  { name: 'check gitignored files too', find: "['ls-files', '-co', '--exclude-standard']", replace: "['ls-files', '-co']" },
  { name: 'accept a translucent ground', find: 'if (gc.a < 1) {', replace: 'if (false) {' },
  { name: '@layer becomes a nesting level', find: 'path: lm ? parent.path : [...parent.path, prelude]', replace: 'path: [...parent.path, prelude]' },
  { name: 'layers ignored: source order only', find: 'compareRank(x.rank, y.rank) || ', replace: '' },
  { name: 'unlayered ranks below layers', find: 'rank.push(Infinity);', replace: 'rank.push(-1);' },
  { name: '"@layer a, b;" statements ignored', find: 'if (stmt) for', replace: 'if (false) for' },
  { name: 'anonymous layer ids restart per file', find: '`\\0anon${layers.anon = (layers.anon || 0) + 1}`', replace: '`\\0anon0`' },
  { name: '!important accepted silently', find: 'if (b.important[k]) throw', replace: 'if (false) throw' },
  { name: 'empty per-pair modes skipped silently', find: '(!Array.isArray(p.modes) || !p.modes.length)', replace: '(!Array.isArray(p.modes))' },
  { name: 'g/y flags kept on banned patterns', find: ".replace(/[gy]/g, '')", replace: '' },
  { name: 'banned paths that match nothing pass silently', find: 'if (!targets.length) { errors.push', replace: 'if (!targets.length) { continue; errors.push' },
];

// Every rls-check run needs a Postgres cluster, so each mutant runs only the
// tests named by `only` (a --test-name-pattern), not the whole file.
const RLS = [
  { name: 'RLS off is not reported', find: 'if (!rel.rls) {\n', replace: 'if (false) {\n', only: 'rls-off' },
  { name: 'column-level grants are missed', find: "has_any_column_privilege('${r}', c.oid, 'SELECT')", replace: "has_table_privilege('${r}', c.oid, 'SELECT')", only: 'column-level' },
  { name: 'a policy that never reads the row is fine', find: "return readsTargetRow(tree) ? 'ok' : 'open';", replace: "return 'ok';", only: 'open-policy' },
  { name: 'an INSERT check that never reads the row is fine', find: "if (cmd === 'insert' || cmd === 'update') out.push('check');", replace: "if (cmd === 'update') out.push('check');", only: 'WITH CHECK' },
  { name: 'UPDATE judged on WITH CHECK alone', find: "if (cmd === 'select' || cmd === 'delete' || cmd === 'update') out.push('using');", replace: "if (cmd === 'select' || cmd === 'delete') out.push('using');", only: 'UPDATE USING' },
  { name: 'a restrictive policy guarding one clause guards them all', find: 'clauses.every((c) =>', replace: 'clauses.some((c) =>', only: 'restrictive' },
  { name: 'restrictive policies must guard every clause on their own', find: "!clausesIn(g, cmd, ['open']).includes(c)", replace: "!clausesIn(g, cmd, ['open']).length", only: 'restrictive' },
  { name: 'a never-true clause counts as open', find: "return s === 'false' || SERVICE_ONLY.test(s);", replace: 'return false;', only: 'never true' },
  { name: 'claim name matched case-insensitively', find: '${SERVICE}\\s*=\\s*${ROLE_OF})$`);', replace: '${SERVICE}\\s*=\\s*${ROLE_OF})$`, \'i\');', only: 'ROLE claim' },
  { name: 'service-role-only clauses count as open', find: "return s === 'false' || SERVICE_ONLY.test(s);", replace: "return s === 'false';", only: 'service_role' },
  { name: 'reversed service-role check counts as open', find: '|${SERVICE}\\s*=\\s*${ROLE_OF})$', replace: ')$', only: 'reversed' },
  { name: 'wrapping parentheses kept', find: "while (s.startsWith('(') && s.endsWith(')') && wraps(s))", replace: 'while (false)', only: 'never true' },
  { name: 'string literals count as asking', find: ".replace(/'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"/g, '')", replace: '', only: 'admin wording' },
  { name: 'current_setting does not count as asking', find: " || f === 'pg_catalog.current_setting'", replace: '', only: 'admin wording' },
  { name: 'admin-style checks get the generic message', find: 'asksCaller(clauseText(pol, c), clauseFuncs(pol, c)));', replace: 'false);', only: 'admin-style' },
  { name: 'a subquery\'s own table counts as the row', find: 'Number(up[1]) === depth', replace: 'true', only: 'subquery' },
  { name: 'inherited policy roles ignored', find: "pr = 0 OR pg_has_role('${r}', pr, 'USAGE')", replace: "pr = 0 OR pr = (SELECT oid FROM pg_roles WHERE rolname = '${r}')", only: 'inherits' },
  { name: 'graphql_public dropped from the scan', find: 'schemas = api ? JSON.parse(api) :', replace: "schemas = api ? JSON.parse(api).filter((x) => x !== 'graphql_public') :", only: 'config.toml' },
  { name: 'only the newest migration compared', find: 'migrationsOnDisk(root, s.migrations).filter(', replace: 'migrationsOnDisk(root, s.migrations).slice(-1).filter(', only: 'skipped in the middle' },
  { name: 'restrictive policies ignored', find: 'if (!guarded) open.push', replace: 'if (true) open.push', only: 'restrictive' },
  { name: 'table privilege ignored for open policies', find: " || !(rel.privs[role] && rel.privs[role][cmd])) continue;", replace: ') continue;', only: 'table privilege' },
  { name: 'extension-owned objects are checked', find: "AND d.deptype = 'e')", replace: "AND d.deptype = 'x')", only: 'stock project' },
  { name: 'trigger functions are checked', find: "p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)", replace: 'true', only: 'stock project' },
  { name: 'security_invoker views are reported', find: '&& !rel.invoker', replace: '', only: 'stock project' },
  { name: 'user_metadata policies pass', find: 'if (/user_metadata/.test(text))', replace: 'if (false)', only: 'user-metadata' },
  { name: 'materialized views pass', find: "} else if (has(rel.privs, 'select').length) {", replace: '} else if (false) {', only: 'materialized' },
  { name: 'definer functions pass', find: 'if (who.length) out.push', replace: 'if (false) out.push', only: 'definer-function' },
  { name: 'allow entry without a reason accepted', find: "if (!/\\w{2,}/.test(String((a && a.why) || '')))", replace: 'if (false)', only: 'allow' },
  { name: 'allow entry silences every rule on the object', find: 'a.rule === f.rule && a.object', replace: 'a.object', only: 'allow' },
  { name: 'stale allow entries pass', find: 'if (!used.has(i)) errors.push', replace: 'if (false) errors.push', only: 'allow' },
  { name: 'could-not-check counts as pass', find: 'if (errors.length) return 2;', replace: 'if (false) return 2;', only: 'allow' },
  { name: 'database behind migrations passes', find: '.filter((v) => !applied.has(v))', replace: '.filter(() => false)', only: 'migrations' },
  { name: 'a schema that checks nothing passes', find: 'if (!cat.relations.length && !cat.functions.length) {', replace: 'if (false) {', only: 'nothing in it' },
  { name: 'a missing schema passes', find: 'if (missingSchemas.length)', replace: 'if (false)', only: 'missing schema' },
  { name: 'config.toml [api] schemas ignored', find: 'schemas = api ? JSON.parse(api)', replace: 'schemas = false ? JSON.parse(api)', only: 'config.toml' },
  { name: 'free check: a CSV export is not unescaped', find: `tries.push(body, body.replace(/""/g, '"'));`, replace: 'tries.push(body);', only: 'free check' },
  { name: "free check: an AI tool's wrapper is not unwrapped", find: 'catch { return parsePasted(v, depth + 1); }', replace: 'catch { break; }', only: 'free check' },
  { name: 'free check: a one-key object is not unwrapped', find: "!('catalog' in v) && Object.keys(v).length === 1", replace: 'false', only: 'free check' },
  { name: 'free check: an edited result passes its seal', find: ".digest('hex') !== sealed.md5) {", replace: ".digest('hex') !== sealed.md5 && false) {", only: 'free check' },
  { name: 'free check: an unsealed result is accepted', find: "if (!sealed || typeof sealed.catalog !== 'string' || typeof sealed.md5 !== 'string') {", replace: "if (!sealed || typeof sealed.catalog !== 'string') {", only: 'free check' },
  { name: 'free check: a partial result is checked anyway', find: 'cat = checkShape(unseal(parsePasted(', replace: 'cat = (unseal(parsePasted(', only: 'free check' },
  { name: 'free check: the allow-list is ignored', find: 'const allow = (config && config.rls && config.rls.allow) || [];', replace: 'const allow = [];', only: 'free check' },
  { name: 'free check: --schemas not passed to the query', find: "catalogQuery(schemas || ['public'])", replace: "catalogQuery(['public'])", only: 'free check' },
  { name: 'free check: incomplete entries are checked anyway', find: 'if (bad) throw', replace: 'if (false) throw', only: 'free check' },
  { name: 'free check: one missing privilege passes', find: 'ACT.every((a) => isBool(p[a]))', replace: 'true', only: 'free check' },
  { name: 'free check: a string boolean passes', find: 'rls: isBool,', replace: 'rls: () => true,', only: 'free check' },
  { name: 'free check: an unknown policy command passes', find: 'cmd: (v) => Object.hasOwn(CMDS, v)', replace: 'cmd: () => true', only: 'free check' },
  { name: 'free check: a non-object entry passes', find: "!item || typeof item !== 'object' ? '(not an object)'", replace: "false ? '(not an object)'", only: 'free check' },
  { name: 'free check: a mistyped version passes', find: 'if (!Number.isInteger(cat.version))', replace: 'if (cat.version === undefined)', only: 'free check' },
  { name: 'free check: an unknown relation kind passes', find: "kind: (v) => ['r', 'p', 'v', 'm', 'f'].includes(v)", replace: 'kind: isStr', only: 'free check' },
  { name: 'free check: a policy on a missing table passes', find: 'if (!names.has(pol.table)) throw', replace: 'if (false) throw', only: 'free check' },
  { name: 'free check: a duplicated relation passes', find: 'if (names.has(rel.name)) throw', replace: 'if (false) throw', only: 'free check' },
  { name: 'free check: clause and tree may disagree', find: 'if (!ok) throw', replace: 'if (false) throw', only: 'free check' },
  { name: 'free check: any string is a tree', find: "pol[tree] !== null && pol[tree].startsWith('{')", replace: 'pol[tree] !== null', only: 'free check' },
  { name: 'free check: an unknown argument is ignored', find: 'if (unknown.length) throw', replace: 'if (false) throw', only: 'free check' },
];

const MUTATE = [
  { name: 'skip the baseline', find: "if (status !== 0) {\n      console.log(`Baseline", replace: "if (false) {\n      console.log(`Baseline" },
  { name: 'a find that matches twice is used', find: 'if (n !== 1) {', replace: 'if (n === 0) {' },
  { name: 'a survivor counts as killed', find: "status !== 0 ? 'killed' : 'survived'", replace: "'killed'" },
  { name: 'a timeout counts as a verdict', find: "if (status === 'timeout') results.push", replace: 'if (false) results.push' },
  { name: 'unchecked mutants count as a pass', find: 'return unknown ? 2 : 0;', replace: 'return 0;' },
  { name: 'an interrupted run is not put back', find: 'const restored = recover(root);', replace: 'const restored = [];' },
  { name: 'CRLF files are not handled', find: "const crlf = text.includes('\\r\\n');", replace: 'const crlf = false;' },
  { name: "a mutant's own command is ignored", find: 'const cmdFor = (m) => m.run || cfg.run;', replace: 'const cmdFor = (m) => cfg.run;' },
  { name: 'a mutant that changes nothing is accepted', find: 'if (m.find === m.replace) throw', replace: 'if (false) throw' },
  { name: 'restore by reversing the edit', find: 'fs.writeFileSync(target, original); // from the byte copy', replace: "fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(replace, find)); // from the byte copy" },
];

const COUNTS = [
  { name: 'the first summary wins', find: 'for (const x of text.matchAll(re)) m = x;', replace: 'for (const x of text.matchAll(re)) { m = x; break; }' },
  { name: 'colour codes are kept', find: "String(output || '').replace(ANSI, '')", replace: "String(output || '')" },
  { name: 'failed is not counted', find: "else if (word === 'failed' || word === 'errors' || word === 'error') out.failed += Number(n);", replace: '' },
  { name: 'skipped is not counted', find: "else if (word === 'skipped' || word === 'todo' || word === 'pending' || word === 'xfailed' || word === 'deselected') out.skipped += Number(n);", replace: '' },
  { name: 'vitest reads "Test Files" as tests', find: String.raw`/^\s*Tests\s{2,}(.+?)\s+\(\d+\)\s*$/gm`, replace: String.raw`/^\s*Test(?: Files)?\s{2,}(.+?)\s+\(\d+\)\s*$/gm` },
  { name: '"no test files found" is unknown', find: "return /^No test files found/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;", replace: 'return null;' },
  { name: 'pytest "no tests ran" is unknown', find: String.raw`return /^=*\s*no tests ran in [\d.]+s/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;`, replace: 'return null;' },
  { name: 'mocha pending is not skipped', find: 'skipped: pend ? +pend[1] : 0', replace: 'skipped: 0' },
  { name: 'playwright failures are not counted', find: 'failed: fail ? +fail[1] : 0, skipped: skip ? +skip[1] : 0 };\n  }],\n];', replace: 'failed: 0, skipped: skip ? +skip[1] : 0 };\n  }],\n];' },
  { name: 'node todo is not skipped', find: "skipped: (skip ? +skip[1] : 0) + (todo ? +todo[1] : 0) };\n  }],\n  // node --test (spec)", replace: "skipped: (skip ? +skip[1] : 0) };\n  }],\n  // node --test (spec)" },
];

const MUTANTS = [
  ...PUSH_GATE.map((m) => ({ ...m, file: 'scripts/push-gate.js' })),
  ...DESIGN.map((m) => ({ ...m, file: 'scripts/design-check.js' })),
  ...RLS.map((m) => ({ ...m, file: 'scripts/rls-check.js' })),
  ...MUTATE.map((m) => ({ ...m, file: 'scripts/mutate.js' })),
  ...COUNTS.map((m) => ({ ...m, file: 'scripts/test-counts.js' })),
  { file: 'scripts/run-timed.js', name: 'a timeout kills only the shell', find: "if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });\n    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }", replace: 'child.kill();' },
];

// One Postgres cluster for the whole run (~10 s each to start), shared with every
// test process through QA_PG_PORT. Each test process still makes its own databases.
const { findPgBin, startCluster, stopCluster } = require('./pg-cluster.js');
const PG_BIN = process.env.QA_SKIP_PG === '1' ? null : findPgBin();
const PG = PG_BIN && startCluster(PG_BIN);
const ENV = PG ? { ...process.env, QA_PG_PORT: String(PG.port) } : process.env;
process.on('exit', () => { if (PG) stopCluster(PG_BIN, PG.data); });

const suiteArgs = (glob, only) => ['--test', ...(only ? [`--test-name-pattern=${only}`] : []), glob];
const runSuite = (glob = 'test/*.test.js', only) =>
  spawnSync(process.execPath, suiteArgs(glob, only), { cwd: ROOT, encoding: 'utf8', env: ENV });
const runSuiteAsync = (glob, only) => new Promise((resolve) => {
  const child = spawn(process.execPath, suiteArgs(glob, only), { cwd: ROOT, env: ENV, stdio: 'ignore' });
  child.on('error', () => resolve(null));
  child.on('close', (code) => resolve(code));
});

// A red baseline would report every mutant as "killed". Refuse to run on one.
if (runSuite().status !== 0) {
  console.error('Baseline suite is failing: fix the tests before mutation-checking.');
  process.exit(1);
}

const originals = Object.fromEntries(Object.keys(TARGETS).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const restoreAll = () => { for (const [f, body] of Object.entries(originals)) fs.writeFileSync(path.join(ROOT, f), body); };

// A mutant's suite that couldn't start counts as SURVIVED: unknown is never "killed".
async function runLane(file, results) {
  const target = path.join(ROOT, file);
  const original = originals[file];
  for (const m of MUTANTS.filter((x) => x.file === file)) {
    if (!original.includes(m.find)) { results.set(m, 'missing'); continue; }
    fs.writeFileSync(target, original.replace(m.find, m.replace));
    // A mutation that didn't land is a fake pass; prove it applied.
    if (fs.readFileSync(target, 'utf8') === original) throw new Error(`mutant did not apply: ${m.name}`);
    const code = await runSuiteAsync(TARGETS[file], m.only);
    fs.writeFileSync(target, original); // restore from the byte copy, never by reversing the edit
    results.set(m, code !== null && code !== 0 ? 'killed' : 'survived');
  }
}

async function main() {
  const results = new Map();
  try {
    // allSettled: a lane that throws must not leave the others mutating after the restore.
    const lanes = await Promise.allSettled(Object.keys(TARGETS).map((f) => runLane(f, results)));
    const failed = lanes.find((l) => l.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    restoreAll();
  }
  let survived = 0;
  for (const m of MUTANTS) {
    const r = results.get(m);
    if (r === 'missing') console.log(`?  ${m.name}: pattern not found (update the mutant)`);
    else console.log(`${r === 'killed' ? 'killed  ' : 'SURVIVED'}  ${m.file}: ${m.name}`);
    if (r !== 'killed') survived++;
  }
  return survived;
}

main().then((survived) => {
  for (const [f, body] of Object.entries(originals)) {
    if (fs.readFileSync(path.join(ROOT, f), 'utf8') !== body) {
      console.error(`RESTORE FAILED: ${f} differs from the original.`);
      process.exit(1);
    }
  }
  console.log(survived === 0 ? `
All ${MUTANTS.length} mutants killed.` : `
${survived} of ${MUTANTS.length} mutants survived.`);
  process.exit(survived === 0 ? 0 : 1);
}, (err) => {
  restoreAll();
  console.error(err.stack || err);
  process.exit(1);
});
