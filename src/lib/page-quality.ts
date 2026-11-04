/**
 * Page-quality gate and editorial review score.
 *
 * IMPORTANT: the score is an INTERNAL editorial tool for Zoiris editors. It is
 * not a ranking signal and makes no claim about how Google evaluates pages.
 *
 * A page may only be indexable when it has status "published", robotsIndex
 * enabled, an approval record, and zero blocker failures.
 */
import type { PageRecord, PageContent, SiteData } from './types.ts';
import { CANONICAL_PATH_RE, extractLinks, inlineToText, normalizeKeyword, wordCount } from './format.ts';

export type Severity = 'blocker' | 'warning';

export interface QualityCheck {
  id: string;
  label: string;
  pass: boolean;
  severity: Severity;
  weight: number;
  detail?: string;
}

export interface QualityReport {
  pageId: string;
  score: number;
  checks: QualityCheck[];
  blockers: QualityCheck[];
  warnings: QualityCheck[];
  /** True when no blocker check fails. */
  passesGate: boolean;
  wordCount: number;
  maxSimilarity: { pageId: string; value: number } | null;
}

/** Statuses that render a public HTML document. */
export const BUILT_STATUSES = ['published', 'noindex'] as const;
/** Statuses that count as "live or about to be live" for duplicate checks. */
export const LIVE_STATUSES = ['published', 'noindex', 'approved', 'needs-review'] as const;

export const TEMPLATED_TYPES = ['service', 'ewaste', 'item', 'county', 'location', 'neighborhood', 'combo', 'article'] as const;

export function isBuilt(page: PageRecord): boolean {
  return (BUILT_STATUSES as readonly string[]).includes(page.status);
}

export function isTemplated(page: PageRecord): boolean {
  return (TEMPLATED_TYPES as readonly string[]).includes(page.type);
}

/* ------------------------------------------------------------------ */
/* Text extraction                                                     */
/* ------------------------------------------------------------------ */

export function contentStrings(content: PageContent | undefined): string[] {
  if (!content) return [];
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v) out.push(v);
  };
  push(content.lead);
  if (content.quickAnswer) {
    push(content.quickAnswer.question);
    push(content.quickAnswer.answer);
  }
  if (content.includes) {
    push(content.includes.intro);
    content.includes.points.forEach(push);
  }
  if (content.items) {
    push(content.items.intro);
    content.items.list.forEach(push);
  }
  content.audience?.body.forEach(push);
  content.process?.steps.forEach((s) => {
    push(s.title);
    push(s.body);
  });
  if (content.pricingFactors) {
    push(content.pricingFactors.intro);
    content.pricingFactors.factors.forEach(push);
  }
  content.prepare?.tips.forEach(push);
  if (content.restrictions) {
    push(content.restrictions.body);
    content.restrictions.list.forEach(push);
  }
  content.sections?.forEach((s) => {
    push(s.heading);
    s.body.forEach(push);
    s.bullets?.forEach(push);
    s.subsections?.forEach((sub) => {
      push(sub.heading);
      sub.body.forEach(push);
      sub.bullets?.forEach(push);
    });
  });
  content.faqs.forEach((f) => {
    push(f.q);
    push(f.a);
  });
  push(content.areaNote);
  return out;
}

export function pageText(page: PageRecord): string {
  return contentStrings(page.content).map(inlineToText).join(' ');
}

export function pageLinks(page: PageRecord): string[] {
  return contentStrings(page.content).flatMap(extractLinks);
}

function shingles(text: string, size = 5): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(' '));
  return set;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ------------------------------------------------------------------ */
/* Claim screening                                                     */
/* ------------------------------------------------------------------ */

