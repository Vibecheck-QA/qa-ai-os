#!/usr/bin/env node
// QA AI OS push gate (PreToolUse on Bash).
//
// Blocks `git push` unless every gate command in the repo's .qa-ai-os.json
// passes against the commit being pushed. The gate RUNS the checks itself and
// judges their real exit codes: a recorded "tests passed" can't be trusted,
// because `npm test | grep FAIL && git push` reports success when tests fail.
//
// Only a PASS is cached (keyed by repo + HEAD sha + gate config), so a failure
// is never remembered as "seen" and always re-runs.
//
// Every pass leaves a receipt: .qa-ai-os/receipts/<sha>.json with each command,
// its exit code, how long it took and the tail of its output. A pass is only
// trusted from the cache while its receipt exists, and a pass whose receipt
// can't be written blocks: "done" comes with proof or not at all.
//
// No .qa-ai-os.json => no gate (repos opt in). Any internal error => block
// (fail closed); hooks.json also sets onFailure: "block".

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { TIMEOUT_MARK } = require('./run-timed.js');
const { testCounts } = require('./test-counts.js');
const { diffCoverage } = require('./diff-coverage.js');

const CONFIG_FILE = '.qa-ai-os.json';
const OUTPUT_TAIL_LINES = 25;
const RECEIPT_DIR = path.join('.qa-ai-os', 'receipts');
const MUTATE_BACKUP = path.join('.qa-ai-os', 'mutate-backup');

// Gates that ship with the plugin: `{ "builtin": "mutate" }` runs this plugin's
// own script, so a repo never has to know where the plugin is installed.
const BUILTINS = { mutate: path.join(__dirname, 'mutate.js') };

// The command a gate runs, or null when the gate names nothing runnable.
function gateCommand(gate) {
  if (gate && gate.builtin !== undefined) {
    const script = BUILTINS[gate.builtin];
    return script ? `"${process.execPath}" "${script}"` : null;
  }
  return gate && typeof gate.run === 'string' && gate.run ? gate.run : null;
}

// "changedLines": { "lcov": "coverage/lcov.info", "include": ["src/"], "exclude"?, "min"?, "base"? }
function validChangedLines(s) {
  const str = (v) => typeof v === 'string' && v.length > 0;
  return Boolean(s) && typeof s === 'object' && str(s.lcov)
    && Array.isArray(s.include) && s.include.length > 0 && s.include.every(str)
    && (s.exclude === undefined || (Array.isArray(s.exclude) && s.exclude.every(str)))
    && (s.min === undefined || (typeof s.min === 'number' && s.min >= 0 && s.min <= 100))
    && (s.base === undefined || str(s.base));
}

