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
