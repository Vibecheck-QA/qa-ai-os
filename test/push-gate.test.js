'use strict';

// Behavior tests: they drive the real hook script through stdin, the same way
// Claude Code calls it, against real throwaway git repos.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectPush } = require('../scripts/push-gate.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'push-gate.js');

function makeRepo(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  if (config) fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify(config));
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { dir, g };
}

function runHook(command, cwd, dataDir) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
  return spawnSync('node', [SCRIPT], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
}

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-data-'));
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom: 3 tests failed\'); process.exit(1)"';
// Appends to runs.txt each time it runs, so tests can count executions.
const COUNT = 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\')"';

test('detectPush: recognizes real pushes', () => {
  for (const cmd of [
    'git push',
    'git push origin main',
    'git -C ../other push',
    'git -c core.x=1 push',
    'GIT_TRACE=1 git push',
    'npm test && git push',
    'npm run test:ci 2>&1 | grep FAIL && git add . && git commit -m x && git push', // bug #4
  ]) {
    assert.strictEqual(detectPush(cmd).push, true, cmd);
  }
});

test('detectPush: ignores non-pushes', () => {
  for (const cmd of ['git status', 'git pull', 'echo git push', 'git push --dry-run', 'git push --help', 'gh pr create', '']) {
    assert.strictEqual(detectPush(cmd).push, false, cmd);
  }
});

test('detectPush: reads -C directory', () => {
  assert.strictEqual(detectPush('git -C "../other" push').dir, '../other');
});

test('no config: push is allowed (repos opt in)', () => {
  const { dir } = makeRepo(null);
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
});

test('non-push commands are always allowed, even outside a repo', () => {
  assert.strictEqual(runHook('ls -la', os.tmpdir(), dataDir()).status, 0);
});

test('passing gates: push allowed', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: PASS }] });
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
});

test('failing gate: push blocked with gate name and output tail', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: FAIL }] });
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"tests" failed \(exit 1\)/);
  assert.match(r.stderr, /boom: 3 tests failed/);
});

test('colour codes are stripped from the output the agent sees', () => {
  const { dir } = makeRepo({ gates: [{ name: 'types', run: 'node color.js' }] });
  fs.writeFileSync(path.join(dir, 'color.js'), "console.log('\\x1b[96mlib/price.ts\\x1b[0m:\\x1b[93m4\\x1b[0m - \\x1b[91merror\\x1b[0m TS2322'); process.exit(1);\n");
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /lib\/price\.ts:4 - error TS2322/);
  assert.ok(!r.stderr.includes('\x1b'), 'no escape codes');
});

test('bug #4: a chained "tests | grep && push" is still blocked when tests fail', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: FAIL }] });
  const r = runHook('npm test 2>&1 | grep FAIL && git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
});

test('second gate fails after first passes: blocked', () => {
  const { dir } = makeRepo({ gates: [{ name: 'types', run: PASS }, { name: 'tests', run: FAIL }] });
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"tests" failed/);
});

test('a pass is cached for the same commit: gates do not re-run', () => {
  const { dir } = makeRepo({ gates: [{ name: 'count', run: COUNT }] });
  const data = dataDir();
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'x');
});

test('a new commit invalidates the cached pass', () => {
  const { dir, g } = makeRepo({ gates: [{ name: 'count', run: COUNT }] });
  const data = dataDir();
  runHook('git push', dir, data);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  g('commit', '-q', '-am', 'second');
  runHook('git push', dir, data);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'xx');
});

const receiptOf = (dir, g) => {
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  return { sha, file: path.join(dir, '.qa-ai-os', 'receipts', `${sha}.json`) };
};

test('a pass leaves a receipt: the commit, each command, its exit code and output', () => {
  const tests = 'node -e "console.log(\'# pass 12\')"';
  const { dir, g } = makeRepo({ gates: [{ name: 'tests', run: tests }, { name: 'types', run: PASS }] });
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
  const { sha, file } = receiptOf(dir, g);
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.commit, sha);
  assert.strictEqual(r.dirty, false);
  assert.deepStrictEqual(r.gates.map((x) => [x.name, x.run, x.exit]), [['tests', tests, 0], ['types', PASS, 0]]);
  assert.match(r.gates[0].output, /# pass 12/);
  assert.ok(Number.isFinite(r.gates[0].ms));
});

