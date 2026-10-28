#!/usr/bin/env node
// QA AI OS recommended stack: the setup a live Next.js app runs on, with
// stricter defaults. Used by /qa-ai-os:init.
//
//   node stack.js plan  [--dir <repo>]   what it would add (JSON), changes nothing
//   node stack.js apply [--dir <repo>]   adds what's missing, prints the same JSON
//
// It never overwrites: a file that exists is kept, a script with the same name
// is kept (and reported if it differs), and a layer whose tool is already
// installed (Jest, Cypress, ...) is skipped whole. It doesn't install packages:
// the result names the install command for the user to approve.

'use strict';

const fs = require('fs');
const path = require('path');

const STACKS = path.join(__dirname, '..', 'stacks');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return { name: 'pnpm', add: 'pnpm add -D' };
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return { name: 'yarn', add: 'yarn add -D' };
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return { name: 'bun', add: 'bun add -d' };
  return { name: 'npm', add: 'npm install -D' };
}

// "22.15.0" >= "22.13.0"
function atLeast(version, floor) {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

// The source folders unit tests should cover: the ones that exist.
function sourceDirs(dir, candidates) {
  return candidates.filter((d) => fs.existsSync(path.join(dir, d)) && fs.statSync(path.join(dir, d)).isDirectory());
}

function plan(dir) {
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) return { stack: null, reason: 'no package.json' };
  const pkg = readJson(pkgFile);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack = readJson(path.join(STACKS, 'nextjs', 'stack.json'));
  if (!deps[stack.detect]) return { stack: null, reason: `no "${stack.detect}" dependency: use the generic path` };

  const dirs = sourceDirs(dir, stack.sourceDirs);
  const out = {
    stack: stack.name,
    // Vitest 5 and jsdom 29 refuse older Node; say so before installing, not after.
    node: { required: `>=${stack.node}`, current: process.versions.node, ok: atLeast(process.versions.node, stack.node) },
    packageManager: packageManager(dir).name,
    layers: {},
    install: null,
    files: { add: [], keep: [] },
    scripts: { add: {}, keep: [] },
    gitignore: [],
    coverageInclude: dirs,
    gates: [],
  };
  const ignore = fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/) : [];
  const scripts = pkg.scripts || {};
  const installs = {};

  for (const [name, layer] of Object.entries(stack.layers)) {
    const have = layer.existing.find((d) => deps[d]);
    if (have) { out.layers[name] = `keep: ${have}`; continue; }
    out.layers[name] = 'add';
    Object.assign(installs, layer.devDependencies);
    for (const f of layer.files) (fs.existsSync(path.join(dir, f)) ? out.files.keep : out.files.add).push(f);
    for (const [s, cmd] of Object.entries(layer.scripts)) {
      if (scripts[s] === undefined) out.scripts.add[s] = cmd;
      else if (scripts[s] !== cmd) out.scripts.keep.push({ name: s, yours: scripts[s], ours: cmd });
    }
    for (const line of layer.gitignore) if (!ignore.includes(line)) out.gitignore.push(line);
  }

  const specs = Object.entries(installs).filter(([d]) => !deps[d]).map(([d, v]) => `${d}@${v}`);
  if (specs.length) out.install = `${packageManager(dir).add} ${specs.join(' ')}`;

  // Proposed gates, by the script names this stack uses. A kept script with a
  // different command still runs under the same name.
  const has = (s) => scripts[s] !== undefined || out.scripts.add[s] !== undefined;
  if (has('typecheck')) out.gates.push({ name: 'types', run: 'npm run typecheck', timeoutSeconds: 180 });
  if (out.layers.unit === 'add') {
    out.gates.push({
      name: 'tests', run: 'npm run test:coverage', timeoutSeconds: 300,
      ...(dirs.length ? { changedLines: { lcov: 'coverage/lcov.info', include: dirs.map((d) => `${d}/`) } } : {}),
    });
  }
  if (out.layers.e2e === 'add') out.gates.push({ name: 'smoke', run: 'npm run test:smoke', timeoutSeconds: 420, minTests: 1 });
  return out;
}

function apply(dir) {
  const out = plan(dir);
  if (!out.stack) return out;
  const src = path.join(STACKS, out.stack, 'files');
  for (const f of out.files.add) {
    let text = fs.readFileSync(path.join(src, f), 'utf8');
    const globs = out.coverageInclude.length ? out.coverageInclude.map((d) => `${d}/**`) : ['**/*.{ts,tsx}'];
    text = text.replace('__COVERAGE_INCLUDE__', `[${globs.map((g) => JSON.stringify(g)).join(', ')}]`);
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text, { flag: 'wx' }); // wx: never overwrite, even in a race
  }
  if (Object.keys(out.scripts.add).length) {
    const pkgFile = path.join(dir, 'package.json');
    const raw = fs.readFileSync(pkgFile, 'utf8');
    const pkg = JSON.parse(raw);
    pkg.scripts = { ...pkg.scripts, ...out.scripts.add };
    const indent = (/^\{\r?\n([ \t]+)"/.exec(raw) || [, '  '])[1];
    const nl = raw.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, indent).replace(/\n/g, nl) + nl);
  }
  if (out.gitignore.length) {
    const file = path.join(dir, '.gitignore');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, `${before}${sep}${out.gitignore.join('\n')}\n`);
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf('--dir');
  const dir = path.resolve(i >= 0 ? rest[i + 1] : '.');
  if (cmd !== 'plan' && cmd !== 'apply') {
    process.stderr.write('usage: stack.js plan|apply [--dir <repo>]\n');
    return 2;
  }
  process.stdout.write(JSON.stringify(cmd === 'plan' ? plan(dir) : apply(dir), null, 2) + '\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { plan, apply, atLeast };
