/**
 * JSON-LD builders. Only facts present in business.json and on the page are used.
 * - No street address, hours, coordinates, ratings or reviews are emitted unless configured.
 * - areaServed lists only locations with coverage === "verified".
 */
import type { Business, Location, PageRecord, Service } from './types.ts';
import type { Crumb } from './internal-links.ts';
import { absoluteUrl, inlineToText } from './format.ts';

type Json = Record<string, unknown>;

export function ids(site: string) {
  return {
    organization: absoluteUrl(site, '/#organization'),
    business: absoluteUrl(site, '/#localbusiness'),
    website: absoluteUrl(site, '/#website')
  };
}

function sameAs(b: Business): string[] {
  return Object.values(b.social).filter((v): v is string => !!v);
}

function areaServed(locations: Location[]): Json[] {
  return locations
    .filter((l) => l.coverage === 'active')
    .map((l) => ({ '@type': 'City', name: `${l.name}, ${l.state === 'AL' ? 'Alabama' : l.state}`, containedInPlace: { '@type': 'State', name: 'Alabama' } }));
}

export function organizationNode(b: Business, site: string): Json {
  const node: Json = {
    '@type': 'Organization',
    '@id': ids(site).organization,
    name: b.name,
    url: absoluteUrl(site, '/'),
    telephone: b.phoneE164,
    logo: absoluteUrl(site, '/brand/zoiris-logo-512.png')
  };
  const s = sameAs(b);
  if (s.length) node.sameAs = s;
  if (b.email) node.email = b.email;
  return node;
}

export function localBusinessNode(b: Business, site: string, locations: Location[], services: Service[]): Json {
  const node: Json = {
    '@type': 'LocalBusiness',
    '@id': ids(site).business,
    name: b.name,
    description: b.shortDescription,
    url: absoluteUrl(site, '/'),
    telephone: b.phoneE164,
    image: absoluteUrl(site, '/brand/og-default.jpg'),
    logo: absoluteUrl(site, '/brand/zoiris-logo-512.png'),
    parentOrganization: { '@id': ids(site).organization },
    areaServed: areaServed(locations),
    knowsAbout: services.filter((s) => s.pageId && (s.verification === 'confirmed' || s.verification === 'category-confirmed')).map((s) => s.name)
  };
  if (b.address) node.address = { '@type': 'PostalAddress', ...b.address };
  if (b.hours?.length) node.openingHours = b.hours;
  if (b.email) node.email = b.email;
  const s = sameAs(b);
  if (s.length) node.sameAs = s;
  return node;
}

export function websiteNode(b: Business, site: string): Json {
  return {
    '@type': 'WebSite',
    '@id': ids(site).website,
    url: absoluteUrl(site, '/'),
    name: b.name,
    inLanguage: 'en-US',
    publisher: { '@id': ids(site).organization }
  };
}

export function serviceNode(page: PageRecord, service: Service, site: string, locations: Location[]): Json {
  return {
    '@type': 'Service',
    '@id': absoluteUrl(site, page.path) + '#service',
    name: page.seo.h1,
    serviceType: service.name,
    description: page.seo.description,
    url: absoluteUrl(site, page.path),
    provider: { '@id': ids(site).business },
    areaServed: areaServed(locations),
    audience: service.customerTypes.map((t) => ({ '@type': 'Audience', audienceType: t === 'residential' ? 'Residential customers' : 'Commercial customers' }))
  };
}

export function breadcrumbNode(trail: Crumb[], site: string): Json {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.label, item: absoluteUrl(site, c.path) }))
  };
}

export function articleNode(page: PageRecord, site: string): Json {
  const lastReviewed = page.content?.article?.lastReviewed ?? page.workflow.updatedAt;
  return {
    '@type': 'Article',
    '@id': absoluteUrl(site, page.path) + '#article',
    headline: page.seo.h1,
    description: page.seo.description,
    mainEntityOfPage: absoluteUrl(site, page.path),
    datePublished: page.workflow.createdAt,
    dateModified: lastReviewed,
    author: { '@id': ids(site).organization },
    publisher: { '@id': ids(site).organization },
    image: absoluteUrl(site, page.seo.ogImage ?? '/brand/og-default.jpg'),
    inLanguage: 'en-US'
  };
}

export function graph(nodes: Json[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c');
}

export function plainLead(page: PageRecord): string {
  return inlineToText(page.content?.lead ?? page.seo.description);
}
