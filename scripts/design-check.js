#!/usr/bin/env node
// QA AI OS design check: enforces the repo's DESIGN.md with two deterministic
// checks, configured under "design" in .qa-ai-os.json.
//
//   1. Contrast: every declared text/ground token pair meets its WCAG ratio in
//      every mode (light, dark, ...), read from the CSS custom properties or a
//      JSON token file. A value edit fails the moment it's made.
//   2. Banned patterns: regexes that must not appear in the listed files
//      (e.g. light-grey text classes). Reports file:line.
//
// Vendored into the user's repo by /qa-ai-os:design and run as a push gate:
//   { "name": "design", "run": "node scripts/qa-design-check.js" }
// No dependencies. Exit 0 = pass, 1 = a check failed, 2 = could not check
// (bad config, unreadable token, unknown colour). Unknown is never a pass.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- colour parsing ----------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function linearToSrgb(c) {
  c = clamp(c, 0, 1);
  return (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
}

function oklabToRgb(L, A, B) {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function num(tok, pctScale) {
  const m = /^(-?[\d.]+)(%|deg)?$/.exec(tok);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2] === '%' ? v * pctScale / 100 : v;
}

function alphaOf(tok) {
  if (tok === undefined) return 1;
  return num(tok, 1);
}

/** Parse a CSS colour value to { rgb: [0-255 x3], a: 0-1 }, or null if unknown. */
function parseColor(raw) {
  const v = raw.trim().toLowerCase();
  if (v === 'white') return { rgb: [255, 255, 255], a: 1 };
  if (v === 'black') return { rgb: [0, 0, 0], a: 1 };
  if (v === 'transparent') return { rgb: [0, 0, 0], a: 0 };

  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? n(6) / 255 : 1 };
  }

  m = /^(rgba?|hsla?|oklch|oklab)\((.*)\)$/.exec(v);
  const fn = m ? m[1] : 'bare';
  const body = m ? m[2] : v;
  const [main, slashAlpha] = body.split('/').map((s) => s.trim());
  const parts = main.split(/[\s,]+/).filter(Boolean);
  let alphaTok = slashAlpha;
  if (parts.length === 4 && alphaTok === undefined) alphaTok = parts.pop(); // legacy rgba(r, g, b, a)
  if (parts.length !== 3) return null;
  const a = alphaOf(alphaTok);

  let rgb;
  if (fn.startsWith('rgb')) {
    rgb = parts.map((p) => num(p, 255));
  } else if (fn.startsWith('hsl')) {
    rgb = hslToRgb(num(parts[0], 1), num(parts[1], 100), num(parts[2], 100));
  } else if (fn === 'oklch') {
    const L = num(parts[0], 1), C = num(parts[1], 0.4), H = num(parts[2], 1) * Math.PI / 180;
    rgb = oklabToRgb(L, C * Math.cos(H), C * Math.sin(H));
  } else if (fn === 'oklab') {
    rgb = oklabToRgb(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4));
  } else {
    // Bare triplets, as Tailwind/shadcn store them in custom properties:
    // "24 24 27" (RGB) or "240 5.9% 10%" (HSL). The % signs tell them apart.
    if (parts.every((p) => /^[\d.]+$/.test(p))) rgb = parts.map(Number);
    else if (/^[\d.]+(deg)?$/.test(parts[0]) && parts[1].endsWith('%') && parts[2].endsWith('%')) {
      rgb = hslToRgb(num(parts[0], 1), num(parts[1], 100), num(parts[2], 100));
    } else return null;
  }
  if (rgb.some((c) => !Number.isFinite(c)) || !Number.isFinite(a)) return null;
  return { rgb: rgb.map((c) => clamp(c, 0, 255)), a: clamp(a, 0, 1) };
}

