/**
 * tests/seo.test.mjs
 * Automated technical SEO, Regional Geography (Mobile & Baldwin Counties),
 * structured data, quality gate, keyword cannibalization, sitemap, robots.txt,
 * canonical, and redirect verification tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR, loadData } from '../scripts/lib/load-data.mjs';
import { auditSite } from '../src/lib/audit.ts';
import { evaluatePage, screenClaims, buildShingleIndex, similarity } from '../src/lib/page-quality.ts';
import { sitemapEntries, sitemapXml, sitemapIndexXml, SITEMAP_LIMIT } from '../src/lib/sitemap.ts';
import { organizationNode, localBusinessNode, serviceNode, articleNode, breadcrumbNode, websiteNode, graph } from '../src/lib/schema.ts';
import { proposeCandidates, candidateToRecord } from '../src/lib/matrix.ts';

const data = loadData();
const site = data.business.website.replace(/\/+$/, '');

const EXPECTED_BALDWIN_MUNICIPALITIES = [
  'Bay Minette',
  'Daphne',
  'Elberta',
  'Fairhope',
  'Foley',
  'Gulf Shores',
  'Loxley',
  'Magnolia Springs',
  'Orange Beach',
  'Perdido Beach',
  'Robertsdale',
  'Silverhill',
  'Spanish Fort',
  'Summerdale'
];

const EXPECTED_BALDWIN_COMMUNITIES = [
  'Belforest',
  'Historic Marlow',
  'Fish River',
  'Barnwell',
  'Battles Wharf',
  'Point Clear',
  'Montrose'
];

describe('Technical SEO, Regional Geography & Content Quality Gate', () => {
  it('passes site-wide SEO audit with 0 errors and 0 warnings across all 86 records (49 published)', () => {
    const audit = auditSite(data);
    assert.equal(audit.counts.errors, 0, `Expected 0 errors, got: ${JSON.stringify(audit.issues.filter((i) => i.level === 'error'))}`);
    assert.equal(audit.counts.warnings, 0, `Expected 0 warnings, got: ${JSON.stringify(audit.issues.filter((i) => i.level === 'warning'))}`);
    assert.equal(audit.indexable.length, 49);
    assert.equal(audit.counts.total, 86);
  });

  it('maintains verified Mobile County & Baldwin County geographic databases with strict 5-tier classifications and 6-state coverage controls', () => {
    assert.equal(data.counties.length, 2);
    assert.ok(data.counties.some((c) => c.id === 'mobile-county-al'));
    assert.ok(data.counties.some((c) => c.id === 'baldwin-county-al'));

    // All 14 incorporated Baldwin County municipalities must exist with verified classifications
    for (const muniName of EXPECTED_BALDWIN_MUNICIPALITIES) {
      const rec = data.locations.find((l) => l.name === muniName && l.countyId === 'baldwin-county-al');
      assert.ok(rec, `Missing Baldwin County municipality: ${muniName}`);
      assert.equal(rec.classification, 'incorporated-municipality');
      assert.equal(rec.coverage, 'research-only', `${muniName} must default to research-only until owner-activated`);
      assert.ok(rec.source && rec.lastVerifiedAt, `${muniName} must include source and verification date`);
    }

    // All 7+ requested unincorporated Baldwin County communities must exist
    for (const commName of EXPECTED_BALDWIN_COMMUNITIES) {
      const rec = data.locations.find((l) => l.name === commName && l.countyId === 'baldwin-county-al');
      assert.ok(rec, `Missing Baldwin County community: ${commName}`);
      assert.ok(['recognized-community', 'unincorporated-area'].includes(rec.classification));
      assert.equal(rec.coverage, 'research-only');
    }

    // Mobile, AL is active; all 20 Mobile neighborhoods/districts carry verified classifications
    const mobile = data.locations.find((l) => l.id === 'mobile-al');
    assert.ok(mobile);
    assert.equal(mobile.coverage, 'active');
    assert.equal(data.neighborhoods.length, 20);
    const validClassifications = new Set([
      'incorporated-municipality',
      'official-neighborhood',
      'recognized-community',
      'local-area-name',
      'unincorporated-area'
    ]);
    const validCoverage = new Set([
      'active',
      'available-on-confirmation',
      'limited',
      'temporarily-unavailable',
      'not-serviced',
      'research-only'
    ]);
    for (const nb of data.neighborhoods) {
      assert.ok(validClassifications.has(nb.classification), `Invalid classification on ${nb.id}: ${nb.classification}`);
      assert.ok(validCoverage.has(nb.coverage), `Invalid coverage status on ${nb.id}: ${nb.coverage}`);
    }
    const westMobile = data.neighborhoods.find((n) => n.id === 'west-mobile');
    assert.equal(westMobile.coverage, 'available-on-confirmation', 'West Mobile spans unincorporated border areas and requires address confirmation');

    // Research-only locations and unapproved neighborhood drafts must never produce indexable public pages
    const audit = auditSite(data);
    const indexableSet = new Set(audit.indexable);
    for (const p of data.pages) {
      const loc = p.refs.locationId ? data.locations.find((l) => l.id === p.refs.locationId) : null;
      if (loc && loc.coverage === 'research-only') {
        assert.equal(indexableSet.has(p.id), false, `Research-only location page ${p.id} (${p.path}) must never be indexable!`);
      }
      if (p.refs.neighborhoodId) {
        assert.equal(indexableSet.has(p.id), false, `Unverified neighborhood draft ${p.id} must remain non-indexable until 2+ localEvidence items are approved!`);
      }
    }
  });

  it('enforces business phone number 251-930-8621 and service-area-business honesty', () => {
    assert.equal(data.business.phoneDisplay, '251-930-8621');
    assert.equal(data.business.phoneE164, '+12519308621');
    assert.equal(data.business.phoneHref, 'tel:+12519308621');
    assert.equal(data.business.serviceAreaBusiness, true);
    assert.equal(data.business.address, null);
    assert.equal(data.business.hours, null);
    for (const [k, v] of Object.entries(data.business.claims)) {
      assert.equal(v, false, `Unverified claim "${k}" must remain false until documented by owner.`);
    }
  });

  it('screens out fabricated claims, foreign phone numbers, and fake stars while permitting honest negations', () => {
    const badText = 'Call 251-555-0199 for 24/7 emergency same-day service! Rated 4.9 stars (200+ reviews). R2 certified recycler.';
    const hits = screenClaims(badText, data.business);
    assert.ok(hits.length >= 4, `Expected multiple claim violations, got ${hits.length}`);

    const honestNegation = 'Data destruction and document shredding are not offered. We do not advertise 24/7 service or same-day pickup. Call 251-930-8621.';
    const cleanHits = screenClaims(honestNegation, data.business);
    assert.equal(cleanHits.length, 0, `Expected 0 hits for honest negation, got: ${JSON.stringify(cleanHits)}`);
  });

  it('prevents thin or unverified pages from passing the quality gate', () => {
    const draft = data.pages.find((p) => p.status === 'research' || p.status === 'idea');
    assert.ok(draft, 'Expected pipeline candidate record');
    const report = evaluatePage(draft, { data });
    assert.equal(report.passesGate, false, 'Research/idea record without verified local evidence or full content must not pass gate');
  });

  it('maintains near-zero 5-word shingle overlap across all published pages', () => {
    const published = data.pages.filter((p) => p.status === 'published');
    const idx = buildShingleIndex(published);
    const ids = [...idx.keys()];
    let maxOverlap = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sim = similarity(idx.get(ids[i]), idx.get(ids[j]));
        if (sim > maxOverlap) maxOverlap = sim;
      }
    }
    assert.ok(maxOverlap < 0.2, `Expected max shingle overlap < 20%, got ${(maxOverlap * 100).toFixed(1)}%`);
  });

  it('generates accurate JSON-LD without fabricated addresses, hours, or aggregate ratings', () => {
    const activeLocs = data.locations.filter((l) => l.coverage === 'active');
    const lb = localBusinessNode(data.business, site, activeLocs, data.services);
    const org = organizationNode(data.business, site);
    const web = websiteNode(data.business, site);
    const svcPage = data.pages.find((p) => p.id === 'svc-furniture-removal');
    const svcEntity = data.services.find((s) => s.id === 'furniture-removal');
    const svc = serviceNode(svcPage, svcEntity, site, activeLocs);
    const artPage = data.pages.find((p) => p.id === 'guide-prepare-computer-for-recycling');
    const art = articleNode(artPage, site);
    const crumbs = breadcrumbNode(
      [
        { label: 'Home', path: '/' },
        { label: 'Services', path: '/services/' },
        { label: 'Furniture Removal', path: '/services/furniture-removal/' }
      ],
      site
    );

    const serialized = graph([org, web, lb, svc, art, crumbs]);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed['@context'], 'https://schema.org');
    assert.ok(!serialized.includes('PostalAddress'));
    assert.ok(!serialized.includes('openingHours'));
    assert.ok(!serialized.includes('aggregateRating'));
    assert.ok(serialized.includes('+12519308621'));
    assert.equal(activeLocs.length, 1);
    assert.equal(activeLocs[0].name, 'Mobile');
  });

  it('proposes hierarchical matrix candidates (/areas/<city>/<service>/ and /areas/mobile-al/<neighborhood>/<service>/) with cannibalization and coverage guardrails', () => {
    const candidates = proposeCandidates(data, {
      serviceIds: ['furniture-removal', 'residential-junk-removal', 'appliance-removal'],
      itemIds: ['refrigerators-freezers'],
      locationIds: ['mobile-al', 'saraland-al', 'daphne-al'],
      neighborhoodIds: ['midtown-mobile', 'west-mobile'],
      customerTypes: ['residential']
    });
    assert.ok(candidates.length > 0);
    const existsHit = candidates.find((c) => c.recommendation === 'exists');
    const coveredHit = candidates.find((c) => c.recommendation === 'covered-by-existing');
    assert.ok(existsHit, 'Expected exact primary keyword match to return exists');
    assert.ok(coveredHit, 'Expected Mobile, AL service overlap to return covered-by-existing');

    // Hierarchical regional URL format check
    const saraland = candidates.find((c) => c.path === '/areas/saraland-al/appliance-removal/');
    assert.ok(saraland, 'Expected hierarchical /areas/saraland-al/appliance-removal/ path');
    assert.equal(saraland.recommendation, 'blocked');
    const rec = candidateToRecord(saraland, '2026-11-04');
    assert.equal(rec.status, 'idea');

    const midtown = candidates.find((c) => c.path === '/areas/mobile-al/midtown-mobile/appliance-removal/');
    assert.ok(midtown, 'Expected hierarchical /areas/mobile-al/midtown-mobile/appliance-removal/ path');
    assert.equal(midtown.recommendation, 'create-draft');

    const westMobileCand = candidates.find((c) => c.path === '/areas/mobile-al/west-mobile/appliance-removal/');
    assert.ok(westMobileCand, 'Expected hierarchical /areas/mobile-al/west-mobile/appliance-removal/ path');
    assert.equal(westMobileCand.recommendation, 'blocked');
  });

  it('builds valid XML sitemap and sitemap index XML excluding /owner/, /admin/, /404/, and research-only routes', () => {
    const audit = auditSite(data);
    const entries = sitemapEntries(data.pages, new Set(audit.indexable), site);
    assert.equal(entries.length, 49);
    const xml = sitemapXml(entries);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('http://www.sitemaps.org/schemas/sitemap/0.9'));
    assert.ok(!xml.includes('/404/'));
    assert.ok(!xml.includes('/admin'));
    assert.ok(!xml.includes('/owner'));
    assert.ok(!xml.includes('/areas/daphne-al/'));
    for (const r of data.redirects) {
      assert.ok(!xml.includes(`${site}${r.from}`), `Redirect ${r.from} must not appear in sitemap.xml`);
    }

    assert.equal(SITEMAP_LIMIT, 50000);
    const idxXml = sitemapIndexXml(site, ['/sitemap-1.xml', '/sitemap-2.xml'], '2026-11-04');
    assert.ok(idxXml.includes('<sitemapindex'));
    assert.ok(idxXml.includes(`${site}/sitemap-1.xml`));
  });

  it('verifies built dist/sitemap.xml, dist/robots.txt (/owner/ and /api/ disallowed), dist/_redirects, and dist/_headers', () => {
    assert.ok(existsSync(join(DIST_DIR, 'sitemap.xml')), 'dist/sitemap.xml must exist');
    assert.ok(existsSync(join(DIST_DIR, 'robots.txt')), 'dist/robots.txt must exist');
    assert.ok(existsSync(join(DIST_DIR, '_redirects')), 'dist/_redirects must exist');
    assert.ok(existsSync(join(DIST_DIR, '_headers')), 'dist/_headers must exist');

    const robots = readFileSync(join(DIST_DIR, 'robots.txt'), 'utf8');
    assert.ok(robots.includes('Allow: /'));
    assert.ok(robots.includes('Disallow: /owner/'));
    assert.ok(robots.includes('Disallow: /api/'));
    assert.ok(robots.includes('Disallow: /admin/'));
    assert.ok(robots.includes(`Sitemap: ${site}/sitemap.xml`));

    const redirectsTxt = readFileSync(join(DIST_DIR, '_redirects'), 'utf8');
    for (const r of data.redirects) {
      assert.ok(redirectsTxt.includes(`${r.from}  ${r.to}  ${r.status}`));
    }
  });
});
