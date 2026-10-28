#!/usr/bin/env node
// Mutation check for the plugin's guards (push gate, design, RLS checks): break a
// guard on purpose, one way at a time, and require its tests to FAIL. A mutant
// that survives means a guard nobody is testing. Run: node test/mutate.js

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// A killed run must not leave a script broken on purpose. Each file is backed
// up before it's mutated, and the next run puts it back before reading anything.
// Same folder as the shipped runner, so the push gate refuses to push past it.
// Kept separate from scripts/mutate.js's recover(): that file is a target here.
const BACKUP_DIR = path.join(ROOT, '.qa-ai-os', 'mutate-backup');
function putBack() {
  const restored = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(BACKUP_DIR, p);
      fs.writeFileSync(path.join(ROOT, rel), fs.readFileSync(p));
      restored.push(rel.replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(BACKUP_DIR)) walk(BACKUP_DIR);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  return restored;
}
const putBackAtStart = putBack();
if (putBackAtStart.length) console.log(`An interrupted run left files mutated; put back from the backup: ${putBackAtStart.join(', ')}\n`);

// Each target runs only the tests that cover it: never redo work (QUALITY.md §0).
// A mutant can also name its own `suite`.
const TARGETS = {
  'scripts/push-gate.js': 'test/push-gate.test.js',
  'scripts/design-check.js': 'test/design-check.test.js',
  'scripts/rls-check.js': 'test/rls-check.test.js',
  'scripts/mutate.js': 'test/mutate-runner.test.js',
  'scripts/run-timed.js': 'test/mutate-runner.test.js',
  'scripts/test-counts.js': 'test/test-counts.test.js',
  'scripts/diff-coverage.js': 'test/diff-coverage.test.js',
  'scripts/stack.js': 'test/stack.test.js',
  'stacks/nextjs/files/.github/qa-ai-os/prod-alert.mjs': 'test/prod-alert.test.js',
  // Every suite loads tmp.js, but its only mutant (no cleanup) can't change
  // another suite's verdict, so it gets its own lane.
  'test/tmp.js': 'test/repo-contract.test.js',
};

// Lanes run side by side; within a lane, one mutant at a time. Scripts that load
// each other share a lane: the push gate loads run-timed, test-counts,
// diff-coverage and (as a builtin gate) mutate, so a push-gate mutant tested
// while another lane had run-timed broken would be "killed" by the wrong break.
const LANES = [
  ['scripts/push-gate.js', 'scripts/run-timed.js', 'scripts/test-counts.js', 'scripts/diff-coverage.js', 'scripts/mutate.js'],
  ['scripts/design-check.js'],
  ['scripts/rls-check.js'],
  ['scripts/stack.js'],
  ['stacks/nextjs/files/.github/qa-ai-os/prod-alert.mjs'],
  ['test/tmp.js'],
];
for (const f of Object.keys(TARGETS)) {
  if (LANES.flat().filter((x) => x === f).length !== 1) throw new Error(`${f} must be in exactly one lane`);
}

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
  { name: 'colour codes reach the agent', find: String.raw`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').trimEnd()`, replace: String.raw`.replace(/\r\n/g, '\n').trimEnd()` },
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
  { name: 'node spec todo is not skipped', find: "skipped: (skip ? +skip[1] : 0) + (todo ? +todo[1] : 0) };\n  }],\n  // vitest", replace: "skipped: (skip ? +skip[1] : 0) };\n  }],\n  // vitest" },
];

