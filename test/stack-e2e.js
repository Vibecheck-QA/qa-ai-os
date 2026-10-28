#!/usr/bin/env node
// The recommended stack, end to end, on a fresh Next.js app (CI job "stack"):
// apply it, install it, run every check, then drive the real push gate and
// prove each gate passes on good code AND blocks bad code.
//
// Slow (installs packages, downloads Chromium, builds Next three times), so it
// isn't part of `npm test`. Run: node test/stack-e2e.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'next-app');
const TESTS = path.join(__dirname, 'fixtures', 'next-app-tests');
const GATE = path.join(ROOT, 'scripts', 'push-gate.js');
const STACK = path.join(ROOT, 'scripts', 'stack.js');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-stack-'));
const app = path.join(work, 'app');
const step = (msg) => console.log(`\n== ${msg}`);

// Colour on everywhere, so a local run prints what CI prints; assertions read
// the text with colour codes stripped.
const ENV = { ...process.env, FORCE_COLOR: '1' };
const plain = (s) => (s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function sh(cmd, { cwd = app, ok = true } = {}) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
  if (ok && r.status !== 0) {
    console.log(r.stdout, r.stderr);
    throw new Error(`failed (exit ${r.status}): ${cmd}`);
  }
  return { status: r.status, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), text);
};
const read = (file) => fs.readFileSync(path.join(app, file), 'utf8');

function push() {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: app, tool_input: { command: 'git push' } });
  const r = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(work, 'data') } });
  console.log(`push gate: exit ${r.status}${r.stderr ? `\n${r.stderr.trim()}` : ''}`);
  return { status: r.status, stderr: plain(r.stderr) };
}
const head = () => sh('git rev-parse HEAD').stdout.trim();
const receipt = () => JSON.parse(read(`.qa-ai-os/receipts/${head()}.json`));

try {
  step('fresh app, its own origin');
  fs.cpSync(FIXTURE, app, { recursive: true });
  sh('git init -q -b main && git config user.email t@example.com && git config user.name T && git add -A && git commit -qm app');
  sh(`git init -q --bare -b main "${path.join(work, 'origin.git')}"`, { cwd: work });
  sh(`git remote add origin "${path.join(work, 'origin.git')}"`);

  step('plan, then apply');
  const plan = JSON.parse(sh(`node "${STACK}" plan`).stdout);
  assert.strictEqual(plan.stack, 'nextjs');
  assert.ok(plan.node.ok, `Node ${plan.node.current} is below ${plan.node.required}`);
  assert.deepStrictEqual(plan.coverageInclude, ['lib', 'components']);
  assert.deepStrictEqual(plan.gates.map((g) => g.name), ['types', 'tests', 'smoke']);
  const applied = JSON.parse(sh(`node "${STACK}" apply`).stdout);
  assert.deepStrictEqual(applied, plan, 'apply did what plan said');

  step(`install: ${plan.install}`);
  sh('npm install --no-audit --no-fund');
  sh(`${plan.install} --no-audit --no-fund`);
  sh('npx playwright install chromium');

  step('the app\'s own tests, then every check by hand');
  fs.cpSync(TESTS, app, { recursive: true });
  sh('npm run typecheck');
  const unit = sh('npm run test:coverage').stdout;
  assert.match(unit, /Tests\s+3 passed \(3\)/);
  assert.ok(fs.existsSync(path.join(app, 'coverage', 'lcov.info')), 'coverage wrote lcov');
  const smoke = sh('npm run test:smoke');
  assert.match(smoke.stdout, /1 passed/);

  step('gates from the plan; push the base');
  const gates = plan.gates.map((g) => (g.name === 'tests' ? { ...g, minTests: 3, maxSkipped: 0 } : g));
  write('.qa-ai-os.json', `${JSON.stringify({ gates }, null, 2)}\n`);
  sh('git add -A && git commit -qm "QA AI OS stack" && git push -q -u origin main && git remote set-head origin main');
  for (const f of ['coverage/', 'playwright-report/', 'test-results/', '.qa-ai-os/receipts/']) {
    assert.ok(read('.gitignore').split('\n').includes(f), `.gitignore has ${f}`);
  }
  const base = head();

  step('PASS: every gate green, receipt has counts and coverage');
  sh('git checkout -qb feature');
  let r = push();
  assert.strictEqual(r.status, 0);
  const g = Object.fromEntries(receipt().gates.map((x) => [x.name, x]));
  assert.deepStrictEqual(g.tests.tests, { runner: 'vitest', passed: 3, failed: 0, skipped: 0 });
  assert.deepStrictEqual(g.tests.changedLines, { base: 'origin/main', covered: 0, total: 0, min: 100 });
  assert.strictEqual(g.smoke.tests.passed, 1);

  step('BLOCK: new code no test runs');
  write('lib/price.ts', `${read('lib/price.ts')}\nexport function discount(sum: number, code: string): number {\n  if (code === 'HALF') return sum / 2;\n  return sum;\n}\n`);
  sh('git commit -qam "discount, untested"');
  r = push();
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"tests" passed, but \d+ of \d+ changed lines never ran/);
  assert.match(r.stderr, /lib\/price\.ts: /);

  step('BLOCK: a type error');
  sh(`git reset -q --hard ${base}`);
  write('lib/price.ts', read('lib/price.ts').replace('return items.reduce', 'const n: number = "x";\n  return items.reduce'));
  sh('git commit -qam "type error"');
  r = push();
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"types" failed/);

  step('BLOCK: the page throws in the browser');
  sh(`git reset -q --hard ${base}`);
  // In app/, outside the unit-coverage "include": only the smoke test can catch it.
  write('app/boom.tsx', "'use client';\nimport { useEffect } from 'react';\nexport function Boom() {\n  useEffect(() => { throw new Error('boom'); }, []);\n  return null;\n}\n");
  write('app/page.tsx', read('app/page.tsx').replace("import { Cart } from '@/components/Cart';", "import { Cart } from '@/components/Cart';\nimport { Boom } from './boom';").replace('<h1>Shop</h1>', '<h1>Shop</h1>\n      <Boom />'));
  sh('git add -A && git commit -qm "boom"');
  r = push();
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /"smoke" failed/);

  console.log('\nStack end to end: every gate passed good code and blocked bad code.');
} finally {
  if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
}
