/**
 * Page matrix generator.
 *
 * Proposes service × location, service × neighborhood, item × city and
 * customer-type × service opportunities across Mobile County and Baldwin County.
 * It NEVER publishes anything: it checks whether an existing page already serves
 * the intent, verifies coverage and keyword cannibalization, reports readiness,
 * and produces candidate records in "idea" status (`robotsIndex: false`) for
 * editorial review.
 */
import type { CustomerType, PageRecord, Service, SiteData } from './types.ts';
import { normalizeKeyword } from './format.ts';

export interface MatrixSelection {
  serviceIds: string[];
  itemIds: string[];
  locationIds: string[];
  neighborhoodIds: string[];
  customerTypes: CustomerType[];
}

export type Recommendation = 'create-draft' | 'covered-by-existing' | 'blocked' | 'exists';

export interface MatrixCandidate {
  key: string;
  kind: 'service+city' | 'service+neighborhood' | 'item+city' | 'customer+service';
  id: string;
  path: string;
  title: string;
  h1: string;
  primaryKeyword: string;
  refs: PageRecord['refs'];
  existingPageId: string | null;
  recommendation: Recommendation;
  reasons: string[];
}

const PRIMARY_LOCATION = 'mobile-al';

function serviceSlug(service: Service, svcPagePath: string | undefined): string {
  if (service.id === 'junk-removal') return 'junk-removal';
  if (service.id === 'electronics-pickup') return 'electronics-pickup';
  if (!svcPagePath) return service.id;
  const parts = svcPagePath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? service.id;
}

