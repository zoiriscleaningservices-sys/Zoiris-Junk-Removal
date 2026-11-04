#!/usr/bin/env node
/**
 * validate-content — runs the page-quality gate and site-wide SEO audit over
 * the structured content BEFORE the Astro build. Exits 1 on any error so a
 * published page that fails the gate can never be deployed.
 *
 * Flags: --json (machine-readable output), --verbose (include info items)
 */
import { loadData } from './lib/load-data.mjs';
import { auditSite } from '../src/lib/audit.ts';

const args = new Set(process.argv.slice(2));
const data = loadData();
const audit = auditSite(data);

if (args.has('--json')) {
  console.log(JSON.stringify({ counts: audit.counts, issues: audit.issues, indexable: audit.indexable }, null, 2));
  process.exit(audit.counts.errors ? 1 : 0);
}

const c = audit.counts;
const line = (s = '') => console.log(s);
line('Zoiris content validation');
line('─'.repeat(60));
line(`Page records: ${c.total}   built: ${c.built}   indexable: ${c.indexable}`);
line(`published ${c.published} · noindex ${c.noindexStatus} · approved ${c.approved} · needs-review ${c.needsReview} · draft ${c.draft} · research ${c.research} · idea ${c.idea} · archived ${c.archived}`);
line('');

const groups = { error: [], warning: [], info: [] };
for (const i of audit.issues) groups[i.level].push(i);

for (const level of ['error', 'warning', ...(args.has('--verbose') ? ['info'] : [])]) {
  if (!groups[level].length) continue;
  line(`${level.toUpperCase()}S (${groups[level].length})`);
  for (const i of groups[level]) line(`  [${i.code}]${i.pageId ? ' ' + i.pageId + ':' : ''} ${i.message}`);
  line('');
}
if (!args.has('--verbose') && groups.info.length) line(`${groups.info.length} info items hidden (use --verbose).`);

const scores = Object.values(audit.reports)
  .filter((r) => audit.indexable.includes(r.pageId))
  .map((r) => r.score);
if (scores.length) line(`Editorial review score (internal tool, not a ranking signal): avg ${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}, min ${Math.min(...scores)}`);

if (c.errors) {
  line(`\n✖ ${c.errors} error(s). Fix them or move the affected pages out of "published" status.`);
  process.exit(1);
}
line('\n✔ Content gate passed.');
