'use strict';

// A throwaway Postgres cluster for the RLS tests. Starting one costs ~10 s, so
// test/mutate.js starts one for the whole run and hands it to every mutant's
// test process through QA_PG_PORT; a plain `npm test` starts its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

function findPgBin() {
  const cands = [];
  if (process.env.QA_PG_BIN) cands.push(process.env.QA_PG_BIN);
  const pc = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (pc.status === 0) cands.push(pc.stdout.trim());
  for (const base of ['C:/Program Files/PostgreSQL', '/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']) {
    try { for (const v of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, v, 'bin')); } catch { /* not there */ }
  }
  return cands.find((d) => fs.existsSync(path.join(d, `initdb${EXE}`)) && fs.existsSync(path.join(d, `psql${EXE}`)));
}

/** Start a cluster with Supabase's API roles. Throws on failure. Returns { port, data }. */
function startCluster(bin) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rls-pg-'));
  const port = 56000 + Math.floor(Math.random() * 900);
  let r = spawnSync(path.join(bin, `initdb${EXE}`), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('initdb failed');
  // stdio ignored: a server that inherits the caller's pipes keeps it from exiting.
  // Debian/Ubuntu builds put the socket in /var/run/postgresql, which a normal
  // user can't write; keep it in the throwaway data dir (psql uses TCP anyway).
  const socket = process.platform === 'win32' ? '' : ` -c unix_socket_directories='${data}'`;
  const log = path.join(data, 'log.txt');
  r = spawnSync(path.join(bin, `pg_ctl${EXE}`), ['-D', data, '-o', `-p ${port} -c fsync=off -c full_page_writes=off${socket}`, '-l', log, '-w', 'start'], { stdio: 'ignore' });
  if (r.status !== 0) {
    let tailLog = '';
    try { tailLog = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { /* no log written */ }
    throw new Error(`pg_ctl start failed${tailLog ? `:\n${tailLog}` : ''}`);
  }
  r = spawnSync(path.join(bin, `psql${EXE}`), [`postgresql://postgres@127.0.0.1:${port}/postgres`, '-X', '-v', 'ON_ERROR_STOP=1'],
    { input: 'CREATE ROLE anon; CREATE ROLE authenticated;', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`creating the API roles failed: ${r.stderr}`);
  return { port, data };
}

function stopCluster(bin, data) {
  spawnSync(path.join(bin, `pg_ctl${EXE}`), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
  fs.rmSync(data, { recursive: true, force: true });
}

module.exports = { EXE, findPgBin, startCluster, stopCluster };
