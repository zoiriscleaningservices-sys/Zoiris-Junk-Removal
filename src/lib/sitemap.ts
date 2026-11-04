/**
 * XML sitemap generation from approved, canonical, indexable page records only.
 * Drafts, noindex pages, redirects, error pages and internal tools are never included.
 */
import type { PageRecord } from './types.ts';
import { absoluteUrl, escapeHtml } from './format.ts';

export interface SitemapEntry {
  loc: string;
  lastmod: string;
}

export function sitemapEntries(pages: PageRecord[], indexableIds: Set<string>, site: string): SitemapEntry[] {
  return pages
    .filter((p) => indexableIds.has(p.id))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .map((p) => ({ loc: absoluteUrl(site, p.path), lastmod: (p.content?.article?.lastReviewed ?? p.workflow.updatedAt).slice(0, 10) }));
}

/** Max URLs per sitemap file per the sitemaps.org protocol. */
export const SITEMAP_LIMIT = 50000;

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((e) => `  <url>\n    <loc>${escapeHtml(e.loc)}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function sitemapIndexXml(site: string, files: string[], lastmod: string): string {
  const items = files.map((f) => `  <sitemap>\n    <loc>${escapeHtml(absoluteUrl(site, f))}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
}
