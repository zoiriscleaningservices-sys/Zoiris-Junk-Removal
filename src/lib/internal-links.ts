/**
 * Internal linking: breadcrumbs, related links, hub membership and the
 * record-level link graph used for orphan detection.
 */
import type { PageRecord, SiteData } from './types.ts';
import { isBuilt, pageLinks } from './page-quality.ts';

export interface Crumb {
  label: string;
  path: string;
  id: string;
}

export function breadcrumbTrail(page: PageRecord, pages: PageRecord[]): Crumb[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const trail: Crumb[] = [];
  const seen = new Set<string>();
  let current: PageRecord | undefined = page;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift({ label: current.breadcrumb.label, path: current.path, id: current.id });
    current = current.breadcrumb.parentId ? byId.get(current.breadcrumb.parentId) : undefined;
  }
  if (trail[0]?.id !== 'core-home') {
    const home = byId.get('core-home');
    if (home) trail.unshift({ label: home.breadcrumb.label, path: home.path, id: home.id });
  }
  return trail;
}

/** Related pages that are actually built (never link to drafts from public pages). */
export function relatedPages(page: PageRecord, pages: PageRecord[]): PageRecord[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return page.related.map((id) => byId.get(id)).filter((p): p is PageRecord => !!p && isBuilt(p));
}

/** Pages that hubs list automatically (services index, e-waste hub, guides index, areas, accepted items). */
export function hubChildren(hubId: string, pages: PageRecord[]): PageRecord[] {
  return pages.filter((p) => p.breadcrumb.parentId === hubId && isBuilt(p));
}

/** Site-wide navigation links rendered in the header and footer (ids). */
export const GLOBAL_NAV_IDS = [
  'core-home',
  'svc-junk-removal-mobile-al',
  'core-services',
  'ew-electronics-pickup',
  'core-areas',
  'core-how-it-works',
  'core-pricing',
  'core-about',
  'core-faq',
  'core-contact',
  'core-request-pickup',
  'core-accepted-items',
  'core-restricted-items',
  'core-responsible-disposal',
  'core-guides',
  'core-privacy-policy',
  'core-terms',
  'loc-mobile-al'
];

/**
 * Inbound link graph built from records (related links, inline links, breadcrumb
 * parents and hub listings). The dist validator performs a real crawl as well.
 */
export function inboundLinks(data: SiteData): Map<string, Set<string>> {
  const byPath = new Map(data.pages.map((p) => [p.path, p]));
  const inbound = new Map<string, Set<string>>(data.pages.map((p) => [p.id, new Set<string>()]));
  const link = (from: string, to: string | undefined) => {
    if (!to || from === to) return;
    inbound.get(to)?.add(from);
  };
  for (const p of data.pages) {
    if (!isBuilt(p)) continue;
    p.related.forEach((id) => link(p.id, id));
    pageLinks(p).forEach((href) => link(p.id, byPath.get(href.split('#')[0])?.id));
    // Parent hubs list their children.
    if (p.breadcrumb.parentId) link(p.breadcrumb.parentId, p.id);
  }
  for (const id of GLOBAL_NAV_IDS) link('global-nav', id);
  // Services listed in the mega-menu.
  for (const s of data.services) if (s.showInNav && s.pageId) link('global-nav', s.pageId);
  return inbound;
}

export function orphanPages(data: SiteData): PageRecord[] {
  const inbound = inboundLinks(data);
  return data.pages.filter((p) => isBuilt(p) && p.id !== 'core-home' && (inbound.get(p.id)?.size ?? 0) === 0);
}
