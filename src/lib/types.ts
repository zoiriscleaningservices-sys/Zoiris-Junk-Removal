/**
 * Zoiris content schema.
 *
 * These types are the contract shared by:
 *  - the static Astro site (src/pages, src/layouts, src/components)
 *  - the build-time validators (scripts/*.mjs)
 *  - the local SEO Operations Dashboard (admin/)
 *  - the Zoiris Command Center & CRM backend (server/)
 *
 * Only erasable TypeScript syntax is used here so that Node can import these
 * modules directly (type stripping) from scripts and backend servers.
 */

/* ------------------------------------------------------------------ */
/* Verification & Geographic Classification Vocabulary                 */
/* ------------------------------------------------------------------ */

export type ServiceVerification = 'confirmed' | 'category-confirmed' | 'unverified' | 'not-offered';

/** Public acceptance status for an individual item. */
export type ItemAcceptance =
  | 'accepted'
  | 'accepted-after-confirmation'
  | 'quantity-limited'
  | 'special-handling'
  | 'not-accepted'
  | 'unknown';

/**
 * Six-state owner-controlled geographic coverage status (Phase 2 Part 1 §4):
 * - active: Active service area (approved for public indexable location pages)
 * - available-on-confirmation: Available upon address/scope confirmation by phone
 * - limited: Limited availability (e.g., partial county coverage or select jobs)
 * - temporarily-unavailable: Temporarily unavailable
 * - not-serviced: Not currently serviced
 * - research-only: Research target only — MUST NEVER become an indexable public service page
 */
export type CoverageStatus =
  | 'active'
  | 'available-on-confirmation'
  | 'limited'
  | 'temporarily-unavailable'
  | 'not-serviced'
  | 'research-only';

/**
 * Five-tier place classification taxonomy (Phase 2 Part 1 §3):
 * - incorporated-municipality: Legally incorporated City or Town under AL Code § 11-40-6
 * - official-neighborhood: Formally mapped MHDC Local ARB, NRHP, or municipal district
 * - recognized-community: Historically, culturally, or geographically distinct named community/CDP
 * - local-area-name: Broad everyday area/corridor name without a single municipal polygon
 * - unincorporated-area: Unincorporated county territory outside municipal limits
 */
export type GeoClassification =
  | 'incorporated-municipality'
  | 'official-neighborhood'
  | 'recognized-community'
  | 'local-area-name'
  | 'unincorporated-area';

export type CustomerType = 'residential' | 'commercial';

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

export interface Business {
  name: string;
  legalName: string | null;
  phoneDisplay: string;
  phoneE164: string;
  phoneHref: string;
  email: string | null;
  website: string;
  websiteVerified: boolean;
  serviceAreaBusiness: boolean;
  address: null | {
    streetAddress: string;
    addressLocality: string;
    addressRegion: string;
    postalCode: string;
    addressCountry: string;
  };
  primaryCity: string;
  primaryRegion: string;
  hours: string[] | null;
  hoursDisplay: string | null;
  tagline: string;
  shortDescription: string;
  disposalStatement: string;
  social: { googleBusinessProfile: string | null; facebook: string | null; instagram: string | null; yelp: string | null };
  claims: {
    licensed: boolean;
    insured: boolean;
    bonded: boolean;
    certifiedRecycler: boolean;
    sameDayService: boolean;
    emergencyService: boolean;
    dataDestruction: boolean;
  };
  ownerVerification: string[];
}

export interface Service {
  id: string;
  name: string;
  category: 'junk' | 'ewaste';
  group: 'core' | 'removal' | 'cleanout' | 'debris' | 'ewaste';
  customerTypes: CustomerType[];
  verification: ServiceVerification;
  pageId: string | null;
  summary: string;
  icon: string;
  showInNav: boolean;
  notes: string;
}

export interface Item {
  id: string;
  name: string;
  category: string;
  isEwaste: boolean;
  acceptance: ItemAcceptance;
  publicNote: string;
  serviceId: string | null;
  pageId: string | null;
  containsBattery: boolean;
  dataBearing: boolean;
  notes: string;
}

export interface ItemCategory {
  id: string;
  name: string;
  icon: string;
  isEwaste: boolean;
  description: string;
}

export interface County {
  id: string;
  name: string;
  state: string;
  seat: string;
  coverage: CoverageStatus;
  pageId: string | null;
  subRegions: string[];
  geoReference: string;
  solidWasteNotes: string;
  source: string;
  lastVerifiedAt: string;
}

