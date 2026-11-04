/**
 * Node-side loader for structured content (used by validation scripts, tests,
 * and the SEO Operations Dashboard). Mirrors src/lib/data.ts without Vite.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = join(ROOT, 'src', 'data');
export const PAGES_DIR = join(DATA_DIR, 'pages');
export const DIST_DIR = join(ROOT, 'dist');

const ENTITY_FILES = {
  business: 'business.json',
  services: 'services.json',
  items: 'items.json',
  itemCategories: 'item-categories.json',
  counties: 'counties.json',
  locations: 'locations.json',
  neighborhoods: 'neighborhoods.json',
  keywords: 'keywords.json',
  redirects: 'redirects.json'
};

export function readJson(file) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadPages() {
  const out = [];
  for (const f of readdirSync(PAGES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = join(PAGES_DIR, f);
    if (!existsSync(full)) continue;
    let page;
    try {
      page = readJson(full);
    } catch (err) {
      if (!existsSync(full) || err?.code === 'ENOENT') continue;
      throw err;
    }
    if (`${page.id}.json` !== f) throw new Error(`Page file ${f} contains id "${page.id}" — file name must match id.`);
    out.push(page);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadData() {
  const data = {};
  for (const [key, file] of Object.entries(ENTITY_FILES)) data[key] = readJson(join(DATA_DIR, file));
  data.pages = loadPages();
  return data;
}

export function entityFile(key) {
  return join(DATA_DIR, ENTITY_FILES[key]);
}

export function savePage(page) {
  writeJson(join(PAGES_DIR, `${page.id}.json`), page);
}

export function deletePage(id) {
  const file = join(PAGES_DIR, `${id}.json`);
  if (existsSync(file)) unlinkSync(file);
}

export const ENTITY_KEYS = Object.keys(ENTITY_FILES);
