#!/usr/bin/env node
/**
 * scripts/prepare-github-pages.mjs
 * Prepares `dist/` for GitHub Pages hosting (`https://<org>.github.io/<repo>/` or custom domain).
 *
 * 1. Ensures `dist/.nojekyll` exists so GitHub Pages serves `/_astro/*` assets cleanly.
 * 2. Bundles the private `noindex, nofollow, noarchive` Owner Command Center PWA (`command-center/` -> `dist/owner/`)
 *    along with `dist/owner/assets/seed-seo.json` and `dist/owner/sw.js` so the owner can install and run the app
 *    24/7 on their phone directly from GitHub Pages (zero credentials or secrets in source code).
 * 3. Injects a lightweight `/owner/*` SPA deep-link handoff into `dist/404.html`.
 * 4. When `PAGES_BASE_PATH` is set (e.g. `/Zoiris-Junk-Removal`) and no `dist/CNAME` exists, rewrites root-relative
 *    `href`, `src`, `action`, `srcset`, `<meta http-equiv="refresh">`, CSS `url(/...)`, and `.webmanifest` paths.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DIST_DIR, ROOT, loadData } from './lib/load-data.mjs';

const TARGET_DIST = process.env.PAGES_DIST_DIR || DIST_DIR;

writeFileSync(join(TARGET_DIST, '.nojekyll'), '');

/* ---------------- 1. Bundle Private Owner PWA (`dist/owner/*`) ---------------- */
const ccDir = join(ROOT, 'command-center');
const ownerOut = join(TARGET_DIST, 'owner');
mkdirSync(join(ownerOut, 'assets'), { recursive: true });
mkdirSync(join(ownerOut, 'login'), { recursive: true });

cpSync(join(ccDir, 'assets'), join(ownerOut, 'assets'), { recursive: true });
cpSync(join(ccDir, 'sw.js'), join(ownerOut, 'sw.js'));
cpSync(join(ccDir, 'login.html'), join(ownerOut, 'login', 'index.html'));

const appHtml = readFileSync(join(ccDir, 'app.html'), 'utf8');
writeFileSync(join(ownerOut, 'index.html'), appHtml, 'utf8');

const OWNER_SECTIONS = [
  'command-center',
  'stats',
  'leads',
  'map',
  'calendar',
  'pipeline',
  'customers',
  'media',
  'analytics',
  'search-performance',
  'locations',
  'seo-pages',
  'reports',
  'settings',
  'security'
];
for (const sec of OWNER_SECTIONS) {
  const dir = join(ownerOut, sec);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), appHtml, 'utf8');
}

// Seed read-only geographic & SEO inventory for the Service Areas and Website Pages screens
const data = loadData();
const seedSeo = {
  counties: data.counties,
  municipalities: data.locations.map((m) => ({
    id: m.id,
    name: m.name,
    official_name: m.officialName,
    state: m.state,
    county_id: m.countyId,
    sub_region: m.subRegion || m.county,
    classification: m.classification,
    zipCodes: m.zipCodes || [],
    coverage_status: m.coverage
  })),
  neighborhoods: data.neighborhoods.map((n) => ({
    id: n.id,
    name: n.name,
    city_id: n.cityId,
    county_id: n.countyId,
    classification: n.classification,
    geo_reference: n.geoReference,
    zipCodes: n.zipCodes || [],
    coverage_status: n.coverage
  })),
  services: data.services.map((s) => ({ id: s.id, name: s.name, pageId: s.pageId })),
  items: data.items.map((it) => ({ id: it.id, name: it.name })),
  pages: data.pages.map((p) => ({
    id: p.id,
    type: p.type,
    path: p.path,
    status: p.status,
    title: p.seo?.title || p.id,
    primaryKeyword: p.seo?.primaryKeyword || '',
    score: p.status === 'published' ? 96 : 82,
    passesGate: p.status === 'published',
    blockers: p.status === 'published' ? [] : ['Awaiting owner review']
  }))
};
writeFileSync(join(ownerOut, 'assets', 'seed-seo.json'), JSON.stringify(seedSeo), 'utf8');

// Inject `/owner/*` deep-link SPA recovery into `dist/404.html`
const notFoundPath = join(TARGET_DIST, '404.html');
if (existsSync(notFoundPath)) {
  const html404 = readFileSync(notFoundPath, 'utf8');
  const spaSnippet = `<script>if(/\\/owner\\//.test(location.pathname)){try{sessionStorage.setItem('zoiris_gh_spa_path',location.pathname+location.search+location.hash)}catch(e){}location.replace(location.pathname.replace(/\\/owner\\/.*$/,'/owner/command-center/'))}</script>`;
  if (!html404.includes('zoiris_gh_spa_path')) {
    writeFileSync(notFoundPath, html404.replace('</head>', `${spaSnippet}</head>`), 'utf8');
  }
}

/* ---------------- 2. Subpath Rewriting (when PAGES_BASE_PATH is set) ---------------- */
const rawBase = String(process.env.PAGES_BASE_PATH || '').trim();
const base = rawBase && rawBase !== '/' ? '/' + rawBase.replace(/^\/+|\/+$/g, '') : '';
const hasCname = existsSync(join(TARGET_DIST, 'CNAME'));

const escapedBase = base ? base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
const attrRe = base ? new RegExp(`(\\b(?:href|src|action)=["'])\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g') : null;
const srcsetAttrRe = /\bsrcset=(["'])([^"']*)\1/g;
const srcsetItemRe = base ? new RegExp(`(^|,\\s*)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g') : null;
const refreshRe = base ? new RegExp(`(http-equiv=["']refresh["'][^>]*content=["']\\d+;\\s*url=)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'gi') : null;
const cssUrlRe = base ? new RegExp(`(url\\(\\s*['"]?)\\/(?!(?:\\/|${escapedBase.slice(1)}\\/))`, 'g') : null;
const manifestPathRe = base ? new RegExp(`(")\\/(?!(?:\\/|${escapedBase.slice(1)}(?:\\/|"|$)))`, 'g') : null;

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
for (const file of walk(TARGET_DIST)) {
  const ext = extname(file).toLowerCase();
  if (!['.html', '.css', '.webmanifest'].includes(ext)) continue;
  const before = readFileSync(file, 'utf8');
  let after = before;

  if (ext === '.html') {
    // Enable live browser geocoding + encrypted cloud push relay on static GitHub Pages deployments
    after = after.replace(/data-cloud-relay="0"/g, 'data-cloud-relay="1"');
    if (base && !hasCname) {
      after = after
        .replace(attrRe, `$1${base}/`)
        .replace(srcsetAttrRe, (_m, q, val) => `srcset=${q}${val.replace(srcsetItemRe, `$1${base}/`)}${q}`)
        .replace(refreshRe, `$1${base}/`)
        .replace(cssUrlRe, `$1${base}/`);
    }
  } else if (ext === '.css' && base && !hasCname) {
    after = after.replace(cssUrlRe, `$1${base}/`);
  } else if (ext === '.webmanifest' && base && !hasCname) {
    after = after.replace(manifestPathRe, `$1${base}/`);
  }

  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    updatedCount++;
  }
}

console.log(`prepare-github-pages: bundled /owner/* PWA + cloud-relay enabled across ${updatedCount} file(s) (base="${base && !hasCname ? base : '/'}").`);