// Split a shell command into simple segments on ; && || | and newlines.
function segments(cmd) {
  return cmd.split(/\|\||&&|[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

// Returns { push: boolean, dir: string|null } for a Bash command string.
// Handles `git push`, `git -C dir push`, `git -c k=v push`, env prefixes, and
// pushes chained after other commands. `--dry-run` and `--help` are not pushes.
function detectPush(cmd) {
  for (const seg of segments(cmd || '')) {
    const tokens = seg.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // FOO=bar
    if (!/^(git|git\.exe)$/.test(tokens[i] || '')) continue;
    i++;
    let dir = null;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const flag = tokens[i];
      if (flag === '-C') { dir = (tokens[i + 1] || '').replace(/^["']|["']$/g, ''); i += 2; continue; }
      if (flag === '-c' || flag === '--git-dir' || flag === '--work-tree') { i += 2; continue; }
      i++;
    }
    if (tokens[i] !== 'push') continue;
    const rest = tokens.slice(i + 1);
    if (rest.includes('--dry-run') || rest.includes('-n') || rest.includes('--help') || rest.includes('-h')) continue;
    return { push: true, dir };
  }
  return { push: false, dir: null };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

function tail(text, n) {
  const lines = (text || '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// True only if the receipt on disk is a pass for this exact commit and gate
// config (switching configs and back must not reuse another config's receipt).
function receiptVouches(file, sha, configHash) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return r.result === 'pass' && r.commit === sha && r.config === configHash;
  } catch { return false; }
}

// Pure decision function: returns { allow: true } or { allow: false, reason }.
function evaluate({ command, cwd, dataDir }) {
  const { push, dir } = detectPush(command);
  if (!push) return { allow: true };

  const workDir = dir ? path.resolve(cwd, dir) : cwd;
  const root = git(['rev-parse', '--show-toplevel'], workDir);
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return { allow: true };

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const gates = Array.isArray(config.gates) ? config.gates : [];
  if (gates.length === 0) return { allow: true };

  // A mutation run that was killed may have left a file broken on purpose; never
  // push (or test) until it is put back.
  if (fs.existsSync(path.join(root, MUTATE_BACKUP))) {
    return {
      allow: false,
      reason:
        `QA AI OS push gate: a mutation run was interrupted and its backup is still in ${MUTATE_BACKUP}, so a file may still be broken on purpose.\n` +
        'Run the mutation gate again (it puts the files back first), check `git diff`, then push.',
    };
  }

  const isCount = (v) => v === undefined || (Number.isInteger(v) && v >= 0);
  const badLimit = gates.find((g) => g && (!isCount(g.minTests) || !isCount(g.maxSkipped)));
  if (badLimit) {
    return { allow: false, reason: `QA AI OS push gate: gate ${JSON.stringify(badLimit)}: "minTests" and "maxSkipped" must be whole numbers, 0 or more. Push blocked.` };
  }
  const badCoverage = gates.find((g) => g && g.changedLines !== undefined && !validChangedLines(g.changedLines));
  if (badCoverage) {
    return { allow: false, reason: `QA AI OS push gate: gate ${JSON.stringify(badCoverage)}: "changedLines" needs "lcov" (the coverage file the run writes) and "include" (a list of source folders); "min" is 0-100. Push blocked.` };
  }
  const unrunnable = gates.find((g) => !gateCommand(g));
  if (unrunnable) {
    return { allow: false, reason: `QA AI OS push gate: gate ${JSON.stringify(unrunnable)} has no "run" command or a known "builtin" (${Object.keys(BUILTINS).join(', ')}). Push blocked.` };
  }

  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty && !config.allowDirty) {
    return {
      allow: false,
      reason:
        'QA AI OS push gate: you have uncommitted changes, so the checks would run on code you are not pushing.\n' +
        'Commit or stash them, then push again. (Set "allowDirty": true in .qa-ai-os.json to skip this.)',
    };
  }

  const sha = git(['rev-parse', 'HEAD'], root);
  const configHash = crypto.createHash('sha256').update(JSON.stringify(gates)).digest('hex').slice(0, 12);
  const cacheKey = `${root}::${sha}::${configHash}`;
  const cacheFile = dataDir ? path.join(dataDir, 'push-gate-passes.json') : null;
  const cache = cacheFile ? loadCache(cacheFile) : {};
  const receiptFile = path.join(root, RECEIPT_DIR, `${sha}.json`);
  if (cache[cacheKey] && receiptVouches(receiptFile, sha, configHash)) return { allow: true, cached: true };

  const ranAt = new Date().toISOString();
  const ran = [];
  for (const gate of gates) {
    const cmd = gateCommand(gate);
    const name = gate.name || gate.run || gate.builtin;
    const timeoutMs = (gate.timeoutSeconds || 300) * 1000;
    // A coverage file left from an earlier run would vouch for code this run never ran.
    if (gate.changedLines) {
      try { fs.rmSync(path.resolve(root, gate.changedLines.lcov), { force: true }); } catch (err) {
        return { allow: false, reason: `QA AI OS push gate: couldn't clear the old coverage file ${gate.changedLines.lcov} before "${name}" (${err.message}). Push blocked.` };
      }
    }
    const started = Date.now();
    // run-timed.js kills the whole tree on timeout; spawnSync's own timeout leaves the command running.
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run-timed.js'), String(timeoutMs), cmd],
      { cwd: root, encoding: 'utf8', timeout: timeoutMs + 30000 });
    const output = `${r.stdout || ''}\n${r.stderr || ''}`;
    const timedOut = (r.status === 124 && (r.stderr || '').includes(TIMEOUT_MARK)) || Boolean(r.error && r.error.code === 'ETIMEDOUT');
    const counts = testCounts(output);
    ran.push({ name, run: gate.builtin ? `builtin:${gate.builtin}` : gate.run, exit: r.status, ms: Date.now() - started, ...(counts ? { tests: counts } : {}), output: tail(output, OUTPUT_TAIL_LINES) });
    if (timedOut) {
      return { allow: false, reason: `QA AI OS push gate: "${name}" timed out after ${timeoutMs / 1000}s. Push blocked.` };
    }
    if (r.status !== 0) {
      return {
        allow: false,
        reason:
          `QA AI OS push gate: "${name}" failed (exit ${r.status}). Push blocked.\n` +
          `Command: ${gate.builtin ? `builtin:${gate.builtin}` : gate.run}\nLast ${OUTPUT_TAIL_LINES} lines:\n${tail(output, OUTPUT_TAIL_LINES)}`,
      };
    }
    // Exit 0 can't tell "12 passed" from "0 ran" or "18 files skipped": the summary can.
    if (gate.minTests !== undefined || gate.maxSkipped !== undefined) {
      if (!counts) {
        return { allow: false, reason: `QA AI OS push gate: "${name}" exited 0, but its output has no test summary QA AI OS can read, so "minTests"/"maxSkipped" can't be checked. Push blocked: unknown is never a pass.` };
      }
      if (gate.minTests !== undefined && counts.passed < gate.minTests) {
        return { allow: false, reason: `QA AI OS push gate: "${name}" exited 0 with only ${counts.passed} passing tests (minimum ${gate.minTests}). Tests that didn't run didn't pass. Push blocked.` };
      }
      if (gate.maxSkipped !== undefined && counts.skipped > gate.maxSkipped) {
        return { allow: false, reason: `QA AI OS push gate: "${name}" skipped ${counts.skipped} tests (allowed ${gate.maxSkipped}). Push blocked.` };
      }
    }
    // Passing tests prove the tests pass, not that they ran the change.
    if (gate.changedLines) {
      const cov = diffCoverage(root, gate.changedLines, { worktree: Boolean(dirty) });
      if (cov.error) {
        return { allow: false, reason: `QA AI OS push gate: "${name}" passed, but QA AI OS can't tell whether it ran the changed lines: ${cov.error} Push blocked: unknown is never covered.` };
      }
      const min = gate.changedLines.min === undefined ? 100 : gate.changedLines.min;
      ran[ran.length - 1].changedLines = { base: cov.base, covered: cov.covered, total: cov.total, min };
      if (cov.covered * 100 < min * cov.total) {
        const list = cov.files.slice(0, 20).map((f) => (f.neverLoaded
          ? `  ${f.file}: no test loaded this file (lines ${f.lines})`
          : `  ${f.file}: ${f.lines}`)).join('\n');
        const more = cov.files.length > 20 ? `\n  ...and ${cov.files.length - 20} more files` : '';
        return {
          allow: false,
          reason:
            `QA AI OS push gate: "${name}" passed, but ${cov.total - cov.covered} of ${cov.total} changed lines never ran in any test ` +
            `(${cov.percent}%, minimum ${min}%; changes since ${cov.base}). Push blocked.\n${list}${more}\n` +
            "Write tests that run these lines, then push again. If a file above was tested, its path in the coverage file may not match the repo's.",
        };
      }
    }
  }

  // Every gate succeeded: write the receipt, then remember the pass.
  // dirty: allowDirty let uncommitted changes in, so the gates ran on more than
  // the commit; the receipt says so rather than vouching for the commit alone.
  const receipt = { receipt: 'qa-ai-os push gate', result: 'pass', commit: sha, config: configHash, dirty: Boolean(dirty), ranAt, gates: ran };
  try {
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt, null, 2) + '\n');
    fs.renameSync(`${receiptFile}.tmp`, receiptFile);
  } catch (err) {
    return {
      allow: false,
      reason:
        `QA AI OS push gate: every gate passed, but the receipt could not be written to ${path.join(RECEIPT_DIR, `${sha}.json`)} (${err.message}).\n` +
        'Push blocked: a pass has to come with its receipt.',
    };
  }

  if (cacheFile) {
    cache[cacheKey] = new Date().toISOString();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  }
  return { allow: true };
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`QA AI OS push gate: could not read hook input (${err.message}). Push blocked.\n`);
    process.exit(2);
  }
  const command = (input.tool_input && input.tool_input.command) || '';
  if (!detectPush(command).push) process.exit(0); // fast path: nothing below can throw for non-pushes

  try {
    const result = evaluate({ command, cwd: input.cwd || process.cwd(), dataDir: process.env.CLAUDE_PLUGIN_DATA });
    if (result.allow) process.exit(0);
    process.stderr.write(result.reason + '\n');
    process.exit(2);
  } catch (err) {
    process.stderr.write(`QA AI OS push gate: internal error (${err.message}). Push blocked (fail closed).\n`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { detectPush, evaluate, segments };
