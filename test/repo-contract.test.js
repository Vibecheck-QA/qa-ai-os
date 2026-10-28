'use strict';

// Structural checks on the plugin itself: manifests agree, every gate and
// skill exists, and AGENTS.md hasn't drifted from rules/QUALITY.md.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { render, BEGIN, END } = require('../scripts/sync-agents.js');
const tmpDir = require('./tmp.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('test files make temp folders only through test/tmp.js (which deletes them)', () => {
  const call = ['mkdtemp', 'Sync('].join(''); // spelled apart so this file doesn't match itself
  const offenders = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js') && read(`test/${f}`).includes(call));
  assert.deepStrictEqual(offenders, []);
});

test('test/tmp.js deletes its folders when the test file finishes', () => {
  const out = path.join(tmpDir('qa-contract-'), 'made.txt');
  const file = `${out}.test.js`;
  fs.writeFileSync(file, [
    `const tmpDir = require(${JSON.stringify(path.join(ROOT, 'test', 'tmp.js'))});`,
    "const fs = require('fs');",
    "const path = require('path');",
    "require('node:test')('makes a folder with a git-style read-only file', () => {",
    "  const d = tmpDir('qa-contract-made-');",
    "  fs.mkdirSync(path.join(d, '.git', 'objects'), { recursive: true });",
    "  const obj = path.join(d, '.git', 'objects', 'ab');",
    "  fs.writeFileSync(obj, 'x'); fs.chmodSync(obj, 0o444);",
    `  fs.writeFileSync(${JSON.stringify(out)}, d);`,
    '});',
  ].join('\n'));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const made = fs.readFileSync(out, 'utf8');
  assert.ok(made.includes('qa-contract-made-'), made);
  assert.strictEqual(fs.existsSync(made), false, `${made} was left behind`);
});

test('AGENTS.md is in sync with rules/QUALITY.md', () => {
  const r = spawnSync(process.execPath, ['scripts/sync-agents.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('sync-agents replaces only the marked block and keeps user content', () => {
  const agents = `# Mine\n\nkeep this\n\n${BEGIN}\n\nold rules\n\n${END}\n\nand this\n`;
  const out = render(agents, 'new rules');
  assert.match(out, /keep this/);
  assert.match(out, /and this/);
  assert.match(out, /new rules/);
  assert.doesNotMatch(out, /old rules/);
  assert.strictEqual(out.split(BEGIN).length - 1, 1);
});

test('sync-agents appends the block when markers are absent', () => {
  const out = render('# Mine\n', 'rules');
  assert.ok(out.startsWith('# Mine'));
  assert.ok(out.includes(BEGIN) && out.includes(END));
});

test('plugin.json and package.json versions match', () => {
  assert.strictEqual(JSON.parse(read('.claude-plugin/plugin.json')).version, JSON.parse(read('package.json')).version);
});

test('marketplace entry name matches the plugin name', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.deepStrictEqual(market.plugins.map((p) => p.name), [plugin.name]);
});

test('hooks.json points at a script that exists', () => {
  const hooks = JSON.parse(read('hooks/hooks.json'));
  const entries = hooks.hooks.PreToolUse.flatMap((m) => m.hooks);
  assert.ok(entries.length > 0);
  for (const h of entries) {
    for (const arg of h.args || []) {
      const rel = arg.replace('${CLAUDE_PLUGIN_ROOT}/', '');
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
    assert.strictEqual(h.onFailure, 'block', 'push gate must fail closed');
  }
});

test('every lifecycle stage has a gate file listed in gates/README.md', () => {
  const stages = ['idea', 'validate', 'spec', 'build', 'review', 'ship', 'operate', 'grow', 'sunset'];
  const readme = read('gates/README.md');
  for (const s of stages) {
    assert.ok(fs.existsSync(path.join(ROOT, 'gates', `${s}.md`)), `gates/${s}.md missing`);
    assert.ok(readme.includes(`\`${s}.md\``), `gates/README.md does not list ${s}.md`);
  }
});

test('every skill has SKILL.md with a description', () => {
  const skills = fs.readdirSync(path.join(ROOT, 'skills'));
  assert.ok(skills.length >= 4);
  for (const s of skills) {
    const md = read(`skills/${s}/SKILL.md`);
    assert.match(md, /^---\r?\n[\s\S]*?\ndescription: .+\r?\n[\s\S]*?---/, `skills/${s} frontmatter`);
  }
});

test('every file a skill references by plugin path exists', () => {
  for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) {
    for (const f of fs.readdirSync(path.join(ROOT, 'skills', s)).filter((f) => f.endsWith('.md'))) {
      const md = read(`skills/${s}/${f}`);
      for (const m of md.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.(?:md|js))/g)) {
        assert.ok(fs.existsSync(path.join(ROOT, m[1])), `skills/${s}/${f} references missing ${m[1]}`);
      }
    }
  }
});