function luminance([r, g, b]) {
  const ch = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const composite = (fg, bg, alpha) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

// ---------- token sources ----------

/**
 * Parse CSS into blocks in document order:
 * [{ path: ['@media …', ':root'], layer: ['base'], decls: {name: value}, important: {name: true} }].
 * `layers` records each layer's sublayers in declaration order, which is
 * what ranks them (see layerRank).
 */
function parseCssBlocks(css, layers = new Map()) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const stack = [];
  let buf = '';
  const declare = (parent, dotted) => {
    let cur = parent;
    for (const name of dotted.split('.').map((s) => s.trim()).filter(Boolean)) {
      const key = cur.join('.');
      if (!layers.has(key)) layers.set(key, []);
      if (!layers.get(key).includes(name)) layers.get(key).push(name);
      cur = [...cur, name];
    }
    return cur;
  };
  const curLayer = () => (stack.length ? blocks[stack[stack.length - 1].block].layer : []);
  const flushDecl = () => {
    const stmt = /^\s*@layer\s+([^{]+?)\s*$/.exec(buf); // "@layer a, b;" fixes the order up front
    if (stmt) for (const n of stmt[1].split(',')) declare(curLayer(), n);
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(buf);
    if (m && stack.length) {
      const b = blocks[stack[stack.length - 1].block];
      const important = /\s*!important$/i.test(m[2]);
      b.decls[m[1]] = m[2].replace(/\s*!important$/i, '');
      if (important) b.important[m[1]] = true;
    }
    buf = '';
  };
  for (const ch of css) {
    if (ch === '{') {
      const prelude = buf.trim().replace(/\s+/g, ' ');
      const parent = stack.length ? blocks[stack[stack.length - 1].block] : { path: [], layer: [] };
      // @layer orders the cascade but isn't a context a mode is named by
      // (shadcn wraps :root and .dark in "@layer base"), so it goes in `layer`, not `path`.
      const lm = /^@layer\b\s*(.*)$/.exec(prelude);
      const layer = lm ? declare(parent.layer, lm[1] || `\0anon${layers.anon = (layers.anon || 0) + 1}`) : parent.layer;
      blocks.push({ path: lm ? parent.path : [...parent.path, prelude], layer, decls: {}, important: {} });
      stack.push({ block: blocks.length - 1 });
      buf = '';
    } else if (ch === '}') {
      flushDecl();
      stack.pop();
    } else if (ch === ';') {
      flushDecl();
    } else buf += ch;
  }
  return blocks;
}

/**
 * A layer's cascade rank as a list of positions, compared left to right.
 * Within each level, sublayers rank in declaration order and the level's own
 * unlayered rules (Infinity) beat all of them, so unlayered CSS beats every layer.
 */
function layerRank(layers, layer) {
  const rank = [];
  for (let i = 0; i < layer.length; i++) rank.push(layers.get(layer.slice(0, i).join('.')).indexOf(layer[i]));
  rank.push(Infinity);
  return rank;
}

function compareRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? Infinity, y = b[i] ?? Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Does a block path match a mode spec like "@media (prefers-color-scheme: dark) > :root"? */
function blockMatches(blockPath, spec) {
  const levels = spec.split('>').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  // ">" inside a selector would be ambiguous; specs use " > " between nesting levels only.
  if (levels.length !== blockPath.length) return false;
  return levels.every((lvl, i) => blockPath[i].split(',').map((s) => s.trim()).includes(lvl));
}

function loadModes(design, root) {
  const t = design.tokens || {};
  if (t.json) {
    const data = JSON.parse(fs.readFileSync(path.join(root, t.json), 'utf8'));
    const modes = {};
    for (const [mode, vals] of Object.entries(data)) {
      modes[mode] = {};
      for (const [k, v] of Object.entries(vals)) modes[mode][k.replace(/^--/, '')] = String(v);
    }
    return modes;
  }
  const files = [].concat(t.css || []);
  if (!files.length) throw new Error('design.tokens needs "css" (file or list) or "json"');
  if (!design.modes || !Object.keys(design.modes).length) throw new Error('design.modes is required with CSS tokens, e.g. {"light": [":root"], "dark": [":root", ".dark"]}');
  // One layer registry across files: they load into one cascade, in this order.
  const layers = new Map();
  const blocks = files.flatMap((f) => parseCssBlocks(fs.readFileSync(path.join(root, f), 'utf8'), layers));
  const modes = {};
  for (const [mode, specs] of Object.entries(design.modes)) {
    const hits = [];
    [].concat(specs).forEach((spec, specIdx) => {
      blocks.forEach((b, srcIdx) => {
        if (blockMatches(b.path, spec)) hits.push({ b, specIdx, srcIdx, rank: layerRank(layers, b.layer) });
      });
    });
    if (!hits.length) throw new Error(`mode "${mode}": no CSS block matches ${JSON.stringify(specs)}`);
    // Apply weakest first, so the winner is written last: layer rank first (as
    // the browser does), then the mode's spec order, then source order.
    hits.sort((x, y) => compareRank(x.rank, y.rank) || x.specIdx - y.specIdx || x.srcIdx - y.srcIdx);
    const vals = {};
    for (const { b } of hits) {
      for (const [k, v] of Object.entries(b.decls)) {
        // !important reverses layer order; rather than model it, refuse to guess.
        if (b.important[k]) throw new Error(`mode "${mode}": --${k.slice(2)} uses !important, which this check can't rank; drop it from the token`);
        vals[k.slice(2)] = v;
      }
    }
    modes[mode] = vals;
  }
  return modes;
}

/** Resolve var(--x[, fallback]) chains within one mode. */
function resolve(vals, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`var() cycle at --${name}`);
  seen.add(name);
  const v = vals[name];
  if (v === undefined) return undefined;
  return v.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, ref, fb) => {
    const r = resolve(vals, ref, new Set(seen));
    if (r !== undefined) return r;
    if (fb !== undefined) return fb.trim();
    throw new Error(`--${name} refers to undefined --${ref}`);
  });
}

// ---------- checks ----------

