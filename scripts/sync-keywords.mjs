#!/usr/bin/env node
/**
 * sync-keywords — keeps src/data/keywords.json aligned with page records.
 *
 * - Adds a primary keyword record for every page's seo.primaryKeyword, and
 *   secondary records for seo.secondaryKeywords.
 * - Preserves manual fields (volume, cpc, competition, performance, notes,
 *   priority) on existing records — nothing is fabricated: volume/CPC stay null
 *   until imported from a real tool or Search Console.
 * - Adds research-sourced question keywords (docs/research/market-research.md §6).
 * - Never deletes manual records; reports orphans instead.
 */
import { loadData, entityFile, writeJson } from './lib/load-data.mjs';
import { normalizeKeyword, slugify } from '../src/lib/format.ts';

const TODAY = new Date().toISOString().slice(0, 10);
const data = loadData();
const existing = new Map(data.keywords.map((k) => [`${normalizeKeyword(k.keyword)}|${k.targetPageId ?? ''}`, k]));
const out = [];
const seen = new Set();

const intentToConversion = { transactional: 'high', local: 'high', commercial: 'medium', navigational: 'medium', informational: 'low' };

function upsert(rec) {
  const key = `${normalizeKeyword(rec.keyword)}|${rec.targetPageId ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  const prev = existing.get(key);
  out.push(
    prev
      ? { ...rec, ...pickManual(prev), id: prev.id }
      : rec
  );
}

function pickManual(k) {
  const o = {};
  for (const f of ['volume', 'cpc', 'competition', 'performance', 'notes', 'priority', 'source', 'researchedAt', 'entities']) if (k[f] !== undefined && k[f] !== null && !(Array.isArray(k[f]) && !k[f].length)) o[f] = k[f];
  return o;
}

function locationRelevance(kw) {
  const n = normalizeKeyword(kw);
  if (/near me/.test(n)) return 'near-me';
  if (/\bmobile\b/.test(n)) return 'mobile-al';
  return 'none';
}

function entitiesFor(page) {
  const e = [];
  if (page.refs.serviceId) e.push(`service:${page.refs.serviceId}`);
  (page.refs.itemIds ?? []).forEach((i) => e.push(`item:${i}`));
  if (page.refs.locationId) e.push(`location:${page.refs.locationId}`);
  if (page.refs.neighborhoodId) e.push(`neighborhood:${page.refs.neighborhoodId}`);
  return e;
}

const SOURCE_PAGE = 'Editorial keyword mapping from page record (seed list: project brief; intent research: docs/research/market-research.md §6)';

for (const page of data.pages) {
  if (page.status === 'archived') continue;
  const live = page.status === 'published' || page.status === 'noindex';
  upsert({
    id: `kw-${slugify(page.seo.primaryKeyword)}`,
    keyword: page.seo.primaryKeyword,
    intent: page.seo.intent,
    role: 'primary',
    targetPageId: page.id,
    priority: page.type === 'core' ? 'low' : live ? (page.seo.intent === 'transactional' ? 'high' : 'medium') : 'low',
    locationRelevance: locationRelevance(page.seo.primaryKeyword),
    conversionPotential: intentToConversion[page.seo.intent] ?? 'medium',
    entities: entitiesFor(page),
    volume: null,
    cpc: null,
    competition: null,
    performance: null,
    source: SOURCE_PAGE,
    researchedAt: TODAY,
    notes: live ? '' : `Target page is in "${page.status}" status.`
  });
  for (const s of page.seo.secondaryKeywords ?? []) {
    upsert({
      id: `kw-${slugify(s)}-${slugify(page.id)}`.slice(0, 90),
      keyword: s,
      intent: /^(how|what|who|where|can|do|does|is|are|why|when)\b/i.test(s) ? 'informational' : page.seo.intent,
      role: 'secondary',
      targetPageId: page.id,
      priority: 'medium',
      locationRelevance: locationRelevance(s),
      conversionPotential: /^(how|what|who|where|why|when)\b/i.test(s) ? 'low' : intentToConversion[page.seo.intent] ?? 'medium',
      entities: entitiesFor(page),
      volume: null,
      cpc: null,
      competition: null,
      performance: null,
      source: SOURCE_PAGE,
      researchedAt: TODAY,
      notes: ''
    });
  }
}

// Research-sourced question keywords and brief seed terms not owned as a primary/secondary yet.
const RESEARCH = [
  ['how do I get rid of an old couch', 'svc-furniture-removal'],
  ['who picks up old appliances', 'svc-appliance-removal'],
  ['how do I dispose of an old computer', 'guide-prepare-computer-for-recycling'],
  ['can someone pick up old electronics', 'ew-electronics-pickup'],
  ['how do I get rid of old televisions', 'guide-get-rid-of-old-tv-mobile'],
  ['where can I recycle old computers', 'ew-computer-recycling'],
  ['who removes furniture from a house', 'svc-furniture-removal'],
  ['how do I clear out a garage', 'guide-garage-cleanout-prep'],
  ['who removes office furniture', 'svc-office-cleanouts'],
  ['how do I dispose of unwanted electronics', 'ew-electronics-pickup'],
  ['can junk removal companies pick up heavy items', 'svc-bulk-item-pickup'],
  ['does the City of Mobile pick up furniture', 'guide-old-furniture-mobile'],
  ['will the City of Mobile pick up a refrigerator', 'item-refrigerator-removal'],
  ['where can I drop off electronics in Mobile', 'guide-electronics-drop-off-mobile'],
  ['how much does junk removal cost in Mobile', 'core-pricing'],
  ['how do I dispose of lithium-ion batteries in Mobile', 'guide-old-batteries-safety'],
  ['how do I wipe my phone before recycling it', 'ew-phone-tablet-pickup'],
  ['what can junk removal companies not take', 'core-restricted-items'],
  ['who removes debris after a contractor job', 'svc-construction-debris-removal'],
  ['junk removal near me', 'svc-junk-removal-mobile-al'],
  ['electronics removal near me', 'ew-electronics-pickup'],
  ['e-waste pickup Mobile AL', 'ew-electronics-pickup'],
  ['electronics recycling Mobile AL', 'ew-electronics-pickup']
];
const SOURCE_RESEARCH = 'Project brief seed list + docs/research/market-research.md §6 (question-style queries; no volume data available)';
for (const [kw, target] of RESEARCH) {
  const page = data.pages.find((p) => p.id === target);
  if (!page) continue;
  const already = out.find((k) => normalizeKeyword(k.keyword) === normalizeKeyword(kw));
  if (already) continue;
  upsert({
    id: `kw-${slugify(kw)}`,
    keyword: kw,
    intent: /^(how|what|who|where|can|do|does|will|is|are|why|when)\b/i.test(kw) ? 'informational' : 'transactional',
    role: 'secondary',
    targetPageId: target,
    priority: 'medium',
    locationRelevance: locationRelevance(kw),
    conversionPotential: /^(can|who|will)\b/i.test(kw) ? 'medium' : /^(how|what|where)\b/i.test(kw) ? 'low' : 'high',
    entities: entitiesFor(page),
    volume: null,
    cpc: null,
    competition: null,
    performance: null,
    source: SOURCE_RESEARCH,
    researchedAt: TODAY,
    notes: ''
  });
}

// Keep manual records that no longer match a page (reported, never deleted).
const orphans = data.keywords.filter((k) => !seen.has(`${normalizeKeyword(k.keyword)}|${k.targetPageId ?? ''}`));
out.push(...orphans);

out.sort((a, b) => (a.targetPageId ?? '~').localeCompare(b.targetPageId ?? '~') || (a.role === b.role ? a.keyword.localeCompare(b.keyword) : a.role === 'primary' ? -1 : 1));
writeJson(entityFile('keywords'), out);

// Secondary keyword collisions across different pages = potential cannibalization.
const bySecondary = new Map();
for (const k of out) {
  const n = normalizeKeyword(k.keyword);
  bySecondary.set(n, [...new Set([...(bySecondary.get(n) ?? []), k.targetPageId])]);
}
const collisions = [...bySecondary].filter(([, ids]) => ids.length > 1);
console.log(`keywords.json: ${out.length} records (${out.filter((k) => k.role === 'primary').length} primary).`);
if (orphans.length) console.log(`Preserved ${orphans.length} manual/orphan records.`);
if (collisions.length) {
  console.log('Keywords targeted by more than one page (review for cannibalization):');
  for (const [kw, ids] of collisions) console.log(`  "${kw}" → ${ids.join(', ')}`);
}
