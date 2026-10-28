'use strict';

// stack.js: what it adds to a repo and, as importantly, what it leaves alone.
// No installs here; test/stack-e2e.js (CI job "stack") runs the real thing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const tmpDir = require('./tmp.js');
const path = require('path');
const { spawnSync } = require('child_process');
const { plan, apply, atLeast } = require('../scripts/stack.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'next-app');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'stack.js');

function app(t, edit) {
  const dir = tmpDir('qa-stack-unit-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (edit) edit(dir);
  return dir;
}
const pkgEdit = (dir, fn) => {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(pkg);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
};

test('plan: a bare Next.js app gets every layer', (t) => {
  const p = plan(app(t));
  assert.strictEqual(p.stack, 'nextjs');
  assert.deepStrictEqual(p.layers, { unit: 'add', e2e: 'add', types: 'add', prod: 'add', ci: 'add' });
  assert.deepStrictEqual(p.files, {
    add: ['vitest.config.mts', 'vitest.setup.ts', 'playwright.config.ts', 'e2e/smoke.spec.ts',
      '.github/workflows/qa-ai-os-prod.yml', '.github/qa-ai-os/prod-alert.mjs', '.github/workflows/qa-ai-os.yml'],
    keep: [],
  });
  assert.deepStrictEqual(p.coverageInclude, ['lib', 'components']);
  assert.match(p.install, /^npm install -D vitest@\^\d/);
  for (const dep of ['@vitest/coverage-v8', '@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event', 'jsdom', '@playwright/test']) {
    assert.ok(p.install.includes(` ${dep}@^`), dep);
  }
  assert.deepStrictEqual(p.gates, [
    { name: 'types', run: 'npm run typecheck', timeoutSeconds: 180 },
    { name: 'tests', run: 'npm run test:coverage', timeoutSeconds: 300, changedLines: { lcov: 'coverage/lcov.info', include: ['lib/', 'components/'] } },
    { name: 'smoke', run: 'npm run test:smoke', timeoutSeconds: 420, minTests: 1 },
  ]);
});

test('plan changes nothing on disk', (t) => {
  const dir = app(t);
  const before = fs.readdirSync(dir).sort();
  const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  plan(dir);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), pkg);
});

test('apply: writes the files, scripts and ignores; a second apply does nothing', (t) => {
  const dir = app(t);
  apply(dir);
  const config = fs.readFileSync(path.join(dir, 'vitest.config.mts'), 'utf8');
  assert.match(config, /include: \["lib\/\*\*", "components\/\*\*"\]/);
  assert.ok(!config.includes('__COVERAGE_INCLUDE__'));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['test:coverage'], 'vitest run --coverage');
  assert.strictEqual(pkg.scripts.dev, 'next dev', 'existing scripts stay');
  assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', 'qa-ai-os.yml')));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'),
    'node_modules/\n.next/\ncoverage/\nplaywright-report/\ntest-results/\n.qa-ai-os/receipts/\n');

  const snapshot = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const files = ['vitest.config.mts', 'package.json', '.gitignore'].map(snapshot);
  const again = apply(dir);
  assert.deepStrictEqual(again.files.add, []);
  assert.deepStrictEqual(again.scripts.add, {});
  assert.deepStrictEqual(again.gitignore, []);
  assert.deepStrictEqual(['vitest.config.mts', 'package.json', '.gitignore'].map(snapshot), files);
});

