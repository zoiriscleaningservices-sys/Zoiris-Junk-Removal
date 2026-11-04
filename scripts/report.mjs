#!/usr/bin/env node
/**
 * report — writes docs/reports/site-report.md summarizing routes, indexability,
 * inventory, and outstanding owner-verification items. Generated page records
 * are reported separately from actually published, indexable pages.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT, DIST_DIR, loadData } from './lib/load-data.mjs';
import { auditSite } from '../src/lib/audit.ts';

const data = loadData();
const audit = auditSite(data);
const byId = new Map(data.pages.map((p) => [p.id, p]));
const indexable = audit.indexable.map((id) => byId.get(id)).sort((a, b) => a.path.localeCompare(b.path));
const built = data.pages.filter((p) => ['published', 'noindex'].includes(p.status));

const redirectFroms = new Set(data.redirects.map((r) => r.from));
let distRoutes = [];
let distRedirectStubs = 0;
if (existsSync(DIST_DIR)) {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const allHtml = walk(DIST_DIR).filter((f) => f.endsWith('.html')).map((f) => {
    const rel = '/' + relative(DIST_DIR, f).split(sep).join('/');
    return rel === '/404.html' ? '/404/' : rel.replace(/index\.html$/, '');
  });
  distRoutes = allHtml.filter((r) => !redirectFroms.has(r));
  distRedirectStubs = allHtml.filter((r) => redirectFroms.has(r)).length;
}

const lines = [];
const L = (s = '') => lines.push(s);
L('# Zoiris Junk Removal — Site Report');
L();
L(`Generated ${new Date().toISOString()} by \`npm run report\`.`);
L();
L('## Totals');
L();
L('| Measure | Count |');
L('|---|---|');
L(`| Page records (all statuses) | ${data.pages.length} |`);
L(`| Page HTML documents in dist (incl. 404, excl. redirects) | ${distRoutes.length || 'build not run'} |`);
L(`| Static redirect stubs in dist + _redirects | ${distRedirectStubs} |`);
L(`| Built page records (published + noindex) | ${built.length} |`);
L(`| **Indexable pages (in sitemap)** | **${indexable.length}** |`);
for (const s of ['noindex', 'approved', 'needs-review', 'draft', 'research', 'idea', 'archived']) L(`| Records in "${s}" | ${data.pages.filter((p) => p.status === s).length} |`);
L(`| Content gate errors | ${audit.counts.errors} |`);
L(`| Warnings | ${audit.counts.warnings} |`);
L();
L('## Indexable pages by type');
L();
for (const t of ['core', 'county', 'location', 'neighborhood', 'service', 'ewaste', 'item', 'combo', 'article']) {
  const list = indexable.filter((p) => p.type === t);
  L(`### ${t} (${list.length})`);
  L();
  list.forEach((p) => L(`- \`${p.path}\` — ${p.seo.h1} (score ${audit.reports[p.id].score})`));
  L();
}
L('## Not published (pipeline)');
L();
L('| Record | Path | Status | Why not published |');
L('|---|---|---|---|');
for (const p of data.pages.filter((x) => !audit.indexable.includes(x.id))) {
  const r = audit.reports[p.id];
  L(`| ${p.id} | \`${p.path}\` | ${p.status} | ${(r.blockers.map((b) => b.label).join('; ') || p.workflow.reviewNotes || '').replace(/\|/g, '/')} |`);
}
L();
L('## Inventory');
L();
L(`- Counties: ${(data.counties || []).length} records (${(data.counties || []).map((c) => `${c.name}: ${c.coverage}`).join(', ')}).`);
L(`- Services: ${data.services.length} records — ${data.services.filter((s) => s.verification === 'confirmed').length} confirmed, ${data.services.filter((s) => s.verification === 'category-confirmed').length} category-confirmed, ${data.services.filter((s) => s.verification === 'unverified').length} unverified.`);
L(`- Items: ${data.items.length} — ${['accepted', 'accepted-after-confirmation', 'quantity-limited', 'special-handling', 'not-accepted', 'unknown'].map((a) => `${a}: ${data.items.filter((i) => i.acceptance === a).length}`).join(', ')}.`);
L(`- Locations (municipalities & communities): ${data.locations.length} — active: ${data.locations.filter((l) => l.coverage === 'active').map((l) => l.name).join(', ') || 'none'}; research-only: ${data.locations.filter((l) => l.coverage === 'research-only').length}; Mobile County: ${data.locations.filter((l) => l.countyId === 'mobile-county-al').length}; Baldwin County: ${data.locations.filter((l) => l.countyId === 'baldwin-county-al').length}.`);
L(`- Neighborhoods & local areas: ${data.neighborhoods.length} — active: ${data.neighborhoods.filter((n) => n.coverage === 'active').length}; published pages: ${data.pages.filter((p) => p.type === 'neighborhood' && audit.indexable.includes(p.id)).length}.`);
L(`- Keywords: ${data.keywords.length} (${data.keywords.filter((k) => k.role === 'primary').length} primary). Volume/CPC: not populated (no verified data source connected).`);
L(`- Redirects: ${data.redirects.length}.`);
L();
L('## Outstanding owner verification');
L();
L('### Business');
data.business.ownerVerification.forEach((f) => L(`- ${f}`));
L();
L('### Unknown item acceptance');
data.items.filter((i) => i.acceptance === 'unknown').forEach((i) => L(`- ${i.name}`));
L();
L('### Per-page facts');
for (const p of built.filter((x) => x.workflow.ownerVerification?.length)) {
  L(`- **${p.path}**`);
  p.workflow.ownerVerification.forEach((f) => L(`  - ${f}`));
}
mkdirSync(join(ROOT, 'docs', 'reports'), { recursive: true });
const out = join(ROOT, 'docs', 'reports', 'site-report.md');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`Report written: ${relative(ROOT, out)} — ${indexable.length} indexable of ${data.pages.length} records.`);