const CLAIM_PATTERNS: { re: RegExp; claim: keyof SiteData['business']['claims'] | 'superlative' | 'pricing' | 'review' }[] = [
  { re: /same[- ]day/i, claim: 'sameDayService' },
  { re: /\b24\/7\b|24 hours a day|around the clock/i, claim: 'emergencyService' },
  { re: /\blicensed\b/i, claim: 'licensed' },
  { re: /\binsured\b/i, claim: 'insured' },
  { re: /\bbonded\b/i, claim: 'bonded' },
  { re: /certified recycl|\bR2\b|e-?stewards|zero[- ]landfill/i, claim: 'certifiedRecycler' },
  { re: /data destruction|secure(ly)? wip|hard[- ]drive shredd|chain[- ]of[- ]custody/i, claim: 'dataDestruction' },
  { re: /#1\b|number one|top[- ]rated|highest[- ]rated|\bbest\b(?! (way|option|to|for you|practice))/i, claim: 'superlative' },
  { re: /\$\s?\d|free estimate|discount|% off/i, claim: 'pricing' },
  { re: /\b\d(\.\d)? stars?\b|\breviews? from\b|\btestimonial/i, claim: 'review' }
];

const NEGATION_RE = /\b(not|never|no|don['’]t|doesn['’]t|do not|does not|cannot|can['’]t|without|isn['’]t|aren['’]t|won['’]t|unless|nor)\b[^.]{0,60}$/i;

export function screenClaims(text: string, claims: SiteData['business']['claims']): string[] {
  const findings: string[] = [];
  for (const { re, claim } of CLAIM_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(global)) {
      const idx = m.index ?? 0;
      const before = text.slice(Math.max(0, idx - 80), idx);
      const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '));
      const clause = sentenceStart >= 0 ? before.slice(sentenceStart + 2) : before;
      if (NEGATION_RE.test(clause)) continue;
      // Negation later in the same sentence ("Data destruction ... are not offered").
      const after = text.slice(idx + m[0].length, idx + m[0].length + 90);
      const sentenceEnd = after.search(/[.?!](\s|$)/);
      const tail = sentenceEnd >= 0 ? after.slice(0, sentenceEnd) : after;
      if (AFTER_NEGATION_RE.test(tail)) continue;
      // Reference to a third party, not a Zoiris claim ("a provider that offers ...").
      if (THIRD_PARTY_RE.test(clause)) continue;
      if (claim in claims && claims[claim as keyof typeof claims]) continue;
      findings.push(`${claim}: "…${text.slice(Math.max(0, idx - 30), idx + m[0].length + 30).trim()}…"`);
    }
  }
  return findings;
}