test('a blocked push leaves no receipt', () => {
  const { dir, g } = makeRepo({ gates: [{ name: 'tests', run: FAIL }] });
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 2);
  assert.strictEqual(fs.existsSync(receiptOf(dir, g).file), false);
});

test('a cached pass needs its receipt: delete it and the gates re-run', () => {
  const { dir, g } = makeRepo({ gates: [{ name: 'count', run: COUNT }] });
  const data = dataDir();
  runHook('git push', dir, data);
  const { file } = receiptOf(dir, g);
  fs.rmSync(file);
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'xx');
  assert.ok(fs.existsSync(file), 'the re-run writes the receipt again');
});

test('a receipt from another gate config does not vouch for this one', () => {
  // A passes, B passes (its receipt replaces A's), back to A: A's cached pass
  // must not lean on B's receipt, so the gates re-run.
  const a = { allowDirty: true, gates: [{ name: 'count', run: COUNT }] };
  const b = { allowDirty: true, gates: [{ name: 'count', run: COUNT }, { name: 'tests', run: PASS }] };
  const { dir } = makeRepo(a);
  const data = dataDir();
  const cfg = path.join(dir, '.qa-ai-os.json');
  runHook('git push', dir, data);
  fs.writeFileSync(cfg, JSON.stringify(b));
  runHook('git push', dir, data);
  fs.writeFileSync(cfg, JSON.stringify(a));
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'xxx');
});

test('a hand-written receipt is not a pass: the gates still run', () => {
  // An agent could write a receipt file itself. Only a pass the gate recorded
  // (its cache, outside the repo) plus a matching receipt skips the gates.
  const forge = (dir, gates) => {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const config = require('crypto').createHash('sha256').update(JSON.stringify(gates)).digest('hex').slice(0, 12);
    fs.mkdirSync(path.join(dir, '.qa-ai-os', 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.qa-ai-os', 'receipts', `${sha}.json`), JSON.stringify({ result: 'pass', commit: sha, config }));
  };

  // A failed push, then a forged receipt for that commit: still blocked.
  const failing = [{ name: 'tests', run: FAIL }];
  const f = makeRepo({ gates: failing });
  const fData = dataDir();
  assert.strictEqual(runHook('git push', f.dir, fData).status, 2);
  forge(f.dir, failing);
  assert.strictEqual(runHook('git push', f.dir, fData).status, 2, 'failed commit');

  // A pass on one commit, a forged receipt for the next: the gates run.
  const counting = [{ name: 'count', run: COUNT }];
  const c = makeRepo({ gates: counting });
  const cData = dataDir();
  runHook('git push', c.dir, cData);
  fs.writeFileSync(path.join(c.dir, 'a.txt'), 'two\n');
  c.g('commit', '-q', '-am', 'second');
  forge(c.dir, counting);
  runHook('git push', c.dir, cData);
  assert.strictEqual(fs.readFileSync(path.join(c.dir, 'runs.txt'), 'utf8'), 'xx', 'new commit');

  // A pass under one config, a forged receipt for a new config: the gates run.
  const other = [{ name: 'count', run: COUNT }, { name: 'tests', run: PASS }];
  const k = makeRepo({ allowDirty: true, gates: counting });
  const kData = dataDir();
  runHook('git push', k.dir, kData);
  fs.writeFileSync(path.join(k.dir, '.qa-ai-os.json'), JSON.stringify({ allowDirty: true, gates: other }));
  forge(k.dir, other);
  runHook('git push', k.dir, kData);
  assert.strictEqual(fs.readFileSync(path.join(k.dir, 'runs.txt'), 'utf8'), 'xx', 'new config');
});

test('a pass whose receipt cannot be written blocks the push', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: PASS }] });
  fs.mkdirSync(path.join(dir, '.qa-ai-os'));
  fs.writeFileSync(path.join(dir, '.qa-ai-os', 'receipts'), 'a file where the folder should be'); // untracked
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /receipt could not be written/);
});

