// A stand-in for the gh CLI: issue state in a JSON file, every call recorded.
// FAKE_GH_FAIL="issue create" makes that command fail.
'use strict';

const fs = require('fs');

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const flag = (name) => args[args.indexOf(name) + 1];

if (process.env.FAKE_GH_FAIL && args.join(' ').startsWith(process.env.FAKE_GH_FAIL)) {
  save();
  process.stderr.write('HTTP 401: Bad credentials\n');
  process.exit(1);
}

const [a, b] = args;
if (a === 'issue' && b === 'list') {
  const open = state.issues.filter((i) => i.state === 'open' && i.labels.includes(flag('--label')));
  process.stdout.write(JSON.stringify(open.slice(0, 1).map((i) => ({ number: i.number }))));
} else if (a === 'issue' && b === 'create') {
  const number = state.issues.length + 1;
  state.issues.push({ number, state: 'open', title: flag('--title'), labels: [flag('--label')], body: flag('--body'), comments: [] });
  process.stdout.write(`https://github.com/o/r/issues/${number}\n`);
} else if (a === 'issue' && b === 'comment') {
  state.issues.find((i) => String(i.number) === args[2]).comments.push(flag('--body'));
} else if (a === 'issue' && b === 'close') {
  state.issues.find((i) => String(i.number) === args[2]).state = 'closed';
} else if (a === 'label' && b === 'create') {
  // no-op
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(' ')}\n`);
  process.exit(1);
}
save();