test('apply never overwrites a file you already have', (t) => {
  const mine = '// my own playwright config\n';
  const dir = app(t, (d) => fs.writeFileSync(path.join(d, 'playwright.config.ts'), mine));
  const out = apply(dir);
  assert.deepStrictEqual(out.files.keep, ['playwright.config.ts']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8'), mine);
});

test('a script you already have is kept; a different command is reported', (t) => {
  const dir = app(t, (d) => pkgEdit(d, (p) => { p.scripts.test = 'vitest'; p.scripts.typecheck = 'tsc --noEmit'; }));
  const out = apply(dir);
  assert.deepStrictEqual(out.scripts.keep, [{ name: 'test', yours: 'vitest', ours: 'vitest run' }]);
  assert.strictEqual(out.scripts.add.typecheck, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.test, 'vitest');
});

test('a layer whose tool you already use is left whole', (t) => {
  const dir = app(t, (d) => pkgEdit(d, (p) => { p.devDependencies.jest = '^29.0.0'; p.devDependencies.cypress = '^13.0.0'; }));
  const out = plan(dir);
  assert.deepStrictEqual(out.layers, { unit: 'keep: jest', e2e: 'keep: cypress', types: 'add', prod: 'skip: needs e2e', ci: 'add' });
  assert.strictEqual(out.install, null);
  assert.deepStrictEqual(out.files.add, ['.github/workflows/qa-ai-os.yml']);
  assert.deepStrictEqual(out.gates.map((g) => g.name), ['types']);
});

test('a package already installed is not installed again', (t) => {
  const dir = app(t, (d) => pkgEdit(d, (p) => { p.devDependencies['@testing-library/react'] = '^16.0.0'; }));
  const out = plan(dir);
  assert.ok(!out.install.includes('@testing-library/react@'));
  assert.ok(out.install.includes('@testing-library/dom@'));
});

test('not a Next.js app, or no package.json: the generic path', (t) => {
  const dir = app(t, (d) => pkgEdit(d, (p) => { delete p.dependencies.next; }));
  assert.strictEqual(plan(dir).stack, null);
  assert.match(plan(dir).reason, /no "next" dependency/);
  const empty = tmpDir('qa-stack-unit-');
  assert.strictEqual(plan(empty).stack, null);
  assert.strictEqual(apply(empty).stack, null);
});

test('the install command matches your package manager', (t) => {
  for (const [lock, cmd] of [['pnpm-lock.yaml', 'pnpm add -D '], ['yarn.lock', 'yarn add -D '], ['bun.lock', 'bun add -d '], ['package-lock.json', 'npm install -D ']]) {
    const dir = app(t, (d) => fs.writeFileSync(path.join(d, lock), ''));
    assert.ok(plan(dir).install.startsWith(cmd), lock);
  }
});

test('package.json keeps its line endings and indentation', (t) => {
  const dir = app(t, (d) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg, null, 4).replace(/\n/g, '\r\n') + '\r\n');
  });
  apply(dir);
  const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  assert.ok(raw.startsWith('{\r\n    "name"'));
  assert.ok(!/[^\r]\n/.test(raw), 'every newline is CRLF');
});

test('.gitignore without a final newline: entries go on their own lines, no duplicates', (t) => {
  const dir = app(t, (d) => fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\ncoverage/'));
  const out = apply(dir);
  assert.deepStrictEqual(out.gitignore, ['playwright-report/', 'test-results/', '.qa-ai-os/receipts/']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'),
    'node_modules/\ncoverage/\nplaywright-report/\ntest-results/\n.qa-ai-os/receipts/\n');
});

test('source folders: src/ layouts are found; none found means no changedLines', (t) => {
  const src = app(t, (d) => {
    fs.renameSync(path.join(d, 'lib'), path.join(d, 'src-lib'));
    fs.mkdirSync(path.join(d, 'src'));
    fs.renameSync(path.join(d, 'src-lib'), path.join(d, 'src', 'lib'));
    fs.renameSync(path.join(d, 'components'), path.join(d, 'src', 'components'));
  });
  assert.deepStrictEqual(plan(src).coverageInclude, ['src/lib', 'src/components']);

  const none = app(t, (d) => {
    fs.rmSync(path.join(d, 'lib'), { recursive: true });
    fs.rmSync(path.join(d, 'components'), { recursive: true });
  });
  const out = apply(none);
  assert.strictEqual(out.gates.find((g) => g.name === 'tests').changedLines, undefined);
  assert.match(fs.readFileSync(path.join(none, 'vitest.config.mts'), 'utf8'), /include: \["\*\*\/\*\.\{ts,tsx\}"\]/);
});

test('Node version check', () => {
  assert.strictEqual(atLeast('22.15.0', '22.13.0'), true);
  assert.strictEqual(atLeast('22.13.0', '22.13.0'), true);
  assert.strictEqual(atLeast('22.12.9', '22.13.0'), false);
  assert.strictEqual(atLeast('20.19.0', '22.13.0'), false);
  assert.strictEqual(atLeast('24.0.0', '22.13.0'), true);
});

test('CLI: plan prints JSON; anything else is a usage error', (t) => {
  const dir = app(t);
  const r = spawnSync(process.execPath, [SCRIPT, 'plan', '--dir', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).stack, 'nextjs');
  const bad = spawnSync(process.execPath, [SCRIPT, 'nope'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /usage/);
});
