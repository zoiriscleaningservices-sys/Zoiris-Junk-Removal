/**
 * Site-wide SEO audit over page records. Used by `npm run validate:content`
 * and by the SEO Operations Dashboard.
 */
import type { PageRecord, SiteData } from './types.ts';
import { buildShingleIndex, evaluatePage, isBuilt, isIndexable, type QualityReport } from './page-quality.ts';
import { normalizeKeyword } from './format.ts';
import { orphanPages } from './internal-links.ts';

export interface AuditIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  pageId?: string;
  message: string;
}

export interface SiteAudit {
  generatedAt: string;
  reports: Record<string, QualityReport>;
  indexable: string[];
  issues: AuditIssue[];
  counts: Record<string, number>;
}

export function auditSite(data: SiteData, now = new Date()): SiteAudit {
  const shingleIndex = buildShingleIndex(data.pages);
  const reports: Record<string, QualityReport> = {};
  const issues: AuditIssue[] = [];
  for (const page of data.pages) reports[page.id] = evaluatePage(page, { data, shingleIndex });

  const indexable = data.pages.filter((p) => isIndexable(p, reports[p.id])).map((p) => p.id);

  // Published pages failing the gate are hard errors: they must be fixed or demoted.
  for (const page of data.pages) {
    const r = reports[page.id];
    if (page.status === 'published' && !r.passesGate) {
      for (const b of r.blockers) issues.push({ level: 'error', code: `gate:${b.id}`, pageId: page.id, message: `${b.label}${b.detail ? ' — ' + b.detail : ''}` });
    }
    if (isBuilt(page)) {
      for (const w of r.warnings) issues.push({ level: 'warning', code: `quality:${w.id}`, pageId: page.id, message: `${w.label}${w.detail ? ' — ' + w.detail : ''}` });
    }
  }

  // Duplicate ids / paths
  const seenIds = new Map<string, number>();
  data.pages.forEach((p) => seenIds.set(p.id, (seenIds.get(p.id) ?? 0) + 1));
  for (const [id, n] of seenIds) if (n > 1) issues.push({ level: 'error', code: 'duplicate-id', pageId: id, message: `Page id used ${n} times.` });

  // Keyword map consistency
  const pageById = new Map(data.pages.map((p) => [p.id, p]));
  const primaryByKeyword = new Map<string, string[]>();
  for (const k of data.keywords) {
    if (k.targetPageId && !pageById.has(k.targetPageId)) issues.push({ level: 'error', code: 'keyword-target', message: `Keyword "${k.keyword}" targets unknown page ${k.targetPageId}.` });
    if (k.role === 'primary' && k.targetPageId) {
      const key = normalizeKeyword(k.keyword);
      primaryByKeyword.set(key, [...(primaryByKeyword.get(key) ?? []), k.targetPageId]);
    }
  }
  for (const [kw, ids] of primaryByKeyword) {
    const unique = [...new Set(ids)];
    if (unique.length > 1) issues.push({ level: 'error', code: 'keyword-cannibalization', message: `Primary keyword "${kw}" is assigned to ${unique.join(', ')}.` });
  }
  for (const p of data.pages.filter(isBuilt)) {
    const k = data.keywords.find((x) => x.role === 'primary' && x.targetPageId === p.id);
    if (!k && p.type !== 'core') issues.push({ level: 'info', code: 'keyword-unmapped', pageId: p.id, message: 'No primary keyword record in the keyword map.' });
    else if (k && normalizeKeyword(k.keyword) !== normalizeKeyword(p.seo.primaryKeyword)) {
      issues.push({ level: 'warning', code: 'keyword-mismatch', pageId: p.id, message: `Keyword map says "${k.keyword}" but page targets "${p.seo.primaryKeyword}".` });
    }
  }

  // Entity consistency
  for (const s of data.services) {
    if (s.pageId && !pageById.has(s.pageId)) issues.push({ level: 'warning', code: 'service-page-missing', message: `Service ${s.id} points to missing page ${s.pageId}.` });
    if (s.pageId && s.verification !== 'confirmed' && s.verification !== 'category-confirmed') {
      const pg = pageById.get(s.pageId);
      if (pg && isBuilt(pg)) issues.push({ level: 'error', code: 'unverified-service-live', pageId: pg.id, message: `Service ${s.id} is ${s.verification} but its page is live.` });
    }
  }
  for (const c of data.counties ?? []) {
    const pg = c.pageId ? pageById.get(c.pageId) : undefined;
    if (pg && isBuilt(pg) && c.coverage === 'research-only') {
      issues.push({ level: 'error', code: 'research-county-live', pageId: pg.id, message: `County ${c.name} is research-only and must not be live.` });
    }
  }
  for (const l of data.locations) {
    const pg = l.pageId ? pageById.get(l.pageId) : undefined;
    if (pg && isBuilt(pg) && l.coverage !== 'active') issues.push({ level: 'error', code: 'unsupported-location', pageId: pg.id, message: `Location ${l.name} is ${l.coverage} but its page is live.` });
  }
  for (const n of data.neighborhoods) {
    const pg = n.pageId ? pageById.get(n.pageId) : undefined;
    if (pg && isBuilt(pg) && (n.coverage !== 'active' || n.localEvidence.length < 2)) {
      issues.push({ level: 'error', code: 'unsupported-neighborhood', pageId: pg.id, message: `Neighborhood ${n.name} lacks active coverage or local evidence.` });
    }
  }
  for (const i of data.items) {
    if (i.pageId && !pageById.has(i.pageId)) issues.push({ level: 'warning', code: 'item-page-missing', message: `Item ${i.id} points to missing page ${i.pageId}.` });
    if (i.acceptance === 'unknown') issues.push({ level: 'info', code: 'item-unknown', message: `Item "${i.name}" acceptance needs owner confirmation.` });
  }

  // Redirects
  const paths = new Set(data.pages.filter(isBuilt).map((p) => p.path));
  for (const r of data.redirects) {
    if (paths.has(r.from)) issues.push({ level: 'error', code: 'redirect-shadow', message: `Redirect source ${r.from} is also a live page.` });
    if (!paths.has(r.to) && !/^https?:/.test(r.to)) issues.push({ level: 'error', code: 'redirect-target', message: `Redirect ${r.from} → ${r.to} points to a page that is not live.` });
    const chained = data.redirects.find((x) => x.from === r.to);
    if (chained) issues.push({ level: 'warning', code: 'redirect-chain', message: `Redirect chain ${r.from} → ${r.to} → ${chained.to}.` });
  }

  // Orphans
  for (const p of orphanPages(data)) issues.push({ level: 'error', code: 'orphan', pageId: p.id, message: 'Built page has no inbound internal links.' });

  // Business data sanity
  const b = data.business;
  if (b.phoneDisplay !== '251-930-8621' || b.phoneE164 !== '+12519308621' || b.phoneHref !== 'tel:+12519308621') {
    issues.push({ level: 'error', code: 'business-phone', message: 'Business phone configuration does not match 251-930-8621 / tel:+12519308621.' });
  }
  if (b.address && /123|main st|example|placeholder/i.test(JSON.stringify(b.address))) issues.push({ level: 'error', code: 'placeholder-address', message: 'Address looks like a placeholder.' });
  if (!b.websiteVerified) issues.push({ level: 'info', code: 'domain-unverified', message: `Production domain ${b.website} has not been confirmed by the owner.` });

  const count = (fn: (p: PageRecord) => boolean) => data.pages.filter(fn).length;
  const counts: Record<string, number> = {
    total: data.pages.length,
    published: count((p) => p.status === 'published'),
    noindexStatus: count((p) => p.status === 'noindex'),
    built: count(isBuilt),
    indexable: indexable.length,
    draft: count((p) => p.status === 'draft'),
    needsReview: count((p) => p.status === 'needs-review'),
    approved: count((p) => p.status === 'approved'),
    idea: count((p) => p.status === 'idea'),
    research: count((p) => p.status === 'research'),
    archived: count((p) => p.status === 'archived'),
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length
  };
  for (const t of ['core', 'service', 'ewaste', 'item', 'county', 'location', 'neighborhood', 'combo', 'article']) counts[`type:${t}`] = count((p) => p.type === t);

  return { generatedAt: now.toISOString(), reports, indexable, issues, counts };
}