// A committed project with a function, its test and a mutants list.
function mutateRepo(mutants) {
  const repo = makeRepo({ gates: [{ name: 'mutation', builtin: 'mutate' }] });
  fs.writeFileSync(path.join(repo.dir, 'calc.js'), 'module.exports.add = (a, b) => a + b;\nmodule.exports.untested = () => 1;\n');
  fs.writeFileSync(path.join(repo.dir, 'test.js'), "require('assert').strictEqual(require('./calc.js').add(2, 3), 5);\n");
  fs.mkdirSync(path.join(repo.dir, '.qa-ai-os'));
  fs.writeFileSync(path.join(repo.dir, '.qa-ai-os', 'mutants.json'), JSON.stringify({ run: 'node test.js', mutants }));
  repo.g('add', '-A');
  repo.g('commit', '-q', '-m', 'project');
  return repo;
}
const ADD = { name: 'add subtracts', file: 'calc.js', find: 'a + b', replace: 'a - b' };

test('builtin mutate gate: every mutant killed lets the push through, with a receipt', () => {
  const { dir, g } = mutateRepo([ADD]);
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 0, r.stderr);
  const receipt = JSON.parse(fs.readFileSync(receiptOf(dir, g).file, 'utf8'));
  assert.strictEqual(receipt.gates[0].run, 'builtin:mutate');
  assert.match(receipt.gates[0].output, /1 of 1 mutants killed/);
});

test('builtin mutate gate: a surviving mutant blocks the push and is named', () => {
  const { dir } = mutateRepo([ADD, { name: 'untested returns 2', file: 'calc.js', find: '=> 1', replace: '=> 2' }]);
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"mutation" failed/);
  assert.match(r.stderr, /SURVIVED +untested returns 2/);
});

test('a gate with no command or an unknown builtin blocks the push', () => {
  for (const gate of [{ name: 'x', builtin: 'nope' }, { name: 'y' }]) {
    const { dir } = makeRepo({ gates: [gate] });
    const r = runHook('git push', dir, dataDir());
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no "run" command or a known "builtin"/);
  }
});

test('a gate that hangs is killed with everything it started, and the push is blocked', () => {
  const hang = 'node -e "require(\'fs\').writeFileSync(\'hang.pid\', String(process.pid)); for (;;) {}"';
  const { dir } = makeRepo({ gates: [{ name: 'hangs', run: hang, timeoutSeconds: 2 }] });
  const r = runHook('git push', dir, dataDir());
  const pid = Number(fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /"hangs" timed out/);
    assert.strictEqual(alive(), false, 'the hung gate must not be left running');
  } finally {
    if (alive()) process.kill(pid);
  }
});

// A gate that prints a node:test-style summary and exits 0.
const summary = (pass, skipped) => `node -e "console.log('# tests ${pass + skipped}\\n# pass ${pass}\\n# fail 0\\n# skipped ${skipped}')"`;

test('minTests: a gate that exits 0 with too few passing tests blocks the push', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: summary(0, 0), minTests: 1 }] });
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /only 0 passing tests \(minimum 1\)/);
});

test('minTests met: allowed, and the receipt records the counts', () => {
  const { dir, g } = makeRepo({ gates: [{ name: 'tests', run: summary(5, 0), minTests: 5 }] });
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
  const receipt = JSON.parse(fs.readFileSync(receiptOf(dir, g).file, 'utf8'));
  assert.deepStrictEqual(receipt.gates[0].tests, { runner: 'node', passed: 5, failed: 0, skipped: 0 });
});

test('maxSkipped: more skipped tests than allowed blocks the push', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: summary(5, 2), maxSkipped: 1 }] });
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /skipped 2 tests \(allowed 1\)/);
  const ok = makeRepo({ gates: [{ name: 'tests', run: summary(5, 1), maxSkipped: 1 }] });
  assert.strictEqual(runHook('git push', ok.dir, dataDir()).status, 0);
});