const DIFF_COVERAGE = [
  { name: 'line numbers stop advancing', find: '        at++; newLeft--;\n        continue;', replace: '        newLeft--;\n        continue;' },
  { name: '"no newline" markers are read as lines', find: "if (body.startsWith('\\\\')) continue;", replace: '' },
  { name: 'quoted paths keep their quotes', find: `if (p.startsWith('"')) {`, replace: 'if (false) {' },
  { name: 'the same file twice: the last record wins', find: 'lines.set(line, Math.max(lines.get(line) || 0, Number(hits) || 0));', replace: 'lines.set(line, Number(hits) || 0);' },
  { name: 'absolute lcov paths never match', find: 'path.isAbsolute(sf) ? path.relative(root, sf) : sf', replace: 'sf' },
  { name: 'backslash lcov paths never match', find: "p.replace(/\\\\/g, '/')", replace: 'p' },
  { name: 'lines lcov does not list count as missed', find: 'if (!hits.has(line)) continue; // not code', replace: 'if (!hits.has(line)) { total++; missed.push(line); continue; }' },
  { name: 'blank lines in a never-loaded file count', find: '} else if (text.trim()) {', replace: '} else {' },
  { name: 'test files count as changes that need tests', find: ' || TEST_FILES.some((re) => re.test(file))) continue;', replace: ') continue;' },
  { name: '"exclude" is ignored', find: ' || under(key, exclude) ||', replace: ' ||' },
  { name: '"include" is ignored', find: 'if (!under(key, include) ||', replace: 'if (' },
  { name: 'a never-loaded file is skipped', find: '      } else if (text.trim()) {\n        total++;\n        missed.push(line);\n      }', replace: '      }' },
  { name: 'no base: everything passes', find: "if (!base) {\n    return { error:", replace: "if (!base) {\n    return { base: 'none', covered: 0, total: 0, percent: 100, files: [] };\n    return { error:" },
  { name: 'a missing coverage file counts as empty', find: "try { lcov = parseLcov(fs.readFileSync(lcovFile, 'utf8'), root); } catch {", replace: "try { lcov = parseLcov(fs.readFileSync(lcovFile, 'utf8'), root); } catch { lcov = new Map(); } if (false) {" },
];

const COVERAGE_GATE = [
  { name: 'an old coverage file is kept', find: 'try { fs.rmSync(path.resolve(root, gate.changedLines.lcov), { force: true }); }', replace: 'try { }' },
  { name: 'the bar is "any line ran"', find: 'if (cov.covered * 100 < min * cov.total) {', replace: 'if (cov.total > 0 && cov.covered === 0) {' },
  { name: '"min" defaults to 0', find: 'gate.changedLines.min === undefined ? 100', replace: 'gate.changedLines.min === undefined ? 0' },
  { name: 'unknown coverage is a pass', find: '      if (cov.error) {\n        return { allow: false,', replace: '      if (cov.error) {\n        return { allow: true };\n        return { allow: false,' },
  { name: 'uncommitted changes are not measured', find: '{ worktree: Boolean(dirty) }', replace: '{}' },
  { name: 'coverage never reaches the receipt', find: 'ran[ran.length - 1].changedLines = ', replace: 'void ' },
  { name: 'a malformed "changedLines" is accepted', find: "const badCoverage = gates.find((g) => g && g.changedLines !== undefined && !validChangedLines(g.changedLines));", replace: 'const badCoverage = null;' },
  { name: '"min" out of range is accepted', find: " && s.min >= 0 && s.min <= 100))", replace: '))' },
];

const STACK = [
  { name: 'an existing file is overwritten', find: 'for (const f of layer.files) (fs.existsSync(path.join(dir, f)) ? out.files.keep : out.files.add).push(f);', replace: 'for (const f of layer.files) out.files.add.push(f);' },
  { name: 'an existing script is overwritten', find: 'if (scripts[s] === undefined) out.scripts.add[s] = cmd;', replace: 'out.scripts.add[s] = cmd; if (false) {}' },
  { name: 'a different script command is not reported', find: "else if (scripts[s] !== cmd) out.scripts.keep.push({ name: s, yours: scripts[s], ours: cmd });", replace: '' },
  { name: 'a layer you already use is replaced', find: "if (have) { out.layers[name] = `keep: ${have}`; continue; }", replace: '' },
  { name: 'installed packages are installed again', find: '.filter(([d]) => !deps[d])', replace: '' },
  { name: 'pnpm is ignored', find: "if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml')))", replace: 'if (false)' },
  { name: '.gitignore entries are duplicated', find: 'if (!ignore.includes(line)) out.gitignore.push(line);', replace: 'out.gitignore.push(line);' },
  { name: '.gitignore glued to the last line', find: "const sep = before && !before.endsWith('\\n') ? '\\n' : '';", replace: "const sep = '';" },
  { name: 'CRLF package.json becomes LF', find: "const nl = raw.includes('\\r\\n') ? '\\r\\n' : '\\n';", replace: "const nl = '\\n';" },
  { name: 'indentation is reset', find: "const indent = (/^\\{\\r?\\n([ \\t]+)\"/.exec(raw) || [, '  '])[1];", replace: "const indent = '  ';" },
  { name: 'the coverage list is never filled in', find: "text = text.replace('__COVERAGE_INCLUDE__',", replace: "text = text.replace('__NOTHING__'," },
  { name: 'changedLines with no source folders', find: '...(dirs.length ? { changedLines:', replace: '...(true ? { changedLines:' },
  { name: 'a Node version at the floor is too old', find: '  return true;\n}\n\n// The source folders', replace: '  return false;\n}\n\n// The source folders' },
  { name: 'the production check without our e2e layer', find: "if (layer.requires && out.layers[layer.requires] !== 'add') {", replace: 'if (false) {' },
  { name: 'a non-Next app gets the stack', find: "if (!deps[stack.detect]) return", replace: 'if (false) return' },
];

