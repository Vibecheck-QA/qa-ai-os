#!/usr/bin/env node
// Runs a shell command with a time limit and, on timeout, kills the WHOLE
// process tree. Node's own spawnSync timeout only kills the shell: on Windows
// the command under it keeps running forever (a hung test spinning a CPU core)
// and keeps its pipes open.
//
//   node run-timed.js <milliseconds> <command>
//
// Exits with the command's exit code. On timeout: exit 124, with TIMEOUT_MARK
// on stderr so callers can tell a timeout from a command that exits 124.

'use strict';

const { spawn, spawnSync } = require('child_process');

const TIMEOUT_MARK = 'QA-AI-OS-TIMEOUT';

function main() {
  const ms = Number(process.argv[2]);
  const cmd = process.argv[3];
  if (!Number.isFinite(ms) || ms <= 0 || !cmd) {
    process.stderr.write('usage: node run-timed.js <milliseconds> <command>\n');
    process.exit(2);
  }
  const win = process.platform === 'win32';
  // detached on POSIX puts the command in its own process group, so one kill reaches all of it.
  const child = spawn(cmd, { shell: true, stdio: 'inherit', detached: !win });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }, ms);
  child.on('error', (err) => {
    clearTimeout(timer);
    process.stderr.write(`could not start: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (timedOut) {
      process.stderr.write(`${TIMEOUT_MARK}: killed after ${ms / 1000}s\n`);
      process.exit(124);
    }
    process.exit(code === null ? 1 : code);
  });
}

if (require.main === module) main();

module.exports = { TIMEOUT_MARK };
