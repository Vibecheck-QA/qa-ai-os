// Did the tests run the lines this push changes?
//
// A green test run proves the tests pass, not that they touched the change. This
// matches the lines added since the base (the default branch, by default) with
// the lines the test run executed, read from its lcov file (node, Vitest, Jest,
// pytest-cov and c8 all write one; fixtures in test/fixtures/lcov/).
//
// Unknown is never covered:
// - a changed source file missing from the lcov counts every changed line as
//   never run (node, Jest and pytest leave out files no test loaded);
// - lines lcov doesn't list (comments, blank lines, braces) aren't code and
//   don't count either way.
//
// Coverage proves a line RAN, not that a test checked it. The mutation gate
// proves that part.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Changes to tests aren't changes that need tests.
const TEST_FILES = [
  /(^|\/)(__tests__|__mocks__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
  /\.d\.[cm]?ts$/,
];

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const slash = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// `+++ "b/odd \"name\".js"` -> odd "name".js
function diffPath(raw) {
  let p = raw;
  if (p.startsWith('"')) {
    try { p = JSON.parse(p); } catch { p = p.slice(1, -1); }
  }
  return p.startsWith('b/') ? p.slice(2) : p;
}

// `git diff -U0` text -> Map(file -> [{ line, text }]) of ADDED lines, by their
// line number in the new file. Hunk bodies are consumed by their header counts,
// so an added line that itself starts with "++" is never read as a file header.
function addedLines(diff) {
  const files = new Map();
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) { file = null; continue; }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4);
      file = p === '/dev/null' ? null : diffPath(p);
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!h) continue;
    let oldLeft = h[1] === undefined ? 1 : Number(h[1]);
    let newLeft = h[3] === undefined ? 1 : Number(h[3]);
    let at = Number(h[2]);
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      const body = lines[++i];
      if (body.startsWith('\\')) continue; // "\ No newline at end of file"
      if (body.startsWith('-')) { oldLeft--; continue; }
      if (body.startsWith('+')) {
        if (file) {
          if (!files.has(file)) files.set(file, []);
          files.get(file).push({ line: at, text: body.slice(1) });
        }
        at++; newLeft--;
        continue;
      }
      at++; oldLeft--; newLeft--; // context line (only with -U > 0)
    }
  }
  return files;
}

// lcov text -> Map(folded repo-relative path -> Map(line -> hits)). Paths may be
// absolute or relative, with either slash; the same file twice is merged.
function parseLcov(text, root) {
  const out = new Map();
  let lines = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) {
      const sf = l.slice(3);
      const rel = path.isAbsolute(sf) ? path.relative(root, sf) : sf;
      const key = fold(slash(rel));
      if (!out.has(key)) out.set(key, new Map());
      lines = out.get(key);
    } else if (l.startsWith('DA:') && lines) {
      const [n, hits] = l.slice(3).split(',');
      const line = Number(n);
      lines.set(line, Math.max(lines.get(line) || 0, Number(hits) || 0));
    } else if (l === 'end_of_record') {
      lines = null;
    }
  }
  return out;
}

// "42-47, 51"
function ranges(nums) {
  const out = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

// The ref this push's change is measured from: the configured base, else the
// remote's default branch, else the upstream. null when none resolves.
function resolveBase(root, configured) {
  const candidates = configured ? [configured] : ['refs/remotes/origin/HEAD', '@{upstream}'];
  for (const ref of candidates) {
    const sha = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], root);
    if (sha) {
      const name = ref === 'refs/remotes/origin/HEAD'
        ? (git(['symbolic-ref', '-q', '--short', ref], root) || 'origin/HEAD')
        : ref === '@{upstream}' ? (git(['rev-parse', '--abbrev-ref', ref], root) || ref) : ref;
      return { name, sha };
    }
  }
  return null;
}

// spec: { lcov, include, exclude?, min?, base? } (validated by the push gate).
// worktree: true compares the working tree (allowDirty runs), else HEAD.
// Returns { base, covered, total, percent, files: [{ file, lines, neverLoaded }] }
// or { error } when the answer can't be known.
function diffCoverage(root, spec, { worktree = false } = {}) {
  const base = resolveBase(root, spec.base);
  if (!base) {
    return { error: spec.base
      ? `"${spec.base}" isn't a commit in this repo.`
      : 'no origin default branch or upstream to compare against. Set "changedLines.base" (e.g. "origin/main").' };
  }
  const mergeBase = git(['merge-base', base.sha, 'HEAD'], root);
  if (!mergeBase) return { error: `HEAD shares no history with ${base.name}.` };

  const diff = git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', '-M', mergeBase, ...(worktree ? [] : ['HEAD'])], root);
  if (diff === null) return { error: `git diff against ${base.name} failed.` };

  const lcovFile = path.resolve(root, spec.lcov);
  let lcov;
  try { lcov = parseLcov(fs.readFileSync(lcovFile, 'utf8'), root); } catch {
    return { error: `the test run didn't write coverage to ${spec.lcov}.` };
  }

  const include = spec.include.map((p) => fold(slash(p)));
  const exclude = (spec.exclude || []).map((p) => fold(slash(p)));
  const under = (file, prefixes) => prefixes.some((p) => file === p || file.startsWith(p.endsWith('/') ? p : `${p}/`));

  let covered = 0;
  let total = 0;
  const files = [];
  for (const [file, added] of addedLines(diff)) {
    const key = fold(file);
    if (!under(key, include) || under(key, exclude) || TEST_FILES.some((re) => re.test(file))) continue;
    const hits = lcov.get(key);
    const missed = [];
    for (const { line, text } of added) {
      if (hits) {
        if (!hits.has(line)) continue; // not code
        total++;
        if (hits.get(line) > 0) covered++; else missed.push(line);
      } else if (text.trim()) {
        total++;
        missed.push(line);
      }
    }
    if (missed.length) files.push({ file, lines: ranges(missed), neverLoaded: !hits });
  }
  const percent = total === 0 ? 100 : Math.floor((covered * 1000) / total) / 10;
  return { base: base.name, covered, total, percent, files };
}

module.exports = { addedLines, parseLcov, ranges, resolveBase, diffCoverage, TEST_FILES };
