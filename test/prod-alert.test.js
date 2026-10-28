'use strict';

// The production check's alarm: one issue per outage, opened on failure,
// commented while it lasts, closed on recovery. Runs the real script (the file
// `init` copies into a user's repo) against a fake gh.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'stacks', 'nextjs', 'files', '.github', 'qa-ai-os', 'prod-alert.mjs');
const FAKE_GH = path.join(__dirname, 'fixtures', 'fake-gh.js');
const LABEL = 'qa-ai-os-prod';

function world(t, issues = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prod-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gh.json');
  fs.writeFileSync(file, JSON.stringify({ issues, calls: [] }));
  const run = (env) => spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, QA_GH: FAKE_GH, FAKE_GH_STATE: file, QA_PROD_URL: 'https://shop.example', QA_RUN_URL: 'https://ci/run/7', ...env },
  });
  const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { run, state };
}
const openIssue = (number) => ({ number, state: 'open', title: 'Production check failing', labels: [LABEL], body: '', comments: [] });

test('first failure opens one labelled issue with the URL and the run link', (t) => {
  const { run, state } = world(t);
  const r = run({ QA_RESULT: 'failure' });
  assert.strictEqual(r.status, 0, r.stderr);
  const { issues } = state();
  assert.strictEqual(issues.length, 1);
  assert.deepStrictEqual(issues[0].labels, [LABEL]);
  assert.match(issues[0].body, /against https:\/\/shop\.example failed/);
  assert.match(issues[0].body, /https:\/\/ci\/run\/7/);
  assert.match(r.stdout, /opened https:\/\/github\.com\/o\/r\/issues\/1/);
});

test('a failure while the issue is open comments on it, never opens a second', (t) => {
  const { run, state } = world(t, [openIssue(4)]);
  assert.strictEqual(run({ QA_RESULT: 'failure' }).status, 0);
  assert.strictEqual(run({ QA_RESULT: 'failure' }).status, 0);
  const { issues } = state();
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].comments.length, 2);
  assert.match(issues[0].comments[0], /^Still failing at .* https:\/\/shop\.example failed/s);
});

test('passing again closes the open issue with a comment', (t) => {
  const { run, state } = world(t, [openIssue(4)]);
  const r = run({ QA_RESULT: 'success' });
  assert.strictEqual(r.status, 0, r.stderr);
  const [issue] = state().issues;
  assert.strictEqual(issue.state, 'closed');
  assert.match(issue.comments[0], /^Passing again/);
});

test('passing with nothing open touches nothing', (t) => {
  const { run, state } = world(t);
  assert.strictEqual(run({ QA_RESULT: 'success' }).status, 0);
  assert.deepStrictEqual(state().calls.map((c) => c.slice(0, 2).join(' ')), ['issue list']);
});

test('only issues with the label count: a closed or unrelated issue is left alone', (t) => {
  const { run, state } = world(t, [
    { ...openIssue(1), state: 'closed' },
    { ...openIssue(2), labels: ['bug'] },
  ]);
  assert.strictEqual(run({ QA_RESULT: 'failure' }).status, 0);
  const { issues } = state();
  assert.strictEqual(issues.length, 3, 'a new issue, not a comment on #1 or #2');
  assert.deepStrictEqual(issues.slice(0, 2).map((i) => i.comments.length), [0, 0]);
});

test('no production URL set is reported as a failure, not a skip', (t) => {
  const { run, state } = world(t);
  assert.strictEqual(run({ QA_RESULT: 'failure', QA_PROD_URL: '' }).status, 0);
  assert.match(state().issues[0].body, /No production URL is set \(repository variable `QA_PROD_URL`\)/);
});

test('if GitHub cannot be told, the script fails loudly', (t) => {
  const { run } = world(t);
  const r = run({ QA_RESULT: 'failure', FAKE_GH_FAIL: 'issue create' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /gh issue create failed: HTTP 401/);
});

test('a result that is neither success nor failure is refused', (t) => {
  const { run, state } = world(t);
  for (const bad of ['', 'cancelled', 'skipped']) {
    const r = run({ QA_RESULT: bad });
    assert.strictEqual(r.status, 1, bad);
    assert.match(r.stderr, /QA_RESULT must be/);
  }
  assert.deepStrictEqual(state().calls, [], 'nothing sent to GitHub');
});
