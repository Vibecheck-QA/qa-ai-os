#!/usr/bin/env node
// Vendors rules/QUALITY.md into this repo's AGENTS.md between the QA-AI-OS
// markers. `--check` exits 1 if AGENTS.md has drifted (used by the tests).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BEGIN = '<!-- BEGIN QA-AI-OS (generated from rules/QUALITY.md; do not edit here) -->';
const END = '<!-- END QA-AI-OS -->';

function render(agents, rules) {
  const block = `${BEGIN}\n\n${rules.replace(/\r\n/g, '\n').trim()}\n\n${END}`;
  const start = agents.indexOf(BEGIN);
  const end = agents.indexOf(END);
  if (start === -1 || end === -1) return `${agents.trimEnd()}\n\n${block}\n`;
  return agents.slice(0, start) + block + agents.slice(end + END.length);
}

if (require.main === module) {
  const agentsPath = path.join(ROOT, 'AGENTS.md');
  const agents = fs.readFileSync(agentsPath, 'utf8').replace(/\r\n/g, '\n');
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'QUALITY.md'), 'utf8');
  const next = render(agents, rules);
  if (process.argv.includes('--check')) {
    if (next !== agents) {
      console.error('AGENTS.md is out of sync with rules/QUALITY.md. Run: npm run sync-agents');
      process.exit(1);
    }
    process.exit(0);
  }
  fs.writeFileSync(agentsPath, next);
  console.log('AGENTS.md synced.');
}

module.exports = { render, BEGIN, END };
