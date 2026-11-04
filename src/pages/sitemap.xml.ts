/**
 * /sitemap.xml — generated at build time from approved, canonical, indexable
 * page records only (status "published" + robotsIndex + passing quality gate).
 */
import type { APIRoute } from 'astro';
import { data, indexableIds, business } from '../lib/data.ts';
import { sitemapEntries, sitemapXml } from '../lib/sitemap.ts';

export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString() ?? business.website).replace(/\/+$/, '');
  const xml = sitemapXml(sitemapEntries(data.pages, indexableIds, origin));
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
