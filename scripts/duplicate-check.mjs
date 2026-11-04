#!/usr/bin/env node
/**
 * duplicate-check — finds duplicate titles, descriptions, H1s, primary keywords,
 * canonical paths and near-duplicate copy across ALL non-archived page records
 * (including drafts, so problems are caught before publishing).
 */
import { loadData } from './lib/load-data.mjs';
import { normalizeKeyword } from '../src/lib/format.ts';
import { buildShingleIndex, similarity } from '../src/lib/page-quality.ts';

const data = loadData();
const pages = data.pages.filter((p) => p.status !== 'archived');
let problems = 0;

function dupes(label, keyFn) {
  const map = new Map();
  for (const p of pages) {
    const k = keyFn(p);
    if (!k) continue;
    map.set(k, [...(map.get(k) ?? []), p.id]);
  }
  const hits = [...map].filter(([, ids]) => ids.length > 1);
  console.log(`${hits.length ? '✖' : '✔'} ${label}: ${hits.length} duplicate group(s)`);
  for (const [k, ids] of hits) console.log(`    "${k}" → ${ids.join(', ')}`);
  problems += hits.length;
}

dupes('Canonical paths', (p) => p.path);
dupes('Titles', (p) => p.seo.title.trim().toLowerCase());
dupes('Meta descriptions', (p) => p.seo.description.trim().toLowerCase());
dupes('H1s', (p) => p.seo.h1.trim().toLowerCase());
dupes('Primary keywords', (p) => normalizeKeyword(p.seo.primaryKeyword));

const idx = buildShingleIndex(pages);
const ids = [...idx.keys()];
const pairs = [];
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j], similarity(idx.get(ids[i]), idx.get(ids[j]))]);
pairs.sort((a, b) => b[2] - a[2]);
const near = pairs.filter((p) => p[2] >= 0.2);
console.log(`${near.length ? '✖' : '✔'} Near-duplicate copy (≥20% 5-word shingle overlap): ${near.length}`);
for (const [a, b, v] of near) console.log(`    ${a} ↔ ${b}: ${(v * 100).toFixed(1)}%`);
console.log(`  Highest overlap: ${pairs[0] ? `${pairs[0][0]} ↔ ${pairs[0][1]} ${(pairs[0][2] * 100).toFixed(1)}%` : 'n/a'}`);
problems += near.length;
process.exit(problems ? 1 : 0);