const PROD_ALERT = [
  { name: 'every failure opens a new issue', find: "  if (issue) {\n    gh('issue', 'comment', issue, '--body', `Still failing", replace: "  if (false) {\n    gh('issue', 'comment', issue, '--body', `Still failing" },
  { name: 'recovery never closes the issue', find: "  gh('issue', 'close', issue);\n", replace: '' },
  { name: 'any open issue counts, label or not', find: "'issue', 'list', '--label', LABEL, '--state', 'open'", replace: "'issue', 'list', '--state', 'open'" },
  { name: 'GitHub refusing is ignored', find: "    process.exit(1);\n  }\n  return r.stdout.trim();", replace: "  }\n  return r.stdout.trim();" },
  { name: 'an unknown result counts as passing', find: "if (result !== 'success' && result !== 'failure') {", replace: 'if (false) {' },
  { name: 'a missing URL reads like a failed page', find: "const what = url ? `The smoke test against ${url} failed.` :", replace: 'const what = true ? `The smoke test against ${url} failed.` :' },
  { name: 'the issue has no run link', find: '\\nRun (trace, screenshots, video): ${run}', replace: '' },
];

const MUTANTS = [
  { file: 'test/tmp.js', name: 'temp folders are never deleted', find: '  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });\n', replace: '' },
  ...PROD_ALERT.map((m) => ({ ...m, file: 'stacks/nextjs/files/.github/qa-ai-os/prod-alert.mjs' })),
  ...STACK.map((m) => ({ ...m, file: 'scripts/stack.js' })),
  ...PUSH_GATE.map((m) => ({ ...m, file: 'scripts/push-gate.js' })),
  ...DESIGN.map((m) => ({ ...m, file: 'scripts/design-check.js' })),
  ...RLS.map((m) => ({ ...m, file: 'scripts/rls-check.js' })),
  ...MUTATE.map((m) => ({ ...m, file: 'scripts/mutate.js' })),
  ...COUNTS.map((m) => ({ ...m, file: 'scripts/test-counts.js' })),
  ...DIFF_COVERAGE.map((m) => ({ ...m, file: 'scripts/diff-coverage.js' })),
  ...COVERAGE_GATE.map((m) => ({ ...m, file: 'scripts/push-gate.js', suite: 'test/diff-coverage.test.js' })),
  { file: 'scripts/run-timed.js', name: 'a timeout kills only the shell', find: "if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });\n    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }", replace: 'child.kill();' },
];

// While developing: QA_MUTATE_ONLY=scripts/stack.js checks one file's mutants.
// The result line says so, so a partial run never reads as the full check.
const ONLY = process.env.QA_MUTATE_ONLY;
const suiteOf = (m) => m.suite || TARGETS[m.file];
let scope = null; // null = every mutant
if (ONLY) {
  if (!TARGETS[ONLY]) throw new Error(`QA_MUTATE_ONLY: ${ONLY} is not a target`);
  MUTANTS.splice(0, MUTANTS.length, ...MUTANTS.filter((m) => m.file === ONLY));
  scope = `${ONLY} only`;
}

