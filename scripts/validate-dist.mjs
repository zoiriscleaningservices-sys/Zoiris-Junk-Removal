#!/usr/bin/env node
/**
 * validate-dist — audits the BUILT static site in /dist (what search engines
 * actually receive). Dependency-free HTML inspection.
 *
 * Checks: titles, descriptions, canonicals, robots, single H1, lang, viewport,
 * Open Graph, JSON-LD parse + policy (no fake ratings/addresses), image alt and
 * dimensions, internal links (broken + orphans via crawl from "/"), tel links,
 * phone consistency, placeholder text, draft leakage, sitemap ↔ indexability,
 * robots.txt, duplicate titles/descriptions.
 *
 * Usage: node scripts/validate-dist.mjs [--only=links] [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DIST_DIR, loadData } from './lib/load-data.mjs';

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const asJson = args.includes('--json');
const PHONE_E164 = '+12519308621';
const PHONE_DISPLAY = '251-930-8621';

if (!existsSync(DIST_DIR)) {
  console.error('dist/ not found — run the build first.');
  process.exit(1);
}

const data = loadData();
const issues = [];
const err = (code, file, message) => issues.push({ level: 'error', code, file, message });
const warn = (code, file, message) => issues.push({ level: 'warning', code, file, message });

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(DIST_DIR);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const routeOf = (file) => {
  const rel = '/' + relative(DIST_DIR, file).split(sep).join('/');
  if (rel === '/404.html') return '/404/';
  return rel.replace(/index\.html$/, '');
};

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
};
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const metaContent = (html, key, value) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) if (attr(tag, key) === value) return decode(attr(tag, 'content') ?? '');
  return null;
};

const redirectMap = new Map(data.redirects.map((r) => [r.from, r]));
const pages = new Map();
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const route = routeOf(file);
  const isRedirect = redirectMap.has(route);
  const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '');
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  const canonical = linkTags.map((t) => (attr(t, 'rel') === 'canonical' ? attr(t, 'href') : null)).find(Boolean) ?? null;
  const robots = metaContent(html, 'name', 'robots') ?? '';
  const description = metaContent(html, 'name', 'description') ?? '';
  const h1s = html.match(/<h1\b/gi)?.length ?? 0;
  const hrefs = [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*"([^"]*)"/gi)].map((m) => decode(m[1]));
  pages.set(route, { file, html, route, isRedirect, title, canonical, robots, description, h1s, hrefs });
}

const site = (process.env.SITE_URL || data.business.website).replace(/\/+$/, '');
const routes = new Set(pages.keys());
const assetExists = (path) => existsSync(join(DIST_DIR, decodeURIComponent(path.split('?')[0])));
const resolveInternal = (href) => {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean) return true;
  if (routes.has(clean)) return true;
  return assetExists(clean);
};

/* ---------------- Per-page checks ---------------- */
if (!only || only === 'seo') {
  for (const p of pages.values()) {
    if (p.isRedirect) {
      const rule = redirectMap.get(p.route);
      if (!/http-equiv="refresh"/i.test(p.html)) err('redirect-meta', p.route, 'Static redirect stub missing meta refresh.');
      if (!p.html.includes(rule.to)) err('redirect-dest', p.route, `Static redirect stub does not point to ${rule.to}.`);
      if (p.robots && !/noindex/i.test(p.robots)) err('redirect-indexable', p.route, 'Redirect stub must not be indexable.');
      continue;
    }
    const isError = p.route === '/404/';
    if (!p.title) err('missing-title', p.route, 'Missing <title>.');
    if (!p.description) err('missing-description', p.route, 'Missing meta description.');
    if (!/<html\b[^>]*\slang="en-US"/i.test(p.html)) err('lang', p.route, 'Missing lang="en-US".');
    if (!/name="viewport"/i.test(p.html)) err('viewport', p.route, 'Missing viewport meta.');
    if (p.h1s !== 1) err('h1', p.route, `Expected exactly one <h1>, found ${p.h1s}.`);
    if (!p.robots) err('robots-meta', p.route, 'Missing robots meta.');
    if (!isError) {
      if (!p.canonical) err('canonical-missing', p.route, 'Missing canonical.');
      else if (p.canonical !== site + p.route) err('canonical-mismatch', p.route, `Canonical ${p.canonical} ≠ ${site + p.route}`);
    }
    if (isError && !/noindex/.test(p.robots)) err('404-indexable', p.route, '404 page must be noindex.');
    for (const og of ['og:title', 'og:description', 'og:url', 'og:image']) if (!metaContent(p.html, 'property', og)) err('og', p.route, `Missing ${og}.`);
    // Heading order: no skipped levels downward (h2 -> h4).
    const levels = [...p.html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) {
      warn('heading-skip', p.route, `Heading level jumps from h${levels[i - 1]} to h${levels[i]}.`);
      break;
    }
    // JSON-LD
    for (const m of p.html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      let json;
      try {
        json = JSON.parse(m[1]);
      } catch (e) {
        err('jsonld-parse', p.route, `Invalid JSON-LD: ${e.message}`);
        continue;
      }
      const text = JSON.stringify(json);
      if (json['@context'] !== 'https://schema.org') err('jsonld-context', p.route, 'JSON-LD @context must be https://schema.org');
      if (/aggregateRating|"review"/i.test(text)) err('jsonld-reviews', p.route, 'JSON-LD contains ratings/reviews — not allowed without genuine, on-page reviews.');
      if (!data.business.address && /PostalAddress|streetAddress/.test(text)) err('jsonld-address', p.route, 'JSON-LD contains an address but the business has none configured.');
      if (!data.business.hours && /openingHours/.test(text)) err('jsonld-hours', p.route, 'JSON-LD contains opening hours that are not configured.');
      for (const tel of text.match(/"telephone":"([^"]+)"/g) ?? []) if (!tel.includes(PHONE_E164)) err('jsonld-phone', p.route, `Wrong telephone in JSON-LD: ${tel}`);
      const graph = json['@graph'] ?? [json];
      for (const node of graph) if (!node['@type']) err('jsonld-type', p.route, 'JSON-LD node missing @type.');
      const types = graph.map((n) => n['@type']);
      if (!isError && !types.includes('Organization')) err('jsonld-org', p.route, 'Missing Organization node.');
      if (p.route !== '/' && !isError && !types.includes('BreadcrumbList')) warn('jsonld-breadcrumb', p.route, 'No BreadcrumbList.');
    }
    // Images
    for (const tag of p.html.match(/<img\b[^>]*>/gi) ?? []) {
      if (attr(tag, 'alt') === null) err('img-alt', p.route, `Image without alt: ${tag.slice(0, 80)}`);
      if (!attr(tag, 'width') || !attr(tag, 'height')) err('img-dimensions', p.route, `Image without width/height (CLS risk): ${tag.slice(0, 80)}`);
      const src = attr(tag, 'src') ?? '';
      if (src.startsWith('/') && !assetExists(src)) err('img-missing', p.route, `Image file missing: ${src}`);
    }
    // Phone consistency
    for (const href of p.hrefs.filter((h) => h.startsWith('tel:'))) if (href !== `tel:${PHONE_E164}`) err('tel-link', p.route, `Unexpected tel link ${href}`);
    const visible = p.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    for (const m of visible.matchAll(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g)) if (m[0].replace(/\D/g, '') !== '2519308621') err('foreign-phone', p.route, `Unexpected phone number in page text: ${m[0]}`);
    if (!visible.includes(PHONE_DISPLAY)) err('phone-missing', p.route, 'Business phone number not visible on page.');
    // Placeholders / fabricated trust signals
    if (/lorem ipsum|\bTODO\b|\bTBD\b|123 Main|example\.com|placeholder/i.test(visible)) err('placeholder', p.route, 'Placeholder text found.');
    if (/★|\b\d(\.\d)?\s*stars?\b|\d+\+?\s*reviews\b/i.test(visible)) err('fake-reviews', p.route, 'Rating/review language found — only genuine reviews may be shown.');
  }

  // Duplicates among indexable pages
  const indexable = [...pages.values()].filter((p) => !p.isRedirect && /(^|,\s*)index/.test(p.robots));
  const dup = (key) => {
    const m = new Map();
    for (const p of indexable) m.set(p[key], [...(m.get(p[key]) ?? []), p.route]);
    for (const [v, rs] of m) if (rs.length > 1) err(`duplicate-${key}`, rs.join(', '), `Duplicate ${key}: "${v}"`);
  };
  dup('title');
  dup('description');

  // Draft leakage: records that are not built must not exist in dist.
  for (const rec of data.pages) {
    const built = rec.status === 'published' || rec.status === 'noindex';
    if (!built && routes.has(rec.path)) err('draft-leak', rec.path, `Record ${rec.id} has status "${rec.status}" but exists in dist.`);
    if (built && !routes.has(rec.path)) err('missing-route', rec.path, `Record ${rec.id} is ${rec.status} but no HTML was generated.`);
    if (rec.status === 'noindex' && routes.has(rec.path) && !/noindex/.test(pages.get(rec.path).robots)) err('noindex-ignored', rec.path, 'Noindex record rendered as indexable.');
  }

  // Sitemap
  const sm = join(DIST_DIR, 'sitemap.xml');
  if (!existsSync(sm)) err('sitemap-missing', '/sitemap.xml', 'sitemap.xml not generated.');
  else {
    const xml = readFileSync(sm, 'utf8');
    if (!xml.startsWith('<?xml') || !xml.includes('http://www.sitemaps.org/schemas/sitemap/0.9')) err('sitemap-format', '/sitemap.xml', 'Invalid sitemap header/namespace.');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
    const seen = new Set();
    for (const loc of locs) {
      if (seen.has(loc)) err('sitemap-dup', loc, 'Duplicate sitemap URL.');
      seen.add(loc);
      const route = loc.replace(site, '');
      const p = pages.get(route);
      if (!p) err('sitemap-404', loc, 'Sitemap URL has no page.');
      else {
        if (p.isRedirect) err('sitemap-redirect', loc, 'Redirect URL listed in sitemap.');
        if (/noindex/.test(p.robots)) err('sitemap-noindex', loc, 'Noindex page listed in sitemap.');
        if (p.canonical !== loc) err('sitemap-canonical', loc, 'Sitemap URL is not the canonical URL.');
      }
    }
    for (const p of indexable) if (!seen.has(site + p.route)) err('sitemap-missing-page', p.route, 'Indexable page missing from sitemap.');
    if (locs.length > 50000) err('sitemap-size', '/sitemap.xml', 'More than 50,000 URLs — split into a sitemap index.');
  }

  // robots.txt
  const rb = join(DIST_DIR, 'robots.txt');
  if (!existsSync(rb)) err('robots-missing', '/robots.txt', 'robots.txt not generated.');
  else {
    const txt = readFileSync(rb, 'utf8');
    if (/^Disallow:\s*\/\s*$/m.test(txt) && process.env.ZOIRIS_PREVIEW !== '1') err('robots-blocks-all', '/robots.txt', 'robots.txt blocks the whole site.');
    if (!txt.includes(`Sitemap: ${site}/sitemap.xml`)) err('robots-sitemap', '/robots.txt', 'robots.txt does not reference the sitemap.');
    if (!/Disallow:\s*\/owner\//.test(txt)) err('robots-owner', '/robots.txt', 'robots.txt must disallow /owner/.');
    if (!/Disallow:\s*\/api\//.test(txt)) err('robots-api', '/robots.txt', 'robots.txt must disallow /api/.');
    if (/Disallow:\s*\/(_astro|fonts|brand)/.test(txt)) err('robots-assets', '/robots.txt', 'robots.txt blocks rendering assets.');
  }
  if (files.some((f) => /(^|[\\/])(admin|owner|command-center|\.zoiris-private)([\\/]|$)|\.sqlite$/i.test(relative(DIST_DIR, f)))) {
    err('private-leak', '/owner', 'Private Command Center, admin, database, or customer media files found in dist/.');
  }
}

/* ---------------- Links & crawl ---------------- */
if (!only || only === 'links' || only === 'seo') {
  for (const p of pages.values()) {
    for (const href of p.hrefs) {
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      if (!resolveInternal(href)) err('broken-link', p.route, `Broken internal link: ${href}`);
      else if (!href.split('#')[0].endsWith('/') && !/\.[a-z0-9]+$/i.test(href.split('#')[0]) && href.split('#')[0]) warn('trailing-slash', p.route, `Link without trailing slash: ${href}`);
    }
  }
  // Crawl from home to find orphans.
  const reached = new Set(['/']);
  const queue = ['/'];
  while (queue.length) {
    const r = queue.shift();
    const p = pages.get(r);
    if (!p) continue;
    for (const h of p.hrefs) {
      const clean = h.split('#')[0];
      if (clean.startsWith('/') && routes.has(clean) && !reached.has(clean)) {
        reached.add(clean);
        queue.push(clean);
      }
    }
  }
  for (const r of routes) if (r !== '/404/' && !redirectMap.has(r) && !reached.has(r)) err('orphan', r, 'Not reachable by following links from the homepage.');
}

/* ---------------- Report ---------------- */
const errors = issues.filter((i) => i.level === 'error');
const warnings = issues.filter((i) => i.level === 'warning');
if (asJson) {
  console.log(JSON.stringify({ pages: pages.size, issues }, null, 2));
} else {
  const contentDocs = [...pages.values()].filter((p) => !p.isRedirect).length;
  const redirectDocs = [...pages.values()].filter((p) => p.isRedirect).length;
  const indexableCount = [...pages.values()].filter((p) => !p.isRedirect && /(^|,\s*)index/.test(p.robots)).length;
  console.log(`Zoiris dist validation — ${contentDocs} page HTML documents (${indexableCount} indexable) + ${redirectDocs} redirect stubs, ${files.length} total files`);
  for (const i of [...errors, ...warnings]) console.log(`  ${i.level === 'error' ? '✖' : '⚠'} [${i.code}] ${i.file}: ${i.message}`);
  console.log(errors.length ? `\n✖ ${errors.length} error(s), ${warnings.length} warning(s).` : `\n✔ No errors. ${warnings.length} warning(s).`);
}
process.exit(errors.length ? 1 : 0);