const AFTER_NEGATION_RE = /\b(is|are|was|were)\s+not\b|\bnot\s+(offered|provided|included|available|something we)\b|\bwe\s+(do not|don['’]t|never)\b|\bisn['’]t\b|\baren['’]t\b/i;
const THIRD_PARTY_RE = /\b(a|an|another|specialized|separate|dedicated|third[- ]party)\s+(provider|company|vendor|service|firm|specialist|recycler|business)\b[^.]{0,40}$/i;

const OTHER_PHONE_RE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

/* ------------------------------------------------------------------ */
/* Gate                                                                */
/* ------------------------------------------------------------------ */

export interface QualityContext {
  data: SiteData;
  /** Precomputed shingles per page id (templated pages only). */
  shingleIndex?: Map<string, Set<string>>;
}

export function buildShingleIndex(pages: PageRecord[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of pages) if (isTemplated(p) && p.content && p.status !== 'archived') map.set(p.id, shingles(pageText(p)));
  return map;
}

export function evaluatePage(page: PageRecord, ctx: QualityContext): QualityReport {
  const { data } = ctx;
  const checks: QualityCheck[] = [];
  const add = (c: QualityCheck) => checks.push(c);
  const templated = isTemplated(page);
  const text = pageText(page);
  const words = wordCount(text);
  const others = data.pages.filter((p) => p.id !== page.id && p.status !== 'archived');
  const liveOthers = others.filter((p) => (LIVE_STATUSES as readonly string[]).includes(p.status));
  const pageIds = new Map(data.pages.map((p) => [p.id, p]));
  const pathIndex = new Map(data.pages.map((p) => [p.path, p]));

  // 1. Distinct primary search intent
  const kw = normalizeKeyword(page.seo.primaryKeyword || '');
  const kwConflicts = liveOthers.filter((p) => normalizeKeyword(p.seo.primaryKeyword || '') === kw && kw);
  add({
    id: 'intent',
    label: 'Distinct primary search intent',
    severity: 'blocker',
    weight: 10,
    pass: !!kw && !!page.seo.intent && page.purpose.trim().length >= 40,
    detail: !kw ? 'Missing primary keyword.' : page.purpose.trim().length < 40 ? 'Purpose statement is missing or too short.' : undefined
  });
  add({
    id: 'cannibalization',
    label: 'No competing page targets the same primary keyword',
    severity: 'blocker',
    weight: 8,
    pass: kwConflicts.length === 0,
    detail: kwConflicts.length ? `Also targeted by: ${kwConflicts.map((p) => p.id).join(', ')}` : undefined
  });

  // 2-3. Purpose + accurate availability
  let availability = { pass: true, detail: '' };
  const svc = page.refs.serviceId ? data.services.find((s) => s.id === page.refs.serviceId) : undefined;
  const county = page.refs.countyId ? data.counties?.find((c) => c.id === page.refs.countyId) : undefined;
  const loc = page.refs.locationId ? data.locations.find((l) => l.id === page.refs.locationId) : undefined;
  const nb = page.refs.neighborhoodId ? data.neighborhoods.find((n) => n.id === page.refs.neighborhoodId) : undefined;
  const svcOk = (s = svc) => !!s && (s.verification === 'confirmed' || s.verification === 'category-confirmed');
  if (page.type === 'service' || page.type === 'ewaste' || page.type === 'item') {
    if (!svcOk()) availability = { pass: false, detail: svc ? `Service "${svc.id}" is ${svc.verification}.` : 'No verified service reference.' };
    else if (loc && loc.coverage !== 'active') availability = { pass: false, detail: `Location coverage for ${loc.name} is ${loc.coverage}.` };
  } else if (page.type === 'county') {
    if (!county || (county.coverage !== 'active' && county.coverage !== 'limited')) {
      availability = { pass: false, detail: `County coverage is ${county?.coverage ?? 'missing'} — owner must activate coverage before publishing.` };
    }
  } else if (page.type === 'location') {
    if (!loc || loc.coverage !== 'active') availability = { pass: false, detail: `Location coverage is ${loc?.coverage ?? 'missing'} — owner must approve active service coverage.` };
  } else if (page.type === 'neighborhood') {
    if (!nb || nb.coverage !== 'active') availability = { pass: false, detail: `Neighborhood coverage is ${nb?.coverage ?? 'missing'}.` };
    else if (nb.localEvidence.length < 2) availability = { pass: false, detail: 'Needs at least 2 pieces of first-party local evidence (real jobs, photos, access notes).' };
  } else if (page.type === 'combo') {
    if (!svcOk()) availability = { pass: false, detail: 'Service is not verified.' };
    else if (nb) {
      if (nb.coverage !== 'active' || nb.localEvidence.length < 2) availability = { pass: false, detail: 'Neighborhood lacks active coverage or first-party local evidence.' };
    } else if (!loc || loc.coverage !== 'active') availability = { pass: false, detail: `Location coverage is ${loc?.coverage ?? 'missing'}.` };
  }
  add({ id: 'availability', label: 'Service / coverage verified', severity: 'blocker', weight: 12, pass: availability.pass, detail: availability.detail || undefined });

  // 4-5. Useful, original content
  if (templated) {
    const minWords = page.type === 'article' ? 500 : 300;
    const leadWords = wordCount(inlineToText(page.content?.lead ?? ''));
    add({
      id: 'content',
      label: 'Useful, complete page content',
      severity: 'blocker',
      weight: 12,
      pass: !!page.content && leadWords >= 25 && words >= minWords,
      detail: !page.content ? 'No content yet.' : `${words} words (editorial floor ${minWords}); lead ${leadWords} words.`
    });
    if (page.type !== 'article') {
      const sectionsPresent = ['includes', 'process', 'pricingFactors', 'prepare', 'restrictions'].filter(
        (k) => page.content && (page.content as unknown as Record<string, unknown>)[k]
      ).length;
      add({
        id: 'answers',
        label: 'Answers the core customer questions (includes, process, pricing factors, prep, restrictions)',
        severity: 'warning',
        weight: 5,
        pass: sectionsPresent >= 4 || (page.content?.sections?.length ?? 0) >= 3,
        detail: `${sectionsPresent}/5 standard sections present.`
      });
    }
  }

  let maxSimilarity: QualityReport['maxSimilarity'] = null;
  if (templated && page.content) {
    const index = ctx.shingleIndex ?? buildShingleIndex(data.pages);
    const mine = index.get(page.id) ?? shingles(text);
    for (const [id, set] of index) {
      if (id === page.id) continue;
      const value = similarity(mine, set);
      if (!maxSimilarity || value > maxSimilarity.value) maxSimilarity = { pageId: id, value };
    }
    const v = maxSimilarity?.value ?? 0;
    add({
      id: 'originality',
      label: 'Original, page-specific copy (not a near-duplicate)',
      severity: v >= 0.4 ? 'blocker' : 'warning',
      weight: 10,
      pass: v < 0.2,
      detail: maxSimilarity ? `Highest overlap ${(v * 100).toFixed(1)}% with ${maxSimilarity.pageId}.` : undefined
    });
  }

  // 6. FAQs
  if (templated) {
    const min = page.type === 'article' ? 2 : 3;
    const n = page.content?.faqs.length ?? 0;
    add({ id: 'faqs', label: `At least ${min} page-specific FAQs`, severity: 'blocker', weight: 6, pass: n >= min, detail: `${n} FAQs.` });
  }

  // 7. Internal links
  const relatedResolved = page.related.map((id) => pageIds.get(id));
  const badRelated = page.related.filter((_, i) => !relatedResolved[i] || (isBuilt(page) && !isBuilt(relatedResolved[i]!)));
  const inline = pageLinks(page).filter((h) => h.startsWith('/'));
  const badInline = inline.filter((h) => {
    const clean = h.split('#')[0];
    const target = pathIndex.get(clean);
    return !target || (isBuilt(page) && !isBuilt(target));
  });
  add({
    id: 'internal-links',
    label: 'Relevant, resolvable internal links',
    severity: 'blocker',
    weight: 8,
    pass: (page.type === 'core' || page.related.length >= 3) && badRelated.length === 0 && badInline.length === 0,
    detail:
      [badRelated.length ? `Unpublished/unknown related: ${badRelated.join(', ')}` : '', badInline.length ? `Broken inline links: ${badInline.join(', ')}` : '', page.type !== 'core' && page.related.length < 3 ? `Only ${page.related.length} related links.` : '']
        .filter(Boolean)
        .join(' ') || undefined
  });

  // 8. Contact information
  const foreignPhones = [...text.matchAll(OTHER_PHONE_RE)].map((m) => m[0]).filter((p) => p.replace(/\D/g, '') !== data.business.phoneE164.replace(/\D/g, '').slice(1));
  add({
    id: 'contact',
    label: 'Correct business name and phone',
    severity: 'blocker',
    weight: 6,
    pass: data.business.phoneE164 === '+12519308621' && foreignPhones.length === 0 && !/zoiris(?! junk removal)[a-z]/i.test(text),
    detail: foreignPhones.length ? `Unexpected phone numbers: ${foreignPhones.join(', ')}` : undefined
  });

  // 9. Metadata
  const t = page.seo.title?.trim() ?? '';
  const d = page.seo.description?.trim() ?? '';
  const dupTitle = liveOthers.find((p) => p.seo.title.trim().toLowerCase() === t.toLowerCase());
  const dupDesc = liveOthers.find((p) => p.seo.description.trim().toLowerCase() === d.toLowerCase());
  add({
    id: 'metadata',
    label: 'Unique, well-formed title, description and H1',
    severity: 'blocker',
    weight: 8,
    pass: t.length >= 15 && t.length <= 70 && d.length >= 70 && d.length <= 170 && !!page.seo.h1?.trim() && !dupTitle && !dupDesc,
    detail:
      [
        t.length < 15 || t.length > 70 ? `Title length ${t.length}.` : '',
        d.length < 70 || d.length > 170 ? `Description length ${d.length}.` : '',
        !page.seo.h1?.trim() ? 'Missing H1.' : '',
        dupTitle ? `Duplicate title with ${dupTitle.id}.` : '',
        dupDesc ? `Duplicate description with ${dupDesc.id}.` : ''
      ]
        .filter(Boolean)
        .join(' ') || undefined
  });
  add({
    id: 'metadata-length',
    label: 'Title ≤ 60 and description ≤ 160 characters (display guideline)',
    severity: 'warning',
    weight: 2,
    pass: t.length <= 60 && d.length <= 160,
    detail: `Title ${t.length}, description ${d.length}.`
  });

  // 10. Canonical
  const dupPath = others.find((p) => p.path === page.path);
  const redirected = data.redirects.find((r) => r.from === page.path);
  add({
    id: 'canonical',
    label: 'Valid, unique canonical URL',
    severity: 'blocker',
    weight: 6,
    pass: CANONICAL_PATH_RE.test(page.path) && !dupPath && !redirected,
    detail: dupPath ? `Path also used by ${dupPath.id}.` : redirected ? 'Path is the source of a redirect.' : !CANONICAL_PATH_RE.test(page.path) ? 'Path must be lowercase with leading and trailing slashes.' : undefined
  });

  // Structured data
  add({
    id: 'schema',
    label: 'Structured data configured',
    severity: 'warning',
    weight: 3,
    pass: page.seo.schemaTypes.includes('BreadcrumbList') || page.id === 'core-home',
    detail: page.seo.schemaTypes.join(', ') || 'None'
  });
  if (page.seo.schemaTypes.includes('Service')) {
    add({ id: 'schema-service', label: 'Service schema has a service reference', severity: 'blocker', weight: 2, pass: !!svc, detail: svc ? undefined : 'Service schema requires refs.serviceId.' });
  }

  // Claim screening
  const findings = screenClaims(text + ' ' + page.seo.title + ' ' + page.seo.description, data.business.claims);
  add({
    id: 'claims',
    label: 'No unverified business claims (pricing, timing, certifications, superlatives, reviews)',
    severity: 'blocker',
    weight: 8,
    pass: findings.length === 0,
    detail: findings.length ? findings.slice(0, 4).join(' | ') : undefined
  });

  // Approval
  add({
    id: 'approval',
    label: 'Editorial approval recorded',
    severity: 'blocker',
    weight: 4,
    pass: !!page.workflow.approvedBy && !!page.workflow.approvedAt,
    detail: page.workflow.approvedBy ? `${page.workflow.approvedBy} on ${page.workflow.approvedAt}` : 'Not approved.'
  });

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const blockers = checks.filter((c) => !c.pass && c.severity === 'blocker');
  const warnings = checks.filter((c) => !c.pass && c.severity === 'warning');
  return {
    pageId: page.id,
    score: Math.round((earned / totalWeight) * 100),
    checks,
    blockers,
    warnings,
    passesGate: blockers.length === 0,
    wordCount: words,
    maxSimilarity
  };
}

/** Indexability decision used by the build, sitemap, and dashboard. */
export function isIndexable(page: PageRecord, report: QualityReport): boolean {
  return page.status === 'published' && page.seo.robotsIndex && report.passesGate;
}