// --changed (this repo's push gate): only the mutants that break a line this
// branch changed since origin/main, plus mutants that are new or edited. Picking
// by whole file ran 33 mutants in 10 minutes for a 3-line change; by line, a
// push gets its mutation check in about a minute. CI still runs every mutant.
// No origin/main to compare with: check them all (unknown never narrows).
if (process.argv.includes('--changed')) {
  const { addedLines } = require('../scripts/diff-coverage.js');
  const base = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const diff = base.status === 0 ? spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', base.stdout.trim()], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : null;
  if (!diff || diff.status !== 0) {
    console.log('--changed: no origin/main to compare with, so checking every mutant.');
  } else {
    const added = addedLines(diff.stdout);
    const touched = (file, from, to) => (added.get(file) || []).some(({ line }) => line >= from && line <= to);
    const lineOf = (text, index) => text.slice(0, index).split('\n').length;
    const self = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n');
    const sources = {};
    const picked = MUTANTS.filter((m) => {
      const src = (sources[m.file] ??= fs.readFileSync(path.join(ROOT, m.file), 'utf8').replace(/\r\n/g, '\n'));
      const at = src.indexOf(m.find);
      if (at < 0) return true; // a mutant that no longer applies must be reported, never dropped
      const from = lineOf(src, at);
      if (touched(m.file, from, from + m.find.split('\n').length - 1)) return true;
      const decl = self.indexOf(m.name); // a new or edited mutant
      return decl >= 0 && touched('test/mutate.js', lineOf(self, decl), lineOf(self, decl));
    });
    MUTANTS.splice(0, MUTANTS.length, ...picked);
    scope = 'lines changed since origin/main';
    if (MUTANTS.length === 0) {
      console.log('No mutant breaks a line this branch changed (CI runs them all).');
      process.exit(0);
    }
    console.log(`Checking ${MUTANTS.length} mutants on changed lines:\n${MUTANTS.map((m) => `  ${m.file}: ${m.name}`).join('\n')}\n`);
  }
}
const SUITES = [...new Set(MUTANTS.map(suiteOf))];

// One Postgres cluster for the whole run (~10 s each to start), shared with every
// test process through QA_PG_PORT. Each test process still makes its own databases.
// A narrowed run with no RLS mutants doesn't need one.
const { findPgBin, startCluster, stopCluster } = require('./pg-cluster.js');
const needPg = !scope || SUITES.includes(TARGETS['scripts/rls-check.js']);
const PG_BIN = process.env.QA_SKIP_PG === '1' || !needPg ? null : findPgBin();
const PG = PG_BIN && startCluster(PG_BIN);
const ENV = PG ? { ...process.env, QA_PG_PORT: String(PG.port) } : process.env;
process.on('exit', () => { if (PG) stopCluster(PG_BIN, PG.data); });

const suiteArgs = (glob, only) => ['--test', ...(only ? [`--test-name-pattern=${only}`] : []), glob];
// Baseline: every suite, or (narrowed) just the suites the chosen mutants run.
const runSuite = () => spawnSync(process.execPath, ['--test', ...(scope ? SUITES : ['test/*.test.js'])],
  { cwd: ROOT, encoding: 'utf8', env: ENV });
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
const restoreAll = () => {
  for (const [f, body] of Object.entries(originals)) fs.writeFileSync(path.join(ROOT, f), body);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); // every file is its original again
};

// A mutant's suite that couldn't start counts as SURVIVED: unknown is never "killed".
async function runLane(files, results) {
  for (const file of files) {
    const target = path.join(ROOT, file);
    const original = originals[file];
    for (const m of MUTANTS.filter((x) => x.file === file)) {
      if (!original.includes(m.find)) { results.set(m, 'missing'); continue; }
      const backup = path.join(BACKUP_DIR, file);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, original); // before the file is broken, never after
      fs.writeFileSync(target, original.replace(m.find, m.replace));
      // A mutation that didn't land is a fake pass; prove it applied.
      if (fs.readFileSync(target, 'utf8') === original) throw new Error(`mutant did not apply: ${m.name}`);
      const code = await runSuiteAsync(m.suite || TARGETS[file], m.only);
      fs.writeFileSync(target, original); // restore from the byte copy, never by reversing the edit
      fs.rmSync(backup);
      results.set(m, code !== null && code !== 0 ? 'killed' : 'survived');
    }
  }
}

async function main() {
  const results = new Map();
  try {
    // allSettled: a lane that throws must not leave the others mutating after the restore.
    const lanes = await Promise.allSettled(LANES.map((files) => runLane(files, results)));
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
All ${MUTANTS.length} mutants killed${scope ? ` (${scope}; not the full check, CI runs that)` : ''}.` : `
${survived} of ${MUTANTS.length} mutants survived${scope ? ` (${scope})` : ''}.`);
  process.exit(survived === 0 ? 0 : 1);
}, (err) => {
  restoreAll();
  console.error(err.stack || err);
  process.exit(1);
});
