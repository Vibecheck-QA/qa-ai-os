'use strict';

// Diff coverage: the parsers against real git and real lcov output, then the
// push gate end to end (a real repo with a real origin, node's own coverage).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const tmpDir = require('./tmp.js');
const path = require('path');
const { spawnSync } = require('child_process');
const { addedLines, parseLcov, ranges } = require('../scripts/diff-coverage.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'push-gate.js');
const lcovFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'lcov', `${name}.info`), 'utf8');

function tmp(t, prefix) {
  const dir = tmpDir(prefix);
  return dir;
}

test('addedLines: line numbers in the new file, across hunks', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -2 +2 @@',
    '-old',
    '+new',
    '@@ -10,0 +11,2 @@',
    '+x',
    '+y',
    '@@ -20,3 +21,0 @@',
    '-gone',
    '-gone',
    '-gone',
  ].join('\n');
  assert.deepStrictEqual(addedLines(diff).get('src/a.js'), [
    { line: 2, text: 'new' }, { line: 11, text: 'x' }, { line: 12, text: 'y' },
  ]);
});

test('addedLines: an added line starting with "++" is a line, not a file header', () => {
  const diff = ['diff --git a/a.c b/a.c', '--- a/a.c', '+++ b/a.c', '@@ -0,0 +1,2 @@', '+++i;', '+x', ''].join('\n');
  assert.deepStrictEqual(addedLines(diff).get('a.c'), [{ line: 1, text: '++i;' }, { line: 2, text: 'x' }]);
  assert.strictEqual(addedLines(diff).size, 1);
});

test('addedLines: deleted files, quoted paths, "no newline" markers', () => {
  const diff = [
    'diff --git a/old.js b/old.js', '--- a/old.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git "a/odd \\"n\\".js" "b/odd \\"n\\".js"', '--- /dev/null', '+++ "b/odd \\"n\\".js"', '@@ -0,0 +1 @@', '+hi', '\\ No newline at end of file',
  ].join('\n');
  const files = addedLines(diff);
  assert.deepStrictEqual([...files.keys()], ['odd "n".js']);
  assert.deepStrictEqual(files.get('odd "n".js'), [{ line: 1, text: 'hi' }]);
  // Adding the final newline: the marker sits between the old and new line.
  const eol = ['diff --git a/e.js b/e.js', '--- a/e.js', '+++ b/e.js', '@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+x'].join('\n');
  assert.deepStrictEqual(addedLines(eol).get('e.js'), [{ line: 1, text: 'x' }]);
});

test('parseLcov: real output from node, Vitest, Jest and pytest-cov', () => {
  const root = path.resolve('/home/dev/app');
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const name of ['node', 'vitest', 'jest']) {
    const price = parseLcov(lcovFixture(name), root).get(key('src/price.js'));
    assert.ok(price, name);
    assert.strictEqual(price.get(4), 1, `${name}: total() ran`);
    assert.strictEqual(price.get(10), 0, `${name}: discount() never ran`);
    assert.strictEqual(price.has(7), name === 'node', `${name}: blank line 7 is only listed by node`);
  }
  // Only Vitest lists the file no test loaded; node and Jest leave it out.
  assert.strictEqual(parseLcov(lcovFixture('vitest'), root).get(key('src/never.js')).get(2), 0);
  assert.strictEqual(parseLcov(lcovFixture('node'), root).has(key('src/never.js')), false);
  assert.strictEqual(parseLcov(lcovFixture('jest'), root).has(key('src/never.js')), false);
  assert.strictEqual(parseLcov(lcovFixture('pytest'), root).get('price.py').get(11), 0);
});

test('parseLcov: absolute paths, and the same file twice merges hits', () => {
  const root = path.resolve('/home/dev/app');
  const abs = path.join(root, 'src', 'x.js');
  const lcov = `SF:${abs}\nDA:1,3\nDA:2,0\nend_of_record\nSF:src/x.js\nDA:1,0\nend_of_record\n`;
  const x = parseLcov(lcov, root).get('src/x.js');
  assert.strictEqual(x.get(1), 3);
  assert.strictEqual(x.get(2), 0);
});