function checkContrast(design, root) {
  const pairs = design.pairs || [];
  if (!pairs.length) return { fails: [], errors: [], checked: 0 };
  const modes = loadModes(design, root);
  const fails = [], errors = [];
  let checked = 0;
  for (const p of pairs) {
    const text = String(p.text).replace(/^--/, '');
    const on = String(p.on).replace(/^--/, '');
    const min = p.min ?? design.minContrast ?? 4.5;
    if (p.modes !== undefined && (!Array.isArray(p.modes) || !p.modes.length)) {
      errors.push(`${text} on ${on}: "modes" must be a non-empty list, or left out to check every mode`);
      continue;
    }
    for (const mode of p.modes || Object.keys(modes)) {
      const label = `[${mode}] ${text} on ${on}`;
      const vals = modes[mode];
      if (!vals) { errors.push(`${label}: no mode "${mode}"`); continue; }
      let tv, gv;
      try { tv = resolve(vals, text); gv = resolve(vals, on); } catch (e) { errors.push(`${label}: ${e.message}`); continue; }
      if (tv === undefined || gv === undefined) {
        errors.push(`${label}: token --${tv === undefined ? text : on} is not defined in this mode`);
        continue;
      }
      const tc = parseColor(tv), gc = parseColor(gv);
      if (!tc || !gc) { errors.push(`${label}: can't read colour "${!tc ? tv : gv}"`); continue; }
      if (gc.a < 1) {
        errors.push(`${label}: the ground is translucent, so its contrast depends on what's behind it; pair the text with an opaque ground`);
        continue;
      }
      const alpha = tc.a * (p.alpha ?? 1);
      const ratio = contrast(composite(tc.rgb, gc.rgb, alpha), gc.rgb);
      checked++;
      if (ratio + 1e-9 < min) fails.push(`${label}: ${ratio.toFixed(2)}:1, needs ${min}:1${alpha < 1 ? ` (at ${Math.round(alpha * 100)}% opacity)` : ''}`);
    }
  }
  return { fails, errors, checked };
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function listFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

function checkBanned(design, root) {
  const rules = design.banned || [];
  if (!rules.length) return { fails: [], errors: [], allowed: [], checked: 0 };
  const files = listFiles(root);
  const fails = [], errors = [], allowed = [];
  let checked = 0;
  for (const rule of rules) {
    let re;
    // Drop g/y: they make test() resume from lastIndex, skipping matches on later lines.
    try { re = new RegExp(rule.pattern, (rule.flags || '').replace(/[gy]/g, '')); } catch (e) { errors.push(`banned ${JSON.stringify(rule.pattern)}: bad regex (${e.message})`); continue; }
    const globs = [].concat(rule.paths || []);
    if (!globs.length) { errors.push(`banned ${JSON.stringify(rule.pattern)}: needs "paths"`); continue; }
    const inc = globs.map(globToRegex);
    const exc = [].concat(rule.exclude || []).map(globToRegex);
    const targets = files.filter((f) => inc.some((g) => g.test(f)) && !exc.some((g) => g.test(f)));
    if (!targets.length) { errors.push(`banned ${JSON.stringify(rule.pattern)}: "paths" match no files, so it checks nothing`); continue; }
    checked++;
    for (const f of targets) {
      let text;
      try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // deleted but still listed
      text.split(/\r?\n/).forEach((line, i) => {
        if (!re.test(line)) return;
        // A reason is words, not the comment closer that follows the tag.
        const m = /design-allow:(.*)$/.exec(line);
        const reason = m ? m[1].replace(/(\*\/|-->|[}){\s])+$/, '').trim() : '';
        if (/\w{2,}/.test(reason)) { allowed.push(`${f}:${i + 1}: ${reason}`); return; }
        fails.push(`${f}:${i + 1}: ${rule.why || `matches ${rule.pattern}`}`);
      });
    }
  }
  return { fails, errors, allowed, checked };
}

function findRoot(start) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : start;
}

function main() {
  const root = findRoot(process.cwd());
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, '.qa-ai-os.json'), 'utf8'));
  } catch (e) {
    console.error(`design check: can't read .qa-ai-os.json (${e.message})`);
    return 2;
  }
  const design = config.design;
  if (!design) { console.error('design check: .qa-ai-os.json has no "design" section; run /qa-ai-os:design'); return 2; }

  let c, b;
  try {
    c = checkContrast(design, root);
    b = checkBanned(design, root);
  } catch (e) {
    console.error(`design check: ${e.message}`);
    return 2;
  }
  const errors = [...c.errors, ...b.errors];
  const fails = [...c.fails, ...b.fails];
  for (const a of b.allowed) console.log(`allowed  ${a}`);
  for (const e of errors) console.error(`UNKNOWN  ${e}`);
  for (const f of fails) console.error(`FAIL     ${f}`);
  if (c.checked + b.checked === 0 && !errors.length) {
    console.error('design check: no pairs or banned patterns configured, so it checks nothing');
    return 2;
  }
  console.log(`design check: ${c.checked} contrast checks, ${b.checked} banned patterns, ${fails.length} failures, ${errors.length} unknown, ${b.allowed.length} allowed`);
  if (errors.length) return 2;
  return fails.length ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { parseColor, contrast, parseCssBlocks, blockMatches, globToRegex };
