// QA AI OS: turns a production check result into ONE GitHub issue.
//
//   failure: opens the issue, or comments on it if it's already open
//   success: comments "passing again" and closes it; nothing open = nothing to do
//
// A failed Action is easy to miss; an open issue emails the repo's watchers and
// stays until production is fixed. One issue, never one per run.
//
// Env: QA_RESULT (success | failure), QA_PROD_URL, QA_RUN_URL, GH_TOKEN.
// Exits 1 if GitHub can't be told: a check that can't raise its alarm fails.

import { spawnSync } from 'node:child_process';

const LABEL = 'qa-ai-os-prod';
const TITLE = 'Production check failing';
// QA_GH (tests only) points at a fake gh script; in CI this is the real gh.
const GH = process.env.QA_GH ? [process.execPath, process.env.QA_GH] : ['gh'];

function gh(...args) {
  const r = spawnSync(GH[0], [...GH.slice(1), ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error || '').toString().trim()}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

const result = process.env.QA_RESULT;
const url = process.env.QA_PROD_URL || '';
const run = process.env.QA_RUN_URL || '(no run link)';
const when = new Date().toISOString();

if (result !== 'success' && result !== 'failure') {
  console.error(`QA_RESULT must be "success" or "failure", got "${result}".`);
  process.exit(1);
}

const open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1') || '[]');
const issue = open.length ? String(open[0].number) : null;

if (result === 'failure') {
  const what = url ? `The smoke test against ${url} failed.` : 'No production URL is set (repository variable `QA_PROD_URL`), so production was not checked.';
  if (issue) {
    gh('issue', 'comment', issue, '--body', `Still failing at ${when}. ${what}\n\nRun: ${run}`);
    console.log(`Production check failing: commented on #${issue}.`);
  } else {
    gh('label', 'create', LABEL, '--color', 'B60205', '--description', 'QA AI OS production check', '--force');
    const created = gh('issue', 'create', '--title', TITLE, '--label', LABEL, '--body',
      `${what}\n\nFirst failure: ${when}\nRun (trace, screenshots, video): ${run}\n\nThis issue closes itself when the check passes again.`);
    console.log(`Production check failing: opened ${created}.`);
  }
} else if (issue) {
  gh('issue', 'comment', issue, '--body', `Passing again at ${when}. Run: ${run}`);
  gh('issue', 'close', issue);
  console.log(`Production check passing: closed #${issue}.`);
} else {
  console.log('Production check passing.');
}