test('ranges', () => {
  assert.strictEqual(ranges([47, 42, 43, 44, 45, 46, 51]), '42-47, 51');
  assert.strictEqual(ranges([3]), '3');
});

// ---- end to end through the push gate ----

const PRICE = 'function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return sum;\n}\nmodule.exports = { total };\n';
const PRICE_TWO = 'function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return sum;\n}\nfunction discount(sum, code) {\n  if (code === \'HALF\') return sum / 2;\n  return sum;\n}\nmodule.exports = { total, discount };\n';
const TEST_TOTAL = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/price.js');\ntest('total', () => assert.strictEqual(total([{ price: 2, qty: 3 }]), 6));\n";
const TEST_DISCOUNT = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { discount } = require('../src/price.js');\ntest('discount', () => {\n  assert.strictEqual(discount(10, 'HALF'), 5);\n  assert.strictEqual(discount(10, 'NOPE'), 10);\n});\n";
const RUN = 'node --test --experimental-test-coverage "--test-coverage-include=src/**" --test-reporter=lcov --test-reporter-destination=lcov.info';
const COVERAGE = { lcov: 'lcov.info', include: ['src/'] };

// A repo whose origin/main holds `price.js` + its test.
function makeRepo(t, gate, { origin = true } = {}) {
  const dir = tmp(t, 'qa-cov-');
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('src/price.js', PRICE);
  write('test/price.test.js', TEST_TOTAL);
  write('.gitignore', 'lcov.info\n');
  write('.qa-ai-os.json', JSON.stringify({ gates: [{ name: 'tests', run: RUN, ...gate }] }));
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  if (origin) {
    const bare = tmp(t, 'qa-cov-origin-');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    g('remote', 'add', 'origin', bare);
    g('push', '-q', '-u', 'origin', 'main');
    g('remote', 'set-head', 'origin', 'main');
  }
  const commit = (files) => {
    for (const [f, text] of Object.entries(files)) write(f, text);
    g('add', '-A');
    g('commit', '-q', '-m', 'change');
    return g('rev-parse', 'HEAD').trim();
  };
  return { dir, write, commit };
}

function push(t, dir) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: 'git push' } });
  // Without this, the gate's `node --test` reports to THIS test run instead of writing lcov.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync('node', [SCRIPT], { input, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_DATA: tmp(t, 'qa-cov-data-') } });
}

test('changed lines no test ran: the push is blocked, and the gate names them', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: COVERAGE });
  commit({ 'src/price.js': PRICE_TWO });
  const r = push(t, dir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /4 of 5 changed lines never ran in any test \(20%, minimum 100%; changes since origin\/main\)/);
  assert.match(r.stderr, /src\/price\.js: 6-9\n/);
});

test('a test that runs the change lets the push through, and the receipt says so', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: COVERAGE });
  const sha = commit({ 'src/price.js': PRICE_TWO, 'test/discount.test.js': TEST_DISCOUNT });
  const r = push(t, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.qa-ai-os', 'receipts', `${sha}.json`), 'utf8'));
  assert.deepStrictEqual(receipt.gates[0].changedLines, { base: 'origin/main', covered: 5, total: 5, min: 100 });
});

test('a new source file no test loads counts every line as never run', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: COVERAGE });
  commit({ 'src/never.js': 'function never() {\n\n  return 42;\n}\nmodule.exports = { never };\n' });
  const r = push(t, dir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /4 of 4 changed lines/);
  assert.match(r.stderr, /src\/never\.js: no test loaded this file \(lines 1, 3-5\)/);
});

