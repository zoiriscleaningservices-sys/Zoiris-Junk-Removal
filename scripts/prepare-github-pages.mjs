#!/usr/bin/env node
/**
 * scripts/prepare-github-pages.mjs
 * Prepares `dist/` for GitHub Pages subpath hosting (e.g. `https://<org>.github.io/<repo>/`).
 *
 * - Ensures `dist/.nojekyll` exists so GitHub Pages serves `/_astro/*` assets cleanly.
 * - If `dist/CNAME` exists or `PAGES_BASE_PATH` is empty/`/`, leaves root-relative URLs untouched.
 * - When `PAGES_BASE_PATH` is set (e.g. `/Zoiris-Junk-Removal`), rewrites root-relative
 *   `href`, `src`, `action`, `srcset`, `<meta http-equiv="refresh">`, CSS `url(/...)`,
 *   and `site.webmanifest` paths inside `dist/` so every page, image, font, and stylesheet
 *   resolves without 404s on GitHub Pages.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DIST_DIR } from './lib/load-data.mjs';

writeFileSync(join(DIST_DIR, '.nojekyll'), '');

const rawBase = String(process.env.PAGES_BASE_PATH || '').trim();
const base = rawBase && rawBase !== '/' ? '/' + rawBase.replace(/^\/+|\/+$/g, '') : '';

if (!base || existsSync(join(DIST_DIR, 'CNAME'))) {
  console.log(`prepare-github-pages: root deployment (base="${base || '/'}"), .nojekyll verified.`);
  process.exit(0);
}

const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const attrRe = new RegExp(`(\\b(?:href|src|action)=["'])\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g');
const srcsetAttrRe = /\bsrcset=(["'])([^"']*)\1/g;
const srcsetItemRe = new RegExp(`(^|,\\s*)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g');
const refreshRe = new RegExp(`(http-equiv=["']refresh["'][^>]*content=["']\\d+;\\s*url=)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'gi');
const cssUrlRe = new RegExp(`(url\\(\\s*['"]?)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g');
const manifestPathRe = new RegExp(`(")\\/(?!(?:\\/|${escapedBase.slice(1)}(?:\\/|"|$)))`, 'g');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let updatedCount = 0;
for (const file of walk(DIST_DIR)) {
  const ext = extname(file).toLowerCase();
  if (!['.html', '.css', '.webmanifest'].includes(ext)) continue;
  const before = readFileSync(file, 'utf8');
  let after = before;

  if (ext === '.html') {
    after = after
      .replace(attrRe, `$1${base}/`)
      .replace(srcsetAttrRe, (_m, q, val) => `srcset=${q}${val.replace(srcsetItemRe, `$1${base}/`)}${q}`)
      .replace(refreshRe, `$1${base}/`)
      .replace(cssUrlRe, `$1${base}/`);
  } else if (ext === '.css') {
    after = after.replace(cssUrlRe, `$1${base}/`);
  } else if (ext === '.webmanifest') {
    after = after.replace(manifestPathRe, `$1${base}/`);
  }

  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    updatedCount++;
  }
}

console.log(`prepare-github-pages: rewrote root-relative asset & route URLs with "${base}" across ${updatedCount} file(s).`);
