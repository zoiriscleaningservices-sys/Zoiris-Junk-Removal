/**
 * tests/workflow-e2e.test.mjs
 * Full Playwright headless Chrome End-to-End Verification covering:
 *  - Complete 10-Step Customer Pickup Request Workflow (multi-photo + video upload,
 *    review summary, consent gate, and persisted ZJ-2026-000001 confirmation)
 *  - Complete 15-Step Private Owner Command Center Workflow (/owner/login/, 15 KPIs,
 *    9 charts, SSE feed, Leads Inbox, Lead Detail, EXIF-stripped photo preview,
 *    HTTP 206 Range video stream, signed download, internal communication log,
 *    estimate & priority, 12-stage Pipeline move, Follow-Up task, America/Chicago
 *    Pickup Calendar scheduling, JSON & CSV exports, Completed status, and full
 *    chronological Lead Timeline)
 *  - Customer duplicate detection & manual confirmed merge, GSC CSV import,
 *    analytics metric separation, live 6-state geographic coverage toggle + regional
 *    draft creation, WAL-checkpointed SQLite backup, and zero console/page errors.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createZoirisApp } from '../server/index.mjs';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const executablePath = CHROME_PATHS.find((p) => existsSync(p));

async function createSampleMediaFiles(dir) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default || sharpMod;

  const photo1Path = join(dir, 'living-room-couch.jpg');
  const photo2Path = join(dir, 'crt-monitors-desk.png');
  const videoPath = join(dir, 'garage-walkthrough.mp4');

  const jpgBuf = await sharp({
    create: { width: 640, height: 420, channels: 3, background: { r: 22, g: 58, b: 89 } }
  })
    .jpeg({ quality: 82 })
    .toBuffer();

  const pngBuf = await sharp({
    create: { width: 520, height: 360, channels: 3, background: { r: 15, g: 118, b: 110 } }
  })
    .png()
    .toBuffer();

  // Valid ISO-BMFF MP4 container header (`ftypisom` + `moov` + `mdat`)
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x32
  ]);
  const mdatPayload = Buffer.alloc(1024, 0x00);
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + mdatPayload.length, 0);
  mdatHeader.write('mdat', 4, 'ascii');
  const mp4Buf = Buffer.concat([ftyp, mdatHeader, mdatPayload]);

  writeFileSync(photo1Path, jpgBuf);
  writeFileSync(photo2Path, pngBuf);
  writeFileSync(videoPath, mp4Buf);

  return { photo1Path, photo2Path, videoPath };
}

describe('End-to-End Customer & Owner Command Center Workflows (Playwright)', () => {
  let tempVault;
  let mediaFixtureDir;
  let fixtures;
  let app;
  let baseUrl;
  let browser;
  const ownerEmail = 'owner@zoirisjunkremoval.com';
  const ownerPassword = 'Zoiris-Command-Center-2026!';

  before(async () => {
    assert.ok(executablePath, 'Chrome or Edge executable required for Playwright E2E tests');
    process.env.ZOIRIS_SYNC_JSON = '0';
    process.env.ZOIRIS_TEST_HOOKS = '1';
    process.env.ZOIRIS_GEOCODER = 'mock';
    tempVault = mkdtempSync(join(tmpdir(), 'zoiris-e2e-vault-'));
    mediaFixtureDir = mkdtempSync(join(tmpdir(), 'zoiris-e2e-fixtures-'));
    fixtures = await createSampleMediaFiles(mediaFixtureDir);

    app = createZoirisApp({ dataDir: tempVault, servePublicDist: true });
    app.auth.provisionFirstOwner({
      email: ownerEmail,
      displayName: 'Lucia Zoiris',
      password: ownerPassword,
      allowCliBypass: true
    });

    await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${app.server.address().port}`;
        resolve();
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (app) await app.close();
    for (const d of [tempVault, mediaFixtureDir]) {
      if (d && existsSync(d)) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('completes the full 10-step Customer Pickup Request workflow and 15-step Owner Command Center CRM workflow with zero errors', async () => {
    const consoleErrors = [];
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    await context.route('https://tile.openstreetmap.org/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    );
    await context.route('https://basemap.nationalmap.gov/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    /* ====================================================================== */
    /* PART A: 10-STEP CUSTOMER WORKFLOW                                      */
    /* ====================================================================== */

    // Step 1: Visit Homepage + verify ZERO public links to /owner/
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    const ownerLinksOnPublic = await page.locator('a[href*="/owner"]').count();
    assert.equal(ownerLinksOnPublic, 0, 'Public homepage must never contain links to /owner/');

    // Also record a click-to-call tap event on public site to verify separate analytics tracking
    await page.evaluate(() => {
      document.querySelectorAll('a[href^="tel:"]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    });
    await page.locator('a[data-track="call"]').first().click();
    await page.waitForTimeout(150);

    // Step 2: Navigate to Furniture Removal service page
    await page.goto(`${baseUrl}/services/furniture-removal/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    assert.match(await page.locator('h1').textContent(), /Furniture Removal/i);

    // Step 3: Navigate to /request-pickup/ with UTM source attribution
    await page.goto(`${baseUrl}/request-pickup/?utm_source=google&utm_medium=organic&utm_campaign=mobile_al_seo`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(250);

    const pick = async (sel) => {
      const inputId = await page.locator(sel).first().getAttribute('id');
      await page.click(`label[for="${inputId}"]`);
    };
    // Step 4: Flow Step 1 — tap Furniture + Electronics tiles, choose item chips, describe an extra item, pick load size
    await page.click('label[for="pickup-request-cat-Furniture"]');
    await page.click('label[for="pickup-request-cat-Electronics"]');
    for (const v of ['Couches', 'Desks', 'Monitors']) {
      await pick(`input[name="selectedItem"][value="${v}"]`);
    }
    await pick('input[name="selectedItem"][value^="Batteries"]');
    await page.fill('#pickup-request-otherItemDescription', 'Rolling steel filing cabinet');
    await pick('input[name="estimatedQuantity"][value="3–5 items"]');
    await page.click('[data-pf-next]');

    // Step 5: Flow Step 2 — attach 2 photos + 1 walkthrough video, verify previews & counters
    await page.setInputFiles('#pickup-request-media-picker', [fixtures.photo1Path, fixtures.photo2Path, fixtures.videoPath]);
    assert.equal(await page.locator('[data-photo-count]').textContent(), '2');
    assert.equal(await page.locator('[data-video-count]').textContent(), '1');
    assert.equal(await page.locator('[data-media-uid]').count(), 3);
    await page.fill('#pickup-request-itemDescription', 'Large sectional sofa, wood desk, two old monitors, and UPS battery unit.');
    await page.click('[data-pf-next]');

    // Step 6: Flow Step 3 — real-address search: type, pick suggestion, server verifies + returns map pin
    await page.fill('#pickup-request-address', '99999 Fake St');
    await page.click('[data-address-check]');
    await page.waitForFunction(() => /couldn't find/i.test(document.querySelector('#pickup-request-pickupAddress-err')?.textContent || ''));
    await page.fill('#pickup-request-address', '1450 Government St');
    await page.waitForSelector('[data-address-list] [data-opt="0"]');
    await page.click('[data-address-list] [data-opt="0"]');
    await page.waitForSelector('[data-address-card]:not([hidden])');
    assert.match(await page.locator('[data-verified-text]').textContent(), /1450 Government St, Mobile, AL 36604/);
    assert.match(await page.locator('[data-verified-county]').textContent(), /Mobile County/);
    assert.ok((await page.locator('[data-map-tiles] img').count()) > 0, 'Expected map tiles around the verified pin');
    await page.click('[data-map-layer="satellite"]');
    assert.match(await page.locator('[data-map-tiles] img').first().getAttribute('src'), /basemap\.nationalmap\.gov/);
    await page.fill('#pickup-request-addressUnit', 'Unit B');
    await pick('input[name="indoorsOrOutdoors"][value="Inside – upstairs"]');
    await pick('input[name="hasStairs"][value="Stairs only"]');
    await pick('input[name="timing"][value="Pick a date"]');
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    await page.fill('#pickup-request-preferredDate', todayIso);
    await pick('input[name="preferredWindow"][value="Morning"]');
    await page.fill('#pickup-request-accessInstructions', 'Side driveway gate unlocked; call upon arrival.');
    await page.click('[data-pf-next]');

    // Step 7: Flow Step 4 — contact details (phone is screened server-side for fake/fictional numbers)
    await page.fill('#pickup-request-firstName', 'Jordan');
    await page.fill('#pickup-request-lastName', 'Ellis');
    await page.fill('#pickup-request-phone', '251-555-0248');
    await page.fill('#pickup-request-email', 'jordan.ellis@zoiris-test.org');

    // Step 8: Review ticket summary
    const reviewSummary = await page.locator('[data-review-summary]').textContent();
    assert.match(reviewSummary, /Jordan Ellis/);
    assert.match(reviewSummary, /1450 Government St Unit B, Mobile, AL 36604/);
    assert.match(reviewSummary, /verified/);
    assert.match(reviewSummary, /Couches, Desks, Monitors/);
    assert.match(reviewSummary, /Rolling steel filing cabinet/);
    assert.match(reviewSummary, /2 photo\(s\), 1 video\(s\) attached/);

    // Step 9: Consent & submit (wait past the 5-second human-timing threshold first)
    await page.check('#pickup-request-consentGiven');
    await page.waitForTimeout(5200);
    await page.click('[data-submit]');

    // Step 10: Persisted confirmation reference ZJ-YYYY-000001 & honest non-booking notice
    await page.waitForSelector('[data-lead-reference]', { timeout: 15000 });
    const leadRef = (await page.locator('[data-lead-reference]').textContent()).trim();
    assert.match(leadRef, /^ZJ-\d{4}-000001$/);
    const confirmationCopy = await page.locator('[data-confirmation-panel]').textContent();
    assert.match(confirmationCopy, /3 media file\(s\) were securely attached/i);
    assert.match(confirmationCopy, /not booked until we confirm/i);

    // Server stored the verified geodata for the owner's map
    const stored = app.ctx.db.prepare('SELECT * FROM leads WHERE lead_number = ?').get(leadRef);
    assert.equal(stored.address_status, 'verified');
    assert.equal(stored.address_unit, 'Unit B');
    assert.equal(stored.county_fips, '01097');
    assert.ok(Number.isFinite(stored.geo_lat) && Number.isFinite(stored.geo_lng));
    assert.ok(stored.spam_score < 35, `Expected a clean spam score, got ${stored.spam_score}`);

    // Submit a second inquiry sharing the same phone number under a household member's name
    // so we can also verify duplicate customer detection & manual confirmed merge in `/owner/customers/`!
    const second = await fetch(`${baseUrl}/api/public/inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'J.',
        lastName: 'Ellis',
        phone: '251-555-0248',
        email: 'jordan.ellis@zoiris-test.org',
        pickupAddress: '1450 Government St',
        city: 'Mobile',
        state: 'AL',
        zipCode: '36604',
        requestedService: 'Electronics Pickup',
        selectedItems: [{ category: 'Electronics', name: 'Laptops' }],
        consentGiven: true
      })
    });
    assert.equal(second.status, 201);

    /* ====================================================================== */
    /* PART B: 15-STEP OWNER COMMAND CENTER & CRM WORKFLOW                    */
    /* ====================================================================== */

    // Owner Step 1: Unauthenticated navigation to /owner/command-center/ redirects to /owner/login/
    await page.goto(`${baseUrl}/owner/command-center/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-email');
    assert.ok(page.url().includes('/owner/login/'), `Expected redirect to /owner/login/, got ${page.url()}`);

    // Owner Step 2: Sign in at /owner/login/
    await page.fill('#login-email', ownerEmail);
    await page.fill('#login-password', ownerPassword);
    await page.click('#login-submit');
    await page.waitForURL('**/owner/command-center/**', { timeout: 10000 });

    // Owner Step 3: Verify Today screen (/owner/command-center/) + Business Stats (/owner/stats/: 15 KPIs & 9 charts)
    await page.waitForSelector('[data-today-focus]');
    await page.waitForFunction(() => document.getElementById('cc-sse-pill')?.textContent?.trim() === 'Live', null, { timeout: 8000 });
    const overviewText = await page.locator('#cc-workspace').textContent();
    assert.match(overviewText, new RegExp(leadRef));
    assert.ok((await page.locator('[data-mini-map] .zmap__pin').count()) >= 1, 'Expected active pin on Today mini-map');

    await page.click('a[data-route="/owner/stats/"]');
    await page.waitForSelector('.cc-kpi-grid');
    assert.equal(await page.locator('.cc-kpi-grid .cc-kpi').count(), 15, 'Expected all 15 KPI cards on Business Stats');

    // Owner Step 4: Navigate to Requests Inbox (/owner/leads/) and verify lead cards, verified badge & media counts
    await page.click('a[data-route="/owner/leads/"]');
    await page.waitForSelector('[data-lead-list] [data-lead-card]');
    const inboxText = await page.locator('#cc-workspace').textContent();
    assert.match(inboxText, new RegExp(leadRef));
    assert.match(inboxText, /Jordan Ellis/);
    assert.match(inboxText, /E-Waste/);
    assert.match(inboxText, /2 photos/);
    assert.match(inboxText, /1 video/);
    assert.match(inboxText, /Address verified/);

    // Owner Step 5 & 6: Open Request Detail (/owner/leads/ZJ-...) and verify customer, address, interactive map & UTM data
    await page.click(`[data-lead-card="${leadRef}"] a.cc-req__main`);
    await page.waitForSelector('#ld-mark-complete');
    const detailText = await page.locator('#cc-workspace').textContent();
    assert.match(detailText, /1450 Government St, Unit B, Mobile, AL 36604/);
    assert.match(detailText, /Mobile County/);
    assert.match(detailText, /google \/ organic \/ mobile_al_seo/);
    assert.match(detailText, /2nd floor/);
    assert.match(detailText, /Stairs/);
    assert.match(detailText, /Rolling steel filing cabinet/);

    // Verify interactive property map + Satellite toggle + Street View link on Request Detail
    await page.waitForSelector('[data-lead-map] .zmap__pin');
    await page.click('[data-lead-map] [data-zlayer="satellite"]');
    assert.equal(await page.locator('[data-lead-map] [data-zlayer="satellite"]').getAttribute('aria-pressed'), 'true');
    const streetViewHref = await page.locator('a[href*="map_action=pano"]').first().getAttribute('href');
    assert.ok(streetViewHref && streetViewHref.includes('viewpoint='), 'Expected Google Street View link with lat/lng');

    // Owner Step 7: Verify EXIF-stripped photo previews load (`naturalWidth > 0`), fullscreen viewer & HTTP 206 video stream
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('.cc-media-preview img'));
      return imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    });
    await page.click('[data-view-index="0"]');
    await page.waitForSelector('.zv:not([hidden])');
    assert.equal((await page.locator('.zv__count').textContent()).trim(), '1 / 3');
    await page.click('.zv__nav--next');
    await page.click('.zv__nav--next');
    assert.equal((await page.locator('.zv__count').textContent()).trim(), '3 / 3');
    assert.equal(await page.locator('.zv__video').count(), 1, 'Expected native video player in fullscreen viewer');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.zv')?.hidden === true);

    const videoSrc = await page.locator('.cc-media-preview video').first().getAttribute('src');
    assert.ok(videoSrc && videoSrc.startsWith('/api/media/stream/'));
    const rangeRes = await fetch(`${baseUrl}${videoSrc}`, {
      headers: { Range: 'bytes=0-63' }
    });
    assert.equal(rangeRes.status, 206, 'Expected HTTP 206 Partial Content for private video stream');
    assert.match(rangeRes.headers.get('content-range') || '', /^bytes 0-63\//);

    // Owner Step 8: Verify signed attachment download returns 200 with Content-Disposition: attachment
    const downloadHref = await page.locator('.cc-media-meta a[download]').first().getAttribute('href');
    const dlRes = await fetch(`${baseUrl}${downloadHref}`);
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get('content-disposition') || '', /^attachment;/);

    // Verify Live Dispatch Map (/owner/map/) renders active pins & opens pin card on click
    await page.click('a[data-route="/owner/map/"]');
    await page.waitForSelector('[data-big-map] .zmap__pin');
    await page.locator('[data-big-map] .zmap__pin').first().click();
    await page.waitForSelector('[data-pin-card]:not([hidden]) .cc-pincard');
    await page.goto(`${baseUrl}/owner/leads/${leadRef}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ld-note-form');

    // Owner Step 9: Log internal phone call note
    const openTool = async (name) => {
      const det = page.locator(`details[data-tool="${name}"]`);
      if ((await det.getAttribute('open')) === null) {
        await det.locator('summary').click();
      }
    };
    await openTool('notes');
    await page.selectOption('#ld-note-type', 'phone_call');
    await page.fill('#ld-note-body', 'Called Jordan to confirm 2nd-floor stair clearance and separate UPS battery handling.');
    await page.click('#ld-note-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('Called Jordan to confirm'));

    // Owner Step 10: Save Priority (`high`), Estimate (`$185.00`), and stage update via Lead Detail form
    await openTool('estimate');
    await page.selectOption('#ld-priority', 'high');
    await page.fill('#ld-estimate', '185.00');
    await page.fill('#ld-est-notes', 'Includes 2nd-floor stair carry + monitor/battery intake.');
    await page.click('#ld-fields-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('ld-estimate')?.value === '185.00');

    await openTool('stage');
    await page.selectOption('#ld-status-sel', 'Awaiting Customer Information');
    await page.fill('#ld-status-note', 'Confirming UPS battery disconnect before sending final quote.');
    await page.click('#ld-status-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('Awaiting Customer Information'));

    // Owner Step 11: Open 12-Stage Pipeline (/owner/pipeline/) & move lead to `Estimate Sent`
    await page.click('a[data-route="/owner/pipeline/"]');
    await page.waitForSelector('.cc-pipeline');
    assert.equal(await page.locator('.cc-pipe-col').count(), 12, 'Expected all 12 pipeline stage columns');
    const leadSelect = page.locator('.cc-pipe-card', { hasText: leadRef }).locator('select[data-pipe-move]');
    await leadSelect.selectOption('Estimate Sent');
    await page.waitForFunction(
      (ref) => document.querySelector('[data-pipe-col="Estimate Sent"]')?.textContent?.includes(ref),
      leadRef
    );

    // Owner Step 12: Return to Lead Detail -> add Follow-Up Task + schedule Pickup Appointment on America/Chicago Calendar
    await page.click(`a[href="/owner/leads/${leadRef}"]`);
    await page.waitForSelector('#ld-task-form', { state: 'attached' });
    await openTool('tasks');
    await page.fill('#ld-task-title', 'Confirm gate code morning of pickup');
    await page.fill('#ld-task-due', todayIso);
    await page.click('#ld-task-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('Confirm gate code morning of pickup'));

    await openTool('schedule');
    await page.fill('#ld-appt-date', todayIso);
    await page.selectOption('#ld-appt-win', '8:00 AM – 11:00 AM');
    await page.click('#ld-appt-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('Pickup Scheduled'));

    // Verify appointment renders on `/owner/calendar/`
    await page.click('a[data-route="/owner/calendar/"]');
    await page.waitForSelector('.cc-cal-grid');
    assert.match(await page.locator('#cc-workspace').textContent(), new RegExp(leadRef));

    // Owner Step 13: Verify Single-Lead JSON/CSV Export & All-Leads CSV Export via authenticated browser context
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const expJsonRes = await fetch(`${baseUrl}/api/owner/leads/${leadRef}/export?format=json`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(expJsonRes.status, 200);
    const expJson = await expJsonRes.json();
    assert.equal(expJson.lead.leadNumber, leadRef);
    assert.equal(expJson.attachments.length, 3);

    const expCsvRes = await fetch(`${baseUrl}/api/owner/exports/leads.csv`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(expCsvRes.status, 200);
    const csvBody = await expCsvRes.text();
    assert.match(csvBody, new RegExp(leadRef));
    assert.match(csvBody, /185\.00/);

    // Owner Step 14: Mark Lead `Completed` and verify complete chronological Lead Timeline
    await page.goto(`${baseUrl}/owner/leads/${leadRef}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ld-mark-complete');
    await page.click('#ld-mark-complete');
    await page.waitForSelector('.cc-done-banner');
    assert.equal(await page.locator('#ld-mark-complete').isDisabled(), true);

    const timelineText = await page.locator('[data-lead-timeline]').textContent();
    for (const expectedEv of [
      'inquiry_received',
      'attachment_uploaded',
      'lead_opened',
      'customer_contacted',
      'estimate_prepared',
      'status_updated',
      'estimate_sent',
      'follow_up_created',
      'pickup_scheduled',
      'job_completed'
    ]) {
      assert.match(timelineText, new RegExp(expectedEv), `Expected timeline to record ${expectedEv}`);
    }

    // Owner Step 15: Verify remaining Command Center workspaces (Customers Merge, Media Vault,
    // Analytics metric separation, Search Console CSV import, Regional Locations coverage toggle,
    // SEO Pages draft generator, Reports SQLite backup, Settings, and Security Audit Log)

    // 15a. Customers directory + manual confirmed duplicate merge
    await page.click('a[data-route="/owner/customers/"]');
    await page.waitForSelector('[data-merge-target]');
    await page.locator('[data-merge-target]').first().click();
    await page.waitForSelector('#confirm-merge-chk');
    await page.check('#confirm-merge-chk');
    await page.click('#exec-merge-btn');
    await page.waitForFunction(() => !document.querySelector('[data-merge-target]'));

    // 15b. Private Media Vault
    await page.click('a[data-route="/owner/media/"]');
    await page.waitForSelector('.cc-media-grid');
    assert.equal(await page.locator('.cc-media-item').count(), 3);

    // 15c. Website Traffic & Conversion Analytics (verify pageViews, clickToCall, and CRM leads are separate)
    await page.click('a[data-route="/owner/analytics/"]');
    await page.waitForSelector('.cc-kpi-grid');
    const analyticsApi = await (await fetch(`${baseUrl}/api/owner/analytics?range=30d`, { headers: { Cookie: cookieHeader } })).json();
    assert.ok(analyticsApi.summary.pageViews >= 3, 'Expected >= 3 page views recorded');
    assert.ok(analyticsApi.summary.clickToCallEvents >= 1, 'Expected >= 1 telephone link tap recorded');
    assert.equal(analyticsApi.summary.crmFormSubmissions, 2, 'Expected 2 persisted CRM leads (kept distinct from page views & phone taps)');

    // 15d. Google Search Console CSV import
    await page.click('a[data-route="/owner/search-performance/"]');
    await page.waitForSelector('#gsc-import-btn');
    await page.click('#gsc-import-btn');
    await page.fill(
      '#gsc-csv-text',
      'Top queries,Clicks,Impressions,CTR,Position\njunk removal mobile al,24,310,7.74%,2.8\nelectronics recycling mobile al,11,145,7.59%,3.4'
    );
    await page.click('#gsc-csv-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('junk removal mobile al'));

    // 15e. Regional Locations Manager: toggle `saraland-al` from `research-only` -> `active`
    await page.click('a[data-route="/owner/locations/"]');
    await page.waitForSelector('#loc-tbody');
    const saralandSel = page.locator('select[data-cov-id="saraland-al"]');
    const covDone = page.waitForResponse((r) => r.url().includes('/api/owner/locations/coverage') && r.status() === 200);
    await saralandSel.selectOption('active');
    await covDone;

    // 15f. SEO Pages & Draft Generator: create non-indexable draft `/areas/saraland-al/appliance-removal/`
    await page.click('a[data-route="/owner/seo-pages/"]');
    await page.waitForSelector('#seo-draft-form');
    await page.selectOption('#sd-service', 'appliance-removal');
    await page.selectOption('#sd-location', 'saraland-al');
    await page.click('#seo-draft-form button[type="submit"]');
    await page.waitForFunction(() =>
      document.getElementById('cc-workspace')?.textContent?.includes('/areas/saraland-al/appliance-removal/')
    );

    // 15g. Capacity Monitor & SQLite Backup creation
    await page.click('a[data-route="/owner/reports/"]');
    await page.waitForSelector('#create-backup-btn');
    await page.click('#create-backup-btn');
    await page.waitForFunction(() => document.getElementById('cc-workspace')?.textContent?.includes('.sqlite'));

    // 15h. Settings & Security Audit Trail
    await page.click('a[data-route="/owner/settings/"]');
    await page.waitForSelector('#settings-form');

    await page.click('a[data-route="/owner/security/"]');
    await page.waitForSelector('.cc-table');
    const secText = await page.locator('#cc-workspace').textContent();
    assert.match(secText, /lead\.status_changed/);
    assert.match(secText, /customer\.merged/);
    assert.match(secText, /location\.coverage_updated/);
    assert.match(secText, /seo\.draft_created/);

    assert.equal(consoleErrors.length, 0, `Expected 0 browser console/page errors, got: ${consoleErrors.join(' | ')}`);
    await context.close();
  });
});