test('tests, docs and files outside "include" are not changes that need tests', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: { ...COVERAGE, exclude: ['src/generated/'] } });
  const sha = commit({
    'test/more.test.js': "require('node:test')('more', () => {});\n",
    'README.md': '# hi\n',
    'scripts/tool.js': 'module.exports = 1;\n',
    'src/generated/api.js': 'module.exports = 2;\n',
    'src/types.d.ts': 'export type X = 1;\n',
    'src/helpers.spec.js': 'module.exports = 3;\n',
  });
  const r = push(t, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.qa-ai-os', 'receipts', `${sha}.json`), 'utf8'));
  assert.deepStrictEqual(receipt.gates[0].changedLines, { base: 'origin/main', covered: 0, total: 0, min: 100 });
});

test('"min" lowers the bar: 1 of 5 is enough at 20%', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: { ...COVERAGE, min: 20 } });
  commit({ 'src/price.js': PRICE_TWO });
  assert.strictEqual(push(t, dir).status, 0);
});

test('lines the coverage file does not list (comments, braces) are not code', (t) => {
  // Like Jest and pytest: lcov lists only executable lines. Here 8 and 9 aren't listed.
  const lcov = 'SF:src/price.js\\nDA:6,1\\nDA:7,1\\nDA:10,1\\nend_of_record\\n';
  const { dir, commit } = makeRepo(t, { run: 'node write-lcov.js', changedLines: COVERAGE });
  commit({ 'src/price.js': PRICE_TWO, 'write-lcov.js': `require('fs').writeFileSync('lcov.info', '${lcov}');\n` });
  const r = push(t, dir);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('allowDirty: uncommitted changes are measured too', (t) => {
  const { dir, write } = makeRepo(t, { changedLines: COVERAGE });
  const config = JSON.parse(fs.readFileSync(path.join(dir, '.qa-ai-os.json'), 'utf8'));
  write('.qa-ai-os.json', JSON.stringify({ ...config, allowDirty: true }));
  spawnSync('git', ['commit', '-qam', 'allowDirty'], { cwd: dir });
  write('src/price.js', PRICE_TWO);
  const r = push(t, dir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /src\/price\.js: 6-9/);
});

test('an old coverage file never vouches for a run that wrote none', (t) => {
  const { dir, write, commit } = makeRepo(t, { run: 'node -e "process.exit(0)"', changedLines: COVERAGE });
  commit({ 'src/price.js': PRICE_TWO });
  write('lcov.info', 'SF:src/price.js\nDA:6,1\nDA:7,1\nDA:8,1\nDA:9,1\nDA:10,1\nend_of_record\n');
  const r = push(t, dir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /didn't write coverage to lcov\.info/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'lcov.info')), false);
});

test('nothing to compare against: blocked, not waved through', (t) => {
  const { dir } = makeRepo(t, { changedLines: COVERAGE }, { origin: false });
  const r = push(t, dir);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no origin default branch or upstream/);
  const named = makeRepo(t, { changedLines: { ...COVERAGE, base: 'nope/main' } });
  assert.match(push(t, named.dir).stderr, /"nope\/main" isn't a commit/);
});

test('"base" picks what the change is measured from', (t) => {
  const { dir, commit } = makeRepo(t, { changedLines: { ...COVERAGE, base: 'HEAD~1' } });
  commit({ 'src/price.js': PRICE_TWO });
  commit({ 'test/discount.test.js': TEST_DISCOUNT });
  // Measured from HEAD~1, only the new test changed: nothing to cover.
  assert.strictEqual(push(t, dir).status, 0);
});

test('a malformed "changedLines" blocks the push', (t) => {
  for (const bad of [
    {}, { lcov: 'lcov.info' }, { lcov: 'lcov.info', include: [] }, { lcov: '', include: ['src/'] },
    { ...COVERAGE, min: 101 }, { ...COVERAGE, min: '80' }, { ...COVERAGE, exclude: 'src/x' }, { ...COVERAGE, base: '' }, 'lcov.info',
  ]) {
    const { dir } = makeRepo(t, { changedLines: bad }, { origin: false });
    const r = push(t, dir);
    assert.strictEqual(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /"changedLines" needs/, JSON.stringify(bad));
  }
});
