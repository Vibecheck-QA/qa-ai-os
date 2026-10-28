#!/usr/bin/env node
// QA AI OS mutation runner: proves your tests can fail.
//
// Reads .qa-ai-os/mutants.json:
//   { "run": "npm test", "timeoutSeconds": 300,
//     "mutants": [ { "name": "...", "file": "src/x.ts", "find": "...", "replace": "...", "run": "optional narrower command" } ] }
//
// For each mutant: break the code one way, run its tests, require them to FAIL,
// restore from a byte copy. Every rule here exists because breaking it faked a
// result: a red baseline "catches" everything, a find that didn't land fakes a
// verdict, a hang tells you nothing, a restore by reversing the edit can drift.
//
// Exit 0 = every mutant killed; 1 = a mutant survived; 2 = couldn't check
// (no config, red baseline, a find that doesn't match exactly once, a timeout,
// a failed restore). Unknown is never a pass.
//
// Before each mutation the original bytes are saved to .qa-ai-os/mutate-backup/.
// A run that was killed mid-mutation is put back at the start of the next run,
// and the push gate refuses to push while a backup is waiting.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TIMEOUT_MARK } = require('./run-timed.js');

const CONFIG = path.join('.qa-ai-os', 'mutants.json');
const BACKUP = path.join('.qa-ai-os', 'mutate-backup');

const isStr = (v) => typeof v === 'string' && v.length > 0;

function loadConfig(root) {
  const file = path.join(root, CONFIG);
  if (!fs.existsSync(file)) throw new Error(`no ${CONFIG}: list the mutants first (/qa-ai-os:mutate writes it)`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${CONFIG} is not valid JSON (${err.message})`); }
  if (!cfg || !Array.isArray(cfg.mutants) || cfg.mutants.length === 0) throw new Error(`${CONFIG} has no "mutants"`);
  cfg.mutants.forEach((m, i) => {
    const bad = !m || !isStr(m.name) || !isStr(m.file) || !isStr(m.find) || typeof m.replace !== 'string' || (m.run !== undefined && !isStr(m.run));
    if (bad) throw new Error(`${CONFIG}: mutants[${i}] needs "name", "file", "find" and "replace" strings`);
    if (!isStr(m.run) && !isStr(cfg.run)) throw new Error(`${CONFIG}: mutants[${i}] has no "run" and there is no top-level "run"`);
    if (m.find === m.replace) throw new Error(`${CONFIG}: mutants[${i}] ("${m.name}") replaces "find" with itself`);
  });
  return cfg;
}

// Put back any file a killed run left mutated. Returns the files restored.
function recover(root) {
  const dir = path.join(root, BACKUP);
  if (!fs.existsSync(dir)) return [];
  const restored = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(dir, p);
        fs.writeFileSync(path.join(root, rel), fs.readFileSync(p));
        restored.push(rel);
      }
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return restored;
}

// Through run-timed.js: a hung test is killed with everything it started,
// never left spinning after we give up on it.
function run(cmd, root, timeoutMs) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run-timed.js'), String(timeoutMs), cmd],
    { cwd: root, encoding: 'utf8', timeout: timeoutMs + 30000 });
  if (r.status === 124 && (r.stderr || '').includes(TIMEOUT_MARK)) return 'timeout';
  if (r.error) return 'timeout'; // the helper itself hung: no verdict
  return r.status;
}

const count = (text, find) => text.split(find).length - 1;

function main(root) {
  const restored = recover(root);
  if (restored.length) console.log(`Put back ${restored.length} file(s) an interrupted run left mutated: ${restored.join(', ')}`);

  const cfg = loadConfig(root);
  const timeoutMs = (cfg.timeoutSeconds || 300) * 1000;
  const cmdFor = (m) => m.run || cfg.run;

  // A red baseline reports every mutant as "killed". Each command must pass untouched.
  for (const cmd of new Set(cfg.mutants.map(cmdFor))) {
    const status = run(cmd, root, timeoutMs);
    if (status !== 0) {
      console.log(`Baseline is not green: \`${cmd}\` ${status === 'timeout' ? 'timed out' : `exited ${status}`} before any mutation. Fix the tests first.`);
      return 2;
    }
  }

  const results = [];
  for (const m of cfg.mutants) {
    const target = path.join(root, m.file);
    if (!fs.existsSync(target)) { results.push([m, 'missing', 'file not found']); continue; }
    const original = fs.readFileSync(target);
    const text = original.toString('utf8');
    const crlf = text.includes('\r\n');
    const find = crlf ? m.find.replace(/\r?\n/g, '\r\n') : m.find;
    const replace = crlf ? m.replace.replace(/\r?\n/g, '\r\n') : m.replace;
    const n = count(text, find);
    if (n !== 1) { results.push([m, 'missing', n === 0 ? '"find" matched nothing' : `"find" matched ${n} times`]); continue; }

    const backup = path.join(root, BACKUP, m.file);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, original);
    fs.writeFileSync(target, text.replace(find, () => replace));
    // A mutation that didn't land is a fake verdict; prove it applied.
    if (fs.readFileSync(target).equals(original)) throw new Error(`mutant did not apply: ${m.name}`);

    const status = run(cmdFor(m), root, timeoutMs);

    fs.writeFileSync(target, original); // from the byte copy, never by reversing the edit
    if (!fs.readFileSync(target).equals(original)) {
      console.log(`RESTORE FAILED: ${m.file} differs from the original. The copy is in ${path.join(BACKUP, m.file)}.`);
      return 2;
    }
    fs.rmSync(backup);

    if (status === 'timeout') results.push([m, 'timeout', 'tests timed out: no verdict']);
    else results.push([m, status !== 0 ? 'killed' : 'survived', '']);
  }
  fs.rmSync(path.join(root, BACKUP), { recursive: true, force: true });

  const label = { killed: 'killed  ', survived: 'SURVIVED', missing: '?       ', timeout: '?       ' };
  for (const [m, r, why] of results) console.log(`${label[r]}  ${m.name} (${m.file})${why ? `: ${why}` : ''}`);
  const survived = results.filter(([, r]) => r === 'survived').length;
  const unknown = results.filter(([, r]) => r === 'missing' || r === 'timeout').length;
  const killed = results.length - survived - unknown;
  console.log(`\n${killed} of ${results.length} mutants killed` +
    (survived ? `, ${survived} survived (a test that can't catch that break)` : '') +
    (unknown ? `, ${unknown} couldn't be checked` : '') + '.');
  if (survived) return 1;
  return unknown ? 2 : 0;
}

if (require.main === module) {
  const root = process.cwd();
  let code;
  try { code = main(root); } catch (err) {
    recover(root);
    console.log(`QA AI OS mutate: ${err.message}`);
    code = 2;
  }
  process.exit(code);
}

module.exports = { main, recover, BACKUP };