export interface Location {
  id: string;
  name: string;
  officialName?: string;
  state: string;
  county: string;
  countyId: string;
  kind: 'city' | 'town' | 'community';
  classification: GeoClassification;
  parentAreaId: string | null;
  subRegion?: string;
  zipCodes: string[];
  geoReference: string;
  pickupNotes: string;
  coverage: CoverageStatus;
  pageId: string | null;
  notes: string;
  source: string;
  lastVerifiedAt: string;
}

export interface Neighborhood {
  id: string;
  name: string;
  cityId: string;
  countyId: string;
  classification: GeoClassification;
  zipCodes: string[];
  geoReference: string;
  pickupNotes: string;
  coverage: CoverageStatus;
  pageId: string | null;
  /** First-party evidence supplied by the owner (completed jobs, photos with permission, access notes). */
  localEvidence: string[];
  description: string;
  source: string;
  lastVerifiedAt: string;
  notes: string;
}

export type SearchIntent = 'transactional' | 'commercial' | 'informational' | 'navigational' | 'local';

export interface Keyword {
  id: string;
  keyword: string;
  intent: SearchIntent;
  role: 'primary' | 'secondary';
  targetPageId: string | null;
  priority: 'high' | 'medium' | 'low';
  locationRelevance: 'mobile-al' | 'near-me' | 'regional' | 'none';
  conversionPotential: 'high' | 'medium' | 'low';
  entities: string[];
  volume: number | null;
  cpc: number | null;
  competition: string | null;
  performance: null | { clicks: number; impressions: number; ctr: number; position: number; period: string; source: string };
  source: string;
  researchedAt: string;
  notes: string;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export type PageStatus =
  | 'idea'
  | 'research'
  | 'draft'
  | 'needs-review'
  | 'approved'
  | 'published'
  | 'noindex'
  | 'archived';

export type PageType = 'core' | 'service' | 'ewaste' | 'item' | 'county' | 'location' | 'neighborhood' | 'combo' | 'article';

export interface PageSeo {
  title: string;
  description: string;
  h1: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  intent: SearchIntent;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  robotsIndex: boolean;
  robotsFollow: boolean;
  schemaTypes: string[];
}

export interface ContentSection {
  heading: string;
  body: string[];
  bullets?: string[];
  subsections?: { heading: string; body: string[]; bullets?: string[] }[];
}

export interface PageContent {
  eyebrow?: string;
  lead: string;
  quickAnswer?: { question: string; answer: string };
  includes?: { heading?: string; intro?: string; points: string[] };
  items?: { heading?: string; intro?: string; list: string[]; itemIds?: string[] };
  audience?: { heading?: string; body: string[] };
  process?: { heading?: string; steps: { title: string; body: string }[] };
  pricingFactors?: { heading?: string; intro?: string; factors: string[] };
  prepare?: { heading?: string; tips: string[] };
  restrictions?: { heading?: string; body?: string; list: string[] };
  sections?: ContentSection[];
  faqs: { q: string; a: string }[];
  areaNote?: string;
  article?: { lastReviewed: string; sources: { label: string; url: string }[]; readingMinutes?: number };
  illustration?: string;
}

export interface PageWorkflow {
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewNotes: string;
  ownerVerification: string[];
  history?: { at: string; from: PageStatus; to: PageStatus; by: string; note?: string }[];
}

export interface PageRecord {
  id: string;
  type: PageType;
  path: string;
  status: PageStatus;
  refs: {
    serviceId?: string;
    itemIds?: string[];
    countyId?: string;
    locationId?: string;
    neighborhoodId?: string;
    customerType?: CustomerType | 'both';
  };
  seo: PageSeo;
  breadcrumb: { label: string; parentId: string | null };
  purpose: string;
  content?: PageContent;
  related: string[];
  workflow: PageWorkflow;
}

export interface Redirect {
  from: string;
  to: string;
  status: 301 | 302;
  note: string;
}

export interface SiteData {
  business: Business;
  services: Service[];
  items: Item[];
  itemCategories: ItemCategory[];
  counties: County[];
  locations: Location[];
  neighborhoods: Neighborhood[];
  keywords: Keyword[];
  pages: PageRecord[];
  redirects: Redirect[];
}
