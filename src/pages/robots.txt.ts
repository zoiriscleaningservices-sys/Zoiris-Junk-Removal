/**
 * /robots.txt — allows crawling of all public content and assets, blocks
 * private owner Command Center, API routes, and internal/admin paths.
 */
import type { APIRoute } from 'astro';
import { business } from '../lib/data.ts';

export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString() ?? business.website).replace(/\/+$/, '');
  const preview = process.env.ZOIRIS_PREVIEW === '1';
  const body = preview
    ? `# Draft preview build — do not index\nUser-agent: *\nDisallow: /\n`
    : `User-agent: *\nAllow: /\nDisallow: /owner/\nDisallow: /api/\nDisallow: /admin/\nDisallow: /_internal/\n\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
