/**
 * Astro-side data loader. Loads all structured content at build time and
 * computes the publishing decisions once for the whole build.
 */
import type { Business, County, Item, ItemCategory, Keyword, Location, Neighborhood, PageRecord, Redirect, Service, SiteData } from './types.ts';
import businessJson from '../data/business.json';
import servicesJson from '../data/services.json';
import itemsJson from '../data/items.json';
import itemCategoriesJson from '../data/item-categories.json';
import countiesJson from '../data/counties.json';
import locationsJson from '../data/locations.json';
import neighborhoodsJson from '../data/neighborhoods.json';
import keywordsJson from '../data/keywords.json';
import redirectsJson from '../data/redirects.json';
import { auditSite } from './audit.ts';
import { isBuilt, isIndexable } from './page-quality.ts';
import { isActiveCoverage } from './labels.ts';

const pageModules = import.meta.glob<{ default: PageRecord }>('../data/pages/*.json', { eager: true });

export const data: SiteData = {
  business: businessJson as unknown as Business,
  services: servicesJson as Service[],
  items: itemsJson as Item[],
  itemCategories: itemCategoriesJson as ItemCategory[],
  counties: countiesJson as County[],
  locations: locationsJson as Location[],
  neighborhoods: neighborhoodsJson as Neighborhood[],
  keywords: keywordsJson as unknown as Keyword[],
  redirects: redirectsJson as unknown as Redirect[],
  pages: Object.values(pageModules)
    .map((m) => m.default)
    .sort((a, b) => a.path.localeCompare(b.path))
};

export const business = data.business;
export const audit = auditSite(data);
export const indexableIds = new Set(audit.indexable);

/**
 * Draft preview builds (ZOIRIS_PREVIEW=1) render unpublished records with
 * noindex and a visible banner for owner review. Never deploy a preview build.
 */
export const PREVIEW = typeof process !== 'undefined' && process.env.ZOIRIS_PREVIEW === '1';

const byId = new Map(data.pages.map((p) => [p.id, p]));

export function getPage(id: string): PageRecord {
  const page = byId.get(id);
  if (!page) throw new Error(`Unknown page id: ${id}`);
  return page;
}

export function pathOf(id: string): string {
  return getPage(id).path;
}

/** Templated (non-core) pages that produce an HTML document in this build. */
export function templatedPagesToBuild(): PageRecord[] {
  return data.pages.filter((p) => p.type !== 'core' && p.content && (isBuilt(p) || (PREVIEW && p.status !== 'archived')));
}

export function isLive(p: PageRecord): boolean {
  return isBuilt(p);
}

export function robotsFor(page: PageRecord): string {
  const index = indexableIds.has(page.id) && isIndexable(page, audit.reports[page.id]);
  return `${index ? 'index' : 'noindex'}, ${page.seo.robotsFollow ? 'follow' : 'nofollow'}`;
}

export function serviceFor(page: PageRecord): Service | undefined {
  return page.refs.serviceId ? data.services.find((s) => s.id === page.refs.serviceId) : undefined;
}

export function locationFor(page: PageRecord): Location | undefined {
  return page.refs.locationId ? data.locations.find((l) => l.id === page.refs.locationId) : undefined;
}

export function neighborhoodFor(page: PageRecord): Neighborhood | undefined {
  return page.refs.neighborhoodId ? data.neighborhoods.find((n) => n.id === page.refs.neighborhoodId) : undefined;
}

export function countyFor(page: PageRecord): County | undefined {
  const loc = locationFor(page);
  const cid = page.refs.countyId ?? loc?.countyId;
  return cid ? data.counties.find((c) => c.id === cid) : undefined;
}

export function liveServicePages(category: 'junk' | 'ewaste'): { service: Service; page: PageRecord }[] {
  return data.services
    .filter((s) => s.category === category && s.pageId)
    .map((s) => ({ service: s, page: byId.get(s.pageId!) }))
    .filter((x): x is { service: Service; page: PageRecord } => !!x.page && isBuilt(x.page));
}

export function itemsByCategory(): { category: ItemCategory; items: Item[] }[] {
  return data.itemCategories.map((category) => ({ category, items: data.items.filter((i) => i.category === category.id) })).filter((g) => g.items.length);
}

export function verifiedLocations(): Location[] {
  return data.locations.filter((l) => isActiveCoverage(l.coverage));
}

export const activeLocations = verifiedLocations;
