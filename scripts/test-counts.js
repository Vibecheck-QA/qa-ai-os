// Reads how many tests passed, failed and were skipped from a test runner's
// output. Exit codes can't tell "12 tests passed" from "0 tests ran" or "18
// files silently skipped"; the summary line can.
//
// Each pattern matches the summary line a real runner prints (fixtures in
// test/fixtures/test-output/). The LAST summary in the output wins: runners
// print it at the end, and earlier lines can quote test names.
//
// Returns { runner, passed, failed, skipped } or null when no summary is found.
// null is "unknown", never "zero".

'use strict';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const lastMatch = (text, re) => {
  let m = null;
  for (const x of text.matchAll(re)) m = x;
  return m;
};

// "1 failed | 2 passed | 1 skipped" or "1 failed, 1 skipped, 2 passed" -> counts.
function words(list) {
  const out = { passed: 0, failed: 0, skipped: 0 };
  for (const [, n, word] of list.matchAll(/(\d+)\s+([a-z]+)/g)) {
    if (word === 'passed') out.passed += Number(n);
    else if (word === 'failed' || word === 'errors' || word === 'error') out.failed += Number(n);
    else if (word === 'skipped' || word === 'todo' || word === 'pending' || word === 'xfailed' || word === 'deselected') out.skipped += Number(n);
  }
  return out;
}

const PARSERS = [
  // node --test (TAP): "# pass 2" "# fail 1" "# skipped 1" "# todo 0"
  ['node', (t) => {
    const pass = lastMatch(t, /^# pass (\d+)$/gm);
    const fail = lastMatch(t, /^# fail (\d+)$/gm);
    if (!pass || !fail) return null;
    const skip = lastMatch(t, /^# skipped (\d+)$/gm);
    const todo = lastMatch(t, /^# todo (\d+)$/gm);
    return { passed: +pass[1], failed: +fail[1], skipped: (skip ? +skip[1] : 0) + (todo ? +todo[1] : 0) };
  }],
  // node --test (spec): "ℹ pass 2" "ℹ fail 1" "ℹ skipped 1"
  ['node', (t) => {
    const pass = lastMatch(t, /^ℹ pass (\d+)$/gm);
    const fail = lastMatch(t, /^ℹ fail (\d+)$/gm);
    if (!pass || !fail) return null;
    const skip = lastMatch(t, /^ℹ skipped (\d+)$/gm);
    const todo = lastMatch(t, /^ℹ todo (\d+)$/gm);
    return { passed: +pass[1], failed: +fail[1], skipped: (skip ? +skip[1] : 0) + (todo ? +todo[1] : 0) };
  }],
  // vitest: "      Tests  1 failed | 2 passed | 1 skipped (4)"; no files: "No test files found"
  ['vitest', (t) => {
    const m = lastMatch(t, /^\s*Tests\s{2,}(.+?)\s+\(\d+\)\s*$/gm);
    if (m) return words(m[1]);
    return /^No test files found/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;
  }],
  // jest: "Tests:       1 failed, 1 skipped, 2 passed, 4 total"
  ['jest', (t) => {
    const m = lastMatch(t, /^Tests:\s+(.+?),\s*\d+ total\s*$/gm);
    return m ? words(m[1]) : null;
  }],
  // pytest: "1 failed, 2 passed, 1 skipped in 0.08s" (maybe inside ====); "no tests ran in 0.01s"
  ['pytest', (t) => {
    const m = lastMatch(t, /^=*\s*((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/gm);
    if (m) return words(m[1]);
    return /^=*\s*no tests ran in [\d.]+s/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;
  }],
  // mocha: "  2 passing (3ms)" "  1 pending" "  1 failing"
  ['mocha', (t) => {
    const pass = lastMatch(t, /^\s+(\d+) passing\b/gm);
    if (!pass) return null;
    const pend = lastMatch(t, /^\s+(\d+) pending$/gm);
    const fail = lastMatch(t, /^\s+(\d+) failing$/gm);
    return { passed: +pass[1], failed: fail ? +fail[1] : 0, skipped: pend ? +pend[1] : 0 };
  }],
  // playwright: "  1 failed" "  1 skipped" "  2 passed (719ms)"
  ['playwright', (t) => {
    const pass = lastMatch(t, /^\s+(\d+) passed \([\d.]+m?s\)$/gm);
    if (!pass) return null;
    const fail = lastMatch(t, /^\s+(\d+) failed$/gm);
    const skip = lastMatch(t, /^\s+(\d+) skipped$/gm);
    return { passed: +pass[1], failed: fail ? +fail[1] : 0, skipped: skip ? +skip[1] : 0 };
  }],
];

function testCounts(output) {
  const text = String(output || '').replace(ANSI, '').replace(/\r\n/g, '\n');
  for (const [runner, parse] of PARSERS) {
    const c = parse(text);
    if (c) return { runner, ...c };
  }
  return null;
}

module.exports = { testCounts };