test('a limit with no readable test summary blocks: unknown is never a pass', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: PASS, minTests: 1 }] });
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no test summary/);
});

test('no limits: a gate without a summary still passes, and its receipt has no counts', () => {
  const { dir, g } = makeRepo({ gates: [{ name: 'types', run: PASS }] });
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
  const receipt = JSON.parse(fs.readFileSync(receiptOf(dir, g).file, 'utf8'));
  assert.strictEqual('tests' in receipt.gates[0], false);
});

test('a limit that is not a whole number of 0 or more blocks the push', () => {
  for (const bad of [{ minTests: -1 }, { minTests: 1.5 }, { maxSkipped: '0' }]) {
    const { dir } = makeRepo({ gates: [{ name: 'tests', run: summary(5, 0), ...bad }] });
    const r = runHook('git push', dir, dataDir());
    assert.strictEqual(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /must be whole numbers/);
  }
});

test('an interrupted mutation run blocks the push until it is put back', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: PASS }] });
  fs.mkdirSync(path.join(dir, '.qa-ai-os', 'mutate-backup'), { recursive: true }); // untracked
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /mutation run was interrupted/);
});

test('rejection path: a failure is NOT cached, so the next push re-runs the gate', () => {
  const marker = 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\'); process.exit(require(\'fs\').existsSync(\'ok\') ? 0 : 1)"';
  const { dir } = makeRepo({ gates: [{ name: 'flaky', run: marker }] });
  const data = dataDir();
  assert.strictEqual(runHook('git push', dir, data).status, 2);
  fs.writeFileSync(path.join(dir, 'ok'), ''); // untracked: tree stays clean
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'xx');
});

test('changing the gate config invalidates the cached pass (same commit)', () => {
  // Same sha on purpose: only the gate config changes, so this isolates the
  // config part of the cache key. (allowDirty lets the edited config sit
  // uncommitted.)
  const { dir } = makeRepo({ allowDirty: true, gates: [{ name: 'tests', run: PASS }] });
  const data = dataDir();
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ allowDirty: true, gates: [{ name: 'tests', run: FAIL }] }));
  assert.strictEqual(runHook('git push', dir, data).status, 2);
});

test('economics: changing roles (not gates) keeps the cached pass, so gates do not re-run', () => {
  const gates = [{ name: 'count', run: COUNT }];
  const { dir } = makeRepo({ allowDirty: true, gates, roles: { reviewer: { tool: 'codex' } } });
  const data = dataDir();
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  fs.writeFileSync(path.join(dir, '.qa-ai-os.json'), JSON.stringify({ allowDirty: true, gates, roles: { reviewer: { tool: 'fresh-session' } } }));
  assert.strictEqual(runHook('git push', dir, data).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'x');
});

test('uncommitted tracked changes block the push', () => {
  const { dir } = makeRepo({ gates: [{ name: 'tests', run: PASS }] });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  const r = runHook('git push', dir, dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /uncommitted changes/);
});

test('allowDirty skips the dirty-tree check', () => {
  const { dir } = makeRepo({ allowDirty: true, gates: [{ name: 'tests', run: PASS }] });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  assert.strictEqual(runHook('git push', dir, dataDir()).status, 0);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const r = JSON.parse(fs.readFileSync(path.join(dir, '.qa-ai-os', 'receipts', `${sha}.json`), 'utf8'));
  assert.strictEqual(r.dirty, true, 'the receipt says the gates ran on more than the commit');
});

test('git -C targets the other repo\'s config', () => {
  const blocked = makeRepo({ gates: [{ name: 'tests', run: FAIL }] });
  const plain = makeRepo(null);
  const r = runHook(`git -C "${blocked.dir}" push`, plain.dir, dataDir());
  assert.strictEqual(r.status, 2);
});

test('fail closed: a push from outside any git repo is blocked, not allowed', () => {
  const r = runHook('git push', os.tmpdir(), dataDir());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /fail closed/);
});

test('fail closed: unreadable hook input blocks', () => {
  const r = spawnSync('node', [SCRIPT], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});
