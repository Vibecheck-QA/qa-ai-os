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
// No .qa-ai-os.json => no gate (repos opt in). Any internal error => block
// (fail closed); hooks.json also sets onFailure: "block".

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CONFIG_FILE = '.qa-ai-os.json';
const OUTPUT_TAIL_LINES = 25;

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
  if (cache[cacheKey]) return { allow: true, cached: true };

  for (const gate of gates) {
    const name = gate.name || gate.run;
    const timeoutMs = (gate.timeoutSeconds || 300) * 1000;
    const r = spawnSync(gate.run, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs });
    const output = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { allow: false, reason: `QA AI OS push gate: "${name}" timed out after ${timeoutMs / 1000}s. Push blocked.` };
    }
    if (r.status !== 0) {
      return {
        allow: false,
        reason:
          `QA AI OS push gate: "${name}" failed (exit ${r.status}). Push blocked.\n` +
          `Command: ${gate.run}\nLast ${OUTPUT_TAIL_LINES} lines:\n${tail(output, OUTPUT_TAIL_LINES)}`,
      };
    }
  }

  // Record the pass only after every gate succeeded.
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
