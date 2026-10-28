'use strict';

// Every temp folder a test makes is deleted when its test file finishes.
// Before this, each run left hundreds behind (34,618 by 2026-10-28). Test
// files must make temp folders through here; repo-contract.test.js checks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

const made = [];

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

module.exports = function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
