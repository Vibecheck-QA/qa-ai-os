'use strict';

// Behaviour tests for scripts/design-check.js: run the real script in real git
// repos and judge it on exit code and output, as the push gate will.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseColor, contrast } = require('../scripts/design-check.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'design-check.js');

function makeRepo(files, design) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-design-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const all = { ...files };
  if (design !== undefined) all['.qa-ai-os.json'] = JSON.stringify({ gates: [], design });
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const run = (dir) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};

const MODES = { light: [':root'], dark: [':root', '.dark'] };

// shadcn-style: bare HSL triplets inside @layer base.
const SHADCN = `@layer base {
  :root { --background: 0 0% 100%; --foreground: 240 10% 3.9%; --muted-foreground: 240 3.8% 46.1%; }
  .dark { --background: 240 10% 3.9%; --foreground: 0 0% 98%; --muted-foreground: 240 5% 64.9%; }
}`;

test('passes when every pair meets AA in every mode (shadcn HSL in @layer base)', () => {
  const dir = makeRepo({ 'app/globals.css': SHADCN }, {
    tokens: { css: 'app/globals.css' }, modes: MODES,
    pairs: [{ text: 'foreground', on: 'background' }, { text: 'muted-foreground', on: 'background' }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /4 contrast checks/);
});

test('fails at the AA boundary and names the pair, mode and ratio', () => {
  const css = ':root { --bg: #ffffff; --ok: #767676; --bad: #777777; }';
  const dir = makeRepo({ 't.css': css }, {
    tokens: { css: 't.css' }, modes: { light: [':root'] },
    pairs: [{ text: 'ok', on: 'bg' }, { text: 'bad', on: 'bg' }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /\[light\] bad on bg: 4\.48:1, needs 4\.5:1/);
  assert.doesNotMatch(r.out, /\bok on bg/);
});

test('dark inherits :root values it does not override, and .dark wins where it does', () => {
  // Dark overrides only the background; foreground stays black → unreadable in dark only.
  const css = ':root { --bg: #fff; --fg: #000; }\n.dark { --bg: #111; }';
  const dir = makeRepo({ 't.css': css }, { tokens: { css: 't.css' }, modes: MODES, pairs: [{ text: 'fg', on: 'bg' }] });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /\[dark\] fg on bg/);
  assert.doesNotMatch(r.out, /\[light\] fg on bg/);
});

test('resolves var() chains and fallbacks', () => {
  const css = ':root { --black: #000; --fg: var(--black); --card-fg: var(--fg); --bg: var(--missing, #fff); }';
  const dir = makeRepo({ 't.css': css }, { tokens: { css: 't.css' }, modes: { light: [':root'] }, pairs: [{ text: 'card-fg', on: 'bg' }] });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.out);
});

test('a mode can be named by a media query path', () => {
  const css = ':root { --bg: #fff; --fg: #111; }\n@media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #222; } }';
  const dir = makeRepo({ 't.css': css }, {
    tokens: { css: 't.css' },
    modes: { light: [':root'], dark: [':root', '@media (prefers-color-scheme: dark) > :root'] },
    pairs: [{ text: 'fg', on: 'bg' }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /\[dark\] fg on bg: 1\.\d\d:1/);
  assert.doesNotMatch(r.out, /\[light\]/);
});

test('opacity on the text is composited over the ground before measuring', () => {
  const css = ':root { --bg: #fff; --fg: #767676; }';
  const dir = makeRepo({ 't.css': css }, { tokens: { css: 't.css' }, modes: { light: [':root'] }, pairs: [{ text: 'fg', on: 'bg', alpha: 0.8 }] });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /at 80% opacity/);
});

for (const [name, css, why] of [
  ['translucent ground', ':root { --bg: rgb(255 255 255 / 50%); --fg: #000; }', /ground is translucent/],
  ['undefined token', ':root { --bg: #fff; }', /--fg is not defined/],
  ['unreadable colour', ':root { --bg: #fff; --fg: color-mix(in srgb, red, blue); }', /can't read colour/],
  ['var() cycle', ':root { --bg: #fff; --fg: var(--x); --x: var(--fg); }', /cycle/],
]) {
  test(`could-not-check is exit 2, never a pass: ${name}`, () => {
    const dir = makeRepo({ 't.css': css }, { tokens: { css: 't.css' }, modes: { light: [':root'] }, pairs: [{ text: 'fg', on: 'bg' }] });
    const r = run(dir);
    assert.strictEqual(r.status, 2, r.out);
    assert.match(r.out, why);
  });
}

// The browser's order: unlayered beats layered whatever the source order, and a
// later-declared layer beats an earlier one ("@layer a, b;" fixes it up front).
// Each case: the unreadable #ccc must be the value that wins, so the check must fail.
const LAYER_CASES = [
  ['unlayered beats a later layer', ':root { --fg: #ccc; }\n@layer base { :root { --fg: #000; } }'],
  ['a later-declared layer beats an earlier one', '@layer a, b;\n@layer b { :root { --fg: #ccc; } }\n@layer a { :root { --fg: #000; } }'],
  ['a layer\'s own rules beat its sublayers', '@layer a { :root { --fg: #ccc; } @layer inner { :root { --fg: #000; } } }'],
  ['layers declared in one file rank rules in another', { 'a.css': '@layer x, y;\n:root { --bg: #fff; }', 'b.css': '@layer y { :root { --fg: #ccc; } }\n@layer x { :root { --fg: #000; } }' }],
  ['anonymous layers in different files stay distinct', { 'a.css': ':root { --bg: #fff; }\n@layer { :root { --fg: #000; } }', 'b.css': '@layer named { :root { --fg: #000; } }\n@layer { :root { --fg: #ccc; } }' }],
];
for (const [name, css] of LAYER_CASES) {
  test(`cascade layers: ${name}`, () => {
    const files = typeof css === 'string' ? { 't.css': `:root { --bg: #fff; }\n${css}` } : css;
    const dir = makeRepo(files, {
      tokens: { css: Object.keys(files) }, modes: { light: [':root'] }, pairs: [{ text: 'fg', on: 'bg' }],
    });
    const r = run(dir);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /\[light\] fg on bg: 1\.61:1/);
  });
}

test('a layered .dark loses to an unlayered :root (same specificity, layer decides)', () => {
  const css = ':root { --bg: #fff; --fg: #000; }\n@layer base { .dark { --bg: #000; } }';
  const dir = makeRepo({ 't.css': css }, { tokens: { css: 't.css' }, modes: MODES, pairs: [{ text: 'fg', on: 'bg' }] });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.out);
});

test('!important on a token is exit 2, not a guess', () => {
  const dir = makeRepo({ 't.css': ':root { --bg: #fff !important; --fg: #000; }' }, {
    tokens: { css: 't.css' }, modes: { light: [':root'] }, pairs: [{ text: 'fg', on: 'bg' }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /!important/);
});

test('a pair with an empty "modes" list is exit 2, not a silent skip', () => {
  const dir = makeRepo({ 't.css': ':root { --bg: #fff; --fg: #000; }', 'c/a.tsx': 'ok' }, {
    tokens: { css: 't.css' }, modes: { light: [':root'] },
    pairs: [{ text: 'fg', on: 'bg', modes: [] }],
    banned: [{ pattern: 'text-gray-400', paths: ['c/**'] }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /"modes" must be a non-empty list/);
});

test('a g or y flag on a banned pattern still finds every line', () => {
  const dir = makeRepo({ 'c/a.tsx': 'text-gray-400\ntext-gray-400\ntext-gray-400' }, {
    banned: [{ pattern: 'text-gray-400', flags: 'gy', paths: ['c/**'] }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  for (const n of [1, 2, 3]) assert.match(r.out, new RegExp(`c/a\\.tsx:${n}:`));
});

test('a mode whose selector matches no block is exit 2', () => {
  const dir = makeRepo({ 't.css': ':root { --bg: #fff; --fg: #000; }' }, {
    tokens: { css: 't.css' }, modes: { light: [':root'], dark: ['.dark'] }, pairs: [{ text: 'fg', on: 'bg' }],
  });
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /mode "dark": no CSS block matches/);
});

test('no design section, or one that checks nothing, is exit 2', () => {
  assert.strictEqual(run(makeRepo({}, undefined)).status, 2);
  const noDesign = makeRepo({ '.qa-ai-os.json': '{"gates":[]}' });
  assert.match(run(noDesign).out, /no "design" section/);
  const empty = run(makeRepo({}, { pairs: [], banned: [] }));
  assert.strictEqual(empty.status, 2, empty.out);
  assert.match(empty.out, /checks nothing/);
});

test('JSON token files work without modes', () => {
  const tokens = { light: { bg: '#ffffff', fg: '#18181b' }, dark: { bg: '#18181b', fg: '#a1a1aa' } };
  const dir = makeRepo({ 'tokens.json': JSON.stringify(tokens) }, { tokens: { json: 'tokens.json' }, pairs: [{ text: 'fg', on: 'bg' }] });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /2 contrast checks/);
});

const BANNED = [{ pattern: '\\btext-gray-[34]00\\b', paths: ['components/**'], why: 'DESIGN.md rule 1: no light grey text' }];

test('banned pattern reports file:line, only inside its paths', () => {
  const dir = makeRepo({
    'components/ui/a.tsx': 'export const A = () => (\n  <p className="p-2">\n    <span className="text-gray-400">hi</span>\n);',
    'docs/notes.md': 'never use text-gray-400',
  }, { banned: BANNED });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /components\/ui\/a\.tsx:3: DESIGN\.md rule 1/);
  assert.doesNotMatch(r.out, /notes\.md/);
});

test('design-allow needs a reason: with one it is reported, without one it still fails', () => {
  const dir = makeRepo({
    'components/a.tsx': '<i className="text-gray-300" /> {/* design-allow: decorative icon on dark hero */}',
    'components/b.tsx': '<i className="text-gray-300" /> {/* design-allow: */}',
  }, { banned: BANNED });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /allowed\s+components\/a\.tsx:1: decorative icon/);
  assert.match(r.out, /FAIL\s+components\/b\.tsx:1/);
  assert.match(r.out, /1 allowed/);
});

test('gitignored files are skipped; untracked ones are checked', () => {
  const dir = makeRepo({
    '.gitignore': 'components/generated/\n',
    'components/generated/x.tsx': 'text-gray-400',
    'components/new.tsx': 'text-gray-400',
  }, { banned: BANNED });
  const r = run(dir);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /components\/new\.tsx:1/);
  assert.doesNotMatch(r.out, /generated/);
});

test('banned paths that match no files are exit 2 (a rule that checks nothing)', () => {
  const dir = makeRepo({ 'src/a.tsx': 'ok' }, { banned: BANNED });
  const r = run(dir);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /match no files/);
});

test('colour formats agree: hex, rgb, hsl, bare triplets, oklch', () => {
  const grey = [
    '#737373', 'rgb(115, 115, 115)', 'rgb(115 115 115 / 1)', '115 115 115',
    'hsl(0 0% 45.1%)', '0 0% 45.1%', 'oklch(0.556 0 0)', 'oklch(55.6% 0 0)',
  ];
  for (const v of grey) {
    const c = parseColor(v);
    assert.ok(c, `parsed ${v}`);
    for (const ch of c.rgb) assert.ok(Math.abs(ch - 115) < 1.5, `${v} → ${c.rgb}`);
    assert.strictEqual(c.a, 1, v);
  }
  assert.strictEqual(parseColor('#0008').a.toFixed(2), '0.53');
  assert.strictEqual(parseColor('rgba(0,0,0,0.5)').a, 0.5);
  assert.strictEqual(parseColor('oklch(1 0 0 / 10%)').a, 0.1);
  assert.strictEqual(parseColor('red-ish'), null);
  assert.strictEqual(contrast([255, 255, 255], [0, 0, 0]).toFixed(1), '21.0');
});