export function proposeCandidates(data: SiteData, sel: MatrixSelection): MatrixCandidate[] {
  const out: MatrixCandidate[] = [];
  const pageById = new Map(data.pages.map((p) => [p.id, p]));
  const findByKeyword = (kw: string) => data.pages.find((p) => p.status !== 'archived' && normalizeKeyword(p.seo.primaryKeyword) === normalizeKeyword(kw));
  const findByPath = (path: string) => data.pages.find((p) => p.path === path);

  const services = data.services.filter((s) => sel.serviceIds.includes(s.id));
  const locations = data.locations.filter((l) => sel.locationIds.includes(l.id));
  const neighborhoods = data.neighborhoods.filter((n) => sel.neighborhoodIds.includes(n.id));
  const items = data.items.filter((i) => sel.itemIds.includes(i.id));

  for (const s of services) {
    const svcPage = s.pageId ? pageById.get(s.pageId) : undefined;
    const slug = serviceSlug(s, svcPage?.path);
    const svcVerified = s.verification === 'confirmed' || s.verification === 'category-confirmed';

    for (const l of locations) {
      const kw = `${s.name.toLowerCase()} ${l.name} ${l.state}`;
      const path = `/areas/${l.id}/${slug}/`;
      const reasons: string[] = [];
      let rec: Recommendation = 'create-draft';
      let existing: PageRecord | undefined = findByPath(path) ?? findByKeyword(kw);
      if (existing) {
        rec = 'exists';
        reasons.push(`A record already exists (${existing.id}, ${existing.status}).`);
      } else if (l.id === PRIMARY_LOCATION && svcPage) {
        rec = 'covered-by-existing';
        existing = svcPage;
        reasons.push(`${svcPage.path} already targets ${s.name} in Mobile, AL. A separate page would cannibalize it — strengthen the existing page instead.`);
      }
      if (!svcVerified) reasons.push(`Service is ${s.verification}.`);
      if (l.coverage !== 'active') reasons.push(`Coverage for ${l.name} (${l.county}) is "${l.coverage}"; owner activation required before publishing.`);
      if (rec === 'create-draft' && (!svcVerified || l.coverage !== 'active')) rec = 'blocked';
      if (rec === 'create-draft') reasons.push('Requires genuinely local content (verified municipal rules, access notes, local FAQs) before approval.');
      out.push({
        key: `${s.id}|${l.id}`,
        kind: 'service+city',
        id: `combo-${slug}-${l.id}`,
        path,
        title: `${s.name} in ${l.name}, ${l.state} | Zoiris Junk Removal`,
        h1: `${s.name} in ${l.name}, ${l.state}`,
        primaryKeyword: kw,
        refs: { serviceId: s.id, locationId: l.id, countyId: l.countyId },
        existingPageId: existing?.id ?? null,
        recommendation: rec,
        reasons
      });
    }

    for (const n of neighborhoods) {
      const kw = `${s.name.toLowerCase()} ${n.name}`;
      const path = `/areas/${n.cityId}/${n.id}/${slug}/`;
      const reasons: string[] = [];
      let rec: Recommendation = 'create-draft';
      const existing = findByPath(path) ?? findByKeyword(kw);
      if (existing) {
        rec = 'exists';
        reasons.push(`A record already exists (${existing.id}, ${existing.status}).`);
      }
      if (!svcVerified) reasons.push(`Service is ${s.verification}.`);
      if (n.coverage !== 'active') reasons.push(`Neighborhood coverage is "${n.coverage}".`);
      if (n.localEvidence.length < 2) reasons.push(`Only ${n.localEvidence.length} pieces of first-party local evidence (need 2+ real jobs, photos, or access notes).`);
      if (rec === 'create-draft' && (!svcVerified || n.coverage !== 'active')) rec = 'blocked';
      if (rec === 'create-draft' && n.localEvidence.length < 2) {
        reasons.push('Record can be created for research, but cannot pass the publishing gate yet.');
      }
      out.push({
        key: `${s.id}|${n.id}`,
        kind: 'service+neighborhood',
        id: `combo-${slug}-${n.id}`,
        path,
        title: `${s.name} in ${n.name}, Mobile | Zoiris Junk Removal`,
        h1: `${s.name} in ${n.name}`,
        primaryKeyword: kw,
        refs: { serviceId: s.id, neighborhoodId: n.id, locationId: n.cityId, countyId: n.countyId },
        existingPageId: existing?.id ?? null,
        recommendation: rec,
        reasons
      });
    }

    for (const ct of sel.customerTypes) {
      const name = `${ct === 'residential' ? 'Residential' : 'Commercial'} ${s.name}`;
      const kw = `${name.toLowerCase()} Mobile AL`;
      const reasons: string[] = [];
      let rec: Recommendation = 'create-draft';
      const generic = data.pages.find((p) => p.id === (ct === 'residential' ? 'svc-residential-junk-removal' : 'svc-commercial-junk-removal'));
      const existing = findByKeyword(kw);
      if (existing) {
        rec = 'exists';
        reasons.push(`Already targeted by ${existing.id}.`);
      } else if (!s.customerTypes.includes(ct)) {
        rec = 'blocked';
        reasons.push(`${s.name} is not offered to ${ct} customers.`);
      } else if (s.customerTypes.length === 1 && svcPage) {
        rec = 'covered-by-existing';
        reasons.push(`${s.name} only serves ${ct} customers — ${svcPage.path} already covers this intent.`);
      } else {
        reasons.push(`Only create if ${ct} ${s.name.toLowerCase()} differs materially (process, access, volume) from ${svcPage?.path ?? 'the service page'}${generic ? ` and ${generic.path}` : ''}.`);
      }
      out.push({
        key: `${ct}|${s.id}`,
        kind: 'customer+service',
        id: `combo-${ct}-${slug}`,
        path: `/services/${ct}-${slug}/`,
        title: `${name} in Mobile, AL | Zoiris`,
        h1: `${name} in Mobile, AL`,
        primaryKeyword: kw,
        refs: { serviceId: s.id, customerType: ct, locationId: PRIMARY_LOCATION },
        existingPageId: existing?.id ?? (rec === 'covered-by-existing' ? svcPage?.id ?? null : null),
        recommendation: rec,
        reasons
      });
    }
  }

  for (const i of items) {
    for (const l of locations) {
      const kw = `${i.name.toLowerCase()} removal ${l.name} ${l.state}`;
      const itemPath = l.id === PRIMARY_LOCATION ? `/items/${i.id}-removal/` : `/areas/${l.id}/items/${i.id}-removal/`;
      const reasons: string[] = [];
      let rec: Recommendation = 'create-draft';
      const itemPage = i.pageId ? pageById.get(i.pageId) : undefined;
      const existing = findByPath(itemPath) ?? findByKeyword(kw);
      if (existing) {
        rec = 'exists';
        reasons.push(`Already targeted by ${existing.id}.`);
      } else if (i.acceptance === 'not-accepted') {
        rec = 'blocked';
        reasons.push('Item is not accepted — never create a page that implies pickup.');
      } else if (i.acceptance === 'unknown') {
        rec = 'blocked';
        reasons.push('Item acceptance is unknown — owner approval required first.');
      } else if (itemPage && l.id === PRIMARY_LOCATION) {
        rec = 'covered-by-existing';
        reasons.push(`${itemPage.path} already answers this item for Mobile.`);
      } else if (l.coverage !== 'active') {
        rec = 'blocked';
        reasons.push(`Coverage for ${l.name} is "${l.coverage}".`);
      } else {
        reasons.push('Only create an item + location page if local disposal/handling rules differ meaningfully.');
      }
      out.push({
        key: `${i.id}|${l.id}`,
        kind: 'item+city',
        id: `item-${i.id}-${l.id}`,
        path: itemPath,
        title: `${i.name} Removal in ${l.name}, ${l.state} | Zoiris`,
        h1: `${i.name} Removal in ${l.name}, ${l.state}`,
        primaryKeyword: kw,
        refs: { itemIds: [i.id], serviceId: i.serviceId ?? undefined, locationId: l.id, countyId: l.countyId },
        existingPageId: existing?.id ?? itemPage?.id ?? null,
        recommendation: rec,
        reasons
      });
    }
  }
  return out;
}

/** Builds an "idea" record for a candidate (`robotsIndex: false` until approved). */
export function candidateToRecord(c: MatrixCandidate, today: string): PageRecord {
  const parentId = c.refs.neighborhoodId ? `nb-${c.refs.neighborhoodId}` : c.refs.locationId && c.refs.locationId !== PRIMARY_LOCATION ? `loc-${c.refs.locationId}` : 'core-services';
  return {
    id: c.id,
    type: c.kind === 'item+city' ? 'item' : 'combo',
    path: c.path,
    status: 'idea',
    refs: c.refs,
    seo: {
      title: c.title,
      description: '',
      h1: c.h1,
      primaryKeyword: c.primaryKeyword,
      secondaryKeywords: [],
      intent: 'transactional',
      robotsIndex: false,
      robotsFollow: true,
      schemaTypes: ['Service', 'BreadcrumbList']
    },
    breadcrumb: { label: c.h1, parentId },
    purpose: '',
    related: [],
    workflow: {
      createdAt: today,
      updatedAt: today,
      approvedBy: null,
      approvedAt: null,
      reviewNotes: `Generated by the page matrix. ${c.reasons.join(' ')}`,
      ownerVerification: ['Confirm service availability for this location.', 'Supply first-party local details (real jobs, photos with permission, access notes).'],
      history: [{ at: today, from: 'idea', to: 'idea', by: 'matrix-generator', note: 'Candidate created' }]
    }
  };
}
