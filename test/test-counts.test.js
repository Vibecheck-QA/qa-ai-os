'use strict';

// The parser against REAL runner output: every fixture is what that runner
// printed for the same suite (2 pass, 1 skipped, 1 fails), local paths scrubbed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { testCounts } = require('../scripts/test-counts.js');

const out = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'test-output', `${name}.txt`), 'utf8');
const SUITE = { passed: 2, failed: 1, skipped: 1 };

test('real output from each runner: 2 passed, 1 failed, 1 skipped', () => {
  for (const [file, runner] of [
    ['node', 'node'], ['node-spec', 'node'], ['vitest', 'vitest'], ['jest', 'jest'],
    ['pytest', 'pytest'], ['pytest-v', 'pytest'], ['mocha', 'mocha'], ['playwright', 'playwright'],
  ]) {
    assert.deepStrictEqual(testCounts(out(file)), { runner, ...SUITE }, file);
  }
});

test('"no tests" is zero, not unknown', () => {
  assert.deepStrictEqual(testCounts(out('vitest-empty')), { runner: 'vitest', passed: 0, failed: 0, skipped: 0 });
  assert.deepStrictEqual(testCounts(out('pytest-empty')), { runner: 'pytest', passed: 0, failed: 0, skipped: 0 });
});

test('no summary is unknown (null), never zero', () => {
  for (const text of ['', 'compiled successfully', 'Found 0 errors.', 'ok 1 - something']) {
    assert.strictEqual(testCounts(text), null, JSON.stringify(text));
  }
});

test('colour codes and Windows line endings are read through', () => {
  const coloured = out('vitest').replace(/Tests {2}/, '\x1b[2mTests\x1b[22m  ').replace(/\n/g, '\r\n');
  assert.deepStrictEqual(testCounts(coloured), { runner: 'vitest', ...SUITE });
});

test('the last summary wins when a run prints more than one', () => {
  const twice = `# tests 9\n# pass 9\n# fail 0\n# skipped 0\n...\n${out('node')}`;
  assert.deepStrictEqual(testCounts(twice), { runner: 'node', ...SUITE });
});

test('vitest: "Test Files" is not the test count', () => {
  const files = ' Test Files  3 passed (3)\n      Tests  12 passed (12)\n';
  assert.deepStrictEqual(testCounts(files), { runner: 'vitest', passed: 12, failed: 0, skipped: 0 });
});
