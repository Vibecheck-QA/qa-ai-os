'use strict';

// Behaviour tests for the shipped mutation runner: they run the real script
// against small throwaway projects, the way a push gate or a user would.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'mutate.js');
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT; // the inner project's tests are plain scripts, not this runner's subtests

const CALC = [
  'module.exports.add = (a, b) => a + b;',
  'module.exports.isAdult = (age) => age >= 18;',
  'module.exports.untested = () => 1;',
  '',
].join('\n');
const TESTS = [
  "const assert = require('assert');",
  "const c = require('./calc.js');",
  'assert.strictEqual(c.add(2, 3), 5);',
  'assert.strictEqual(c.isAdult(18), true);',
  'assert.strictEqual(c.isAdult(17), false);',
  '',
].join('\n');

function project({ calc = CALC, mutants, run = 'node test.js', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mutate-'));
  fs.writeFileSync(path.join(dir, 'calc.js'), calc);
  fs.writeFileSync(path.join(dir, 'test.js'), TESTS);
  if (mutants) {
    fs.mkdirSync(path.join(dir, '.qa-ai-os'));
    fs.writeFileSync(path.join(dir, '.qa-ai-os', 'mutants.json'), JSON.stringify({ run, ...extra, mutants }));
  }
  return dir;
}

function mutate(dir) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: ENV });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const bytes = (dir, f = 'calc.js') => fs.readFileSync(path.join(dir, f));
const KILLABLE = [
  { name: 'add subtracts', file: 'calc.js', find: 'a + b', replace: 'a - b' },
  { name: 'adult boundary off by one', file: 'calc.js', find: 'age >= 18', replace: 'age > 18' },
];

test('every mutant killed: exit 0, files back byte for byte, no backup left', () => {
  const dir = project({ mutants: KILLABLE });
  const before = bytes(dir);
  const r = mutate(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /killed +add subtracts/);
  assert.match(r.out, /2 of 2 mutants killed\./);
  assert.ok(bytes(dir).equals(before));
  assert.strictEqual(fs.existsSync(path.join(dir, '.qa-ai-os', 'mutate-backup')), false);
});

test('a mutant no test catches survives: exit 1 and it is named', () => {
  const dir = project({ mutants: [...KILLABLE, { name: 'untested returns 2', file: 'calc.js', find: '=> 1', replace: '=> 2' }] });
  const before = bytes(dir);
  const r = mutate(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /SURVIVED +untested returns 2/);
  assert.ok(bytes(dir).equals(before));
});

test('a red baseline is refused before any mutation: exit 2, nothing touched', () => {
  const dir = project({ mutants: KILLABLE, run: 'node -e "process.exit(1)"' });
  const before = bytes(dir);
  const r = mutate(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /Baseline is not green/);
  assert.ok(bytes(dir).equals(before));
});

test('a find that matches nothing, or more than once, is unchecked: exit 2', () => {
  for (const [find, why] of [['a * b', /matched nothing/], ['module.exports', /matched 3 times/]]) {
    const dir = project({ mutants: [{ name: 'bad find', file: 'calc.js', find, replace: 'x' }] });
    const r = mutate(dir);
    assert.strictEqual(r.status, 2, r.out);
    assert.match(r.out, why);
  }
});

test('no mutants file, a broken one, or a mutant that changes nothing: exit 2', () => {
  const none = mutate(project());
  assert.strictEqual(none.status, 2);
  assert.match(none.out, /no \.qa-ai-os[\\/]mutants\.json/);
  const bad = mutate(project({ mutants: [{ name: 'no find', file: 'calc.js', replace: 'x' }] }));
  assert.strictEqual(bad.status, 2);
  assert.match(bad.out, /mutants\[0\] needs/);
  const same = mutate(project({ mutants: [{ name: 'same', file: 'calc.js', find: 'a + b', replace: 'a + b' }] }));
  assert.strictEqual(same.status, 2);
  assert.match(same.out, /replaces "find" with itself/);
});

test('a mutant with its own command uses it (baseline included), not the top-level one', () => {
  const own = 'node -e "require(\'fs\').appendFileSync(\'used.txt\',\'x\')" && node test.js';
  const dir = project({ run: 'node -e "process.exit(3)"', mutants: [{ ...KILLABLE[0], run: own }] });
  const r = mutate(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'used.txt'), 'utf8'), 'xx'); // baseline + the mutant
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the file comes back from the byte copy, even when the broken text already appears elsewhere', () => {
  // Undoing the edit (replace "a - b" with "a + b") would hit the comment first
  // and leave the code broken; only a byte copy restores it.
  const calc = `// a - b is subtraction, not this\n${CALC}`;
  const dir = project({ calc, mutants: [KILLABLE[0]] });
  const before = bytes(dir);
  const r = mutate(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(bytes(dir).equals(before));
});

test('a hang is no verdict: exit 2, the file is put back, and the hung test is killed', () => {
  const loop = "(require('fs').writeFileSync('hang.pid', String(process.pid)), (() => { for (;;) {} })())";
  const dir = project({ mutants: [{ name: 'loop forever', file: 'calc.js', find: 'a + b', replace: loop }], extra: { timeoutSeconds: 2 } });
  const before = bytes(dir);
  const r = mutate(dir);
  const pid = Number(fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8'));
  try {
    assert.strictEqual(r.status, 2, r.out);
    assert.match(r.out, /timed out/);
    assert.ok(bytes(dir).equals(before));
    assert.strictEqual(alive(pid), false, 'the hung test process must not be left running');
  } finally {
    if (alive(pid)) process.kill(pid);
  }
});

test('CRLF files: a multi-line find written with \\n still matches, and the CRLF bytes come back', () => {
  const dir = project({
    calc: CALC.replace(/\n/g, '\r\n'),
    mutants: [{ name: 'two lines', file: 'calc.js', find: 'a + b;\nmodule.exports.isAdult = (age) => age >= 18', replace: 'a - b;\nmodule.exports.isAdult = (age) => age >= 18' }],
  });
  const before = bytes(dir);
  const r = mutate(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(bytes(dir).equals(before));
  assert.ok(before.includes('\r\n'));
});

test('an interrupted run is put back first', () => {
  const dir = project({ mutants: KILLABLE });
  const original = bytes(dir);
  fs.mkdirSync(path.join(dir, '.qa-ai-os', 'mutate-backup'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.qa-ai-os', 'mutate-backup', 'calc.js'), original);
  fs.writeFileSync(path.join(dir, 'calc.js'), CALC.replace('a + b', 'a - b')); // left broken
  const r = mutate(dir);
  assert.match(r.out, /Put back 1 file/);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(bytes(dir).equals(original));
});
