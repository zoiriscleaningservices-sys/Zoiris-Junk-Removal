/**
 * tests/forms.test.mjs
 * End-to-end browser tests via Playwright + headless Chrome covering:
 *  - 5-Step Customer Pickup Request Wizard validation, multi-select items, access details,
 *    review summary, consent gate, offline static fallback, 500 error recovery, and 200 OK confirmation
 *  - Accepted Items live search & category filter
 *  - Click-to-call dataLayer & telemetry event tracking
 *  - Local SEO Operations Dashboard SPA navigation, editor drawer, and zero console errors
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { DIST_DIR, ROOT } from '../scripts/lib/load-data.mjs';

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
      let file = join(rootDir, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!file.startsWith(rootDir) || !existsSync(file)) {
        const nf = join(rootDir, '404.html');
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(existsSync(nf) ? readFileSync(nf) : 'Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, url: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

describe('Interactive Browser Tests: 5-Step Wizard, Directory, Tracking & SEO Dashboard', () => {
  let staticSrv;
  let adminProc;
  const adminPort = 4492;
  let browser;

  before(async () => {
    assert.ok(executablePath, 'Chrome or Edge executable required for Playwright tests');
    staticSrv = await startStaticServer(DIST_DIR);
    adminProc = spawn(process.execPath, ['admin/server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_PORT: String(adminPort), ADMIN_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Admin server timeout')), 8000);
      adminProc.stdout.on('data', (d) => {
        if (String(d).includes(`127.0.0.1:${adminPort}`)) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    browser = await chromium.launch({ executablePath, headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (staticSrv?.server) staticSrv.server.close();
    if (adminProc && !adminProc.killed) adminProc.kill();
  });

  it('guides customers through the 4-step mobile pickup flow with validation, static-only fallback, 500 recovery, and 200 OK confirmation', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${staticSrv.url}/request-pickup/`, { waitUntil: 'networkidle' });
    const f = '#pickup-request';
    const pick = async (sel) => {
      const inputId = await page.locator(sel).first().getAttribute('id');
      await page.click(`label[for="${inputId}"]`);
    };

    // Mobile call bar is hidden on the form page so it never covers the sticky Continue bar
    assert.equal(await page.locator('.callbar').isVisible(), false);

    // 1. Step 1 empty Continue → item + size errors
    await page.click('[data-pf-next]');
    assert.match(await page.locator(`${f}-items-err`).textContent(), /at least one type/i);
    assert.match(await page.locator(`${f}-estimatedQuantity-err`).textContent(), /how much/i);

    // Tap Furniture + Electronics tiles → chip panels open; pick items + size
    await page.click(`label[for="pickup-request-cat-Furniture"]`);
    await page.click(`label[for="pickup-request-cat-Electronics"]`);
    assert.equal(await page.locator('[data-chips-for="Furniture"]').isVisible(), true);
    await pick('input[name="selectedItem"][value="Couches"]');
    await pick('input[name="selectedItem"][value="Monitors"]');
    await pick('input[name="estimatedQuantity"][value="3–5 items"]');
    assert.equal(await page.locator('[data-truck-label]').textContent(), '3–5 items');
    await page.click('[data-pf-next]');
    assert.equal(await page.locator('[data-step-pane="2"]').isVisible(), true);

    // 2. Photos are optional — the button says so
    assert.match(await page.locator('[data-pf-next-label]').textContent(), /skip photos/i);
    await page.click('[data-pf-next]');
    assert.equal(await page.locator('[data-step-pane="3"]').isVisible(), true);

    // 3. Static preview has no address API → typing falls back to manual entry, which still validates
    await page.fill(`${f}-address`, '850 Dauphin St');
    await page.waitForSelector('[data-manual-address]:not([hidden])');
    await page.fill(`${f}-pickupAddress`, '850 Dauphin St');
    await page.fill(`${f}-zipCode`, '366');
    await page.click('[data-pf-next]');
    assert.equal(await page.getAttribute(`${f}-zipCode`, 'aria-invalid'), 'true');
    assert.match(await page.locator(`${f}-indoorsOrOutdoors-err`).textContent(), /where the items are/i);
    await page.fill(`${f}-zipCode`, '36602');
    await pick('input[name="indoorsOrOutdoors"][value="Inside – upstairs"]');
    assert.equal(await page.locator('[data-stairs-wrap]').isVisible(), true);
    await page.click('[data-pf-next]');
    assert.equal(await page.locator('[data-step-pane="4"]').isVisible(), true);

    // 4. Contact validation, auto phone formatting, review ticket, consent gate
    await page.click('[data-submit]');
    assert.equal(await page.getAttribute(`${f}-firstName`, 'aria-invalid'), 'true');
    assert.equal(await page.getAttribute(`${f}-phone`, 'aria-invalid'), 'true');
    await page.fill(`${f}-firstName`, 'Jordan');
    await page.fill(`${f}-lastName`, 'Taylor');
    await page.fill(`${f}-phone`, '2514380199');
    assert.equal(await page.inputValue(`${f}-phone`), '(251) 438-0199');
    await page.fill(`${f}-email`, 'not-an-email');
    await page.click('[data-submit]');
    assert.equal(await page.getAttribute(`${f}-email`, 'aria-invalid'), 'true');
    await page.fill(`${f}-email`, 'jordan@zoiris-test.org');
    const review = await page.locator('[data-review-summary]').textContent();
    assert.match(review, /Couches, Monitors/);
    assert.match(review, /850 Dauphin St, Mobile, AL 36602/);
    await page.click('[data-submit]');
    assert.equal(await page.getAttribute(`${f}-consentGiven`, 'aria-invalid'), 'true');
    await page.check(`${f}-consentGiven`);

    // Review ticket "Edit" jumps back to the right step and Continue returns
    await page.locator('[data-review-summary] [data-goto="1"]').first().click();
    assert.equal(await page.locator('[data-step-pane="1"]').isVisible(), true);
    for (let i = 0; i < 3; i++) await page.click('[data-pf-next]');
    assert.equal(await page.locator('[data-step-pane="4"]').isVisible(), true);

    // 5. Pure static host (404 HTML) → honest "not saved" notice with phone fallback
    await page.click('[data-submit]');
    await page.waitForSelector('.form-status--info');
    const offlineText = await page.locator('[data-form-status]').textContent();
    assert.match(offlineText, /not saved/i);
    assert.match(offlineText, /251-930-8621/);

    // 6. JSON 500 → error with phone fallback
    await page.route('**/api/public/inquiries', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Downstream database unavailable' }) })
    );
    await page.click('[data-submit]');
    await page.waitForSelector('.form-status--error');
    const errStatus = await page.locator('[data-form-status]').textContent();
    assert.match(errStatus, /could not be sent/i);
    assert.match(errStatus, /251-930-8621/);

    // 7. Server field error (e.g. fake phone) jumps to the field with the server's message
    await page.unroute('**/api/public/inquiries');
    await page.route('**/api/public/inquiries', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Please review the highlighted fields', fieldErrors: { phone: '555-01xx numbers are fictional.' } })
      })
    );
    await page.click('[data-submit]');
    await page.waitForFunction(() => document.querySelector('#pickup-request-phone-err')?.textContent?.includes('fictional'));

    // 8. 201 OK → structured payload, reference number, honest non-booking notice, generate_lead
    let postedBody = null;
    await page.unroute('**/api/public/inquiries');
    await page.route('**/api/public/inquiries', async (route) => {
      postedBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, leadId: 'lead-mock-1', leadNumber: 'ZJ-2026-000099', uploadToken: 'tok-mock' })
      });
    });
    await page.click('[data-submit]');
    await page.waitForSelector('[data-lead-reference]');
    const confirmText = await page.locator('[data-confirmation-panel]').textContent();
    assert.match(confirmText, /ZJ-2026-000099/);
    assert.match(confirmText, /not booked until we confirm/i);
    assert.equal(postedBody.firstName, 'Jordan');
    assert.equal(postedBody.lastName, 'Taylor');
    assert.equal(postedBody.selectedItems.length, 2);
    assert.equal(postedBody.source, 'zoiris-website');
    assert.equal(postedBody.zipCode, '36602');
    assert.equal(postedBody.indoorsOrOutdoors, 'Inside – upstairs');
    assert.ok(postedBody.formStartedAt > 0, 'Expected human-timing signal');
    assert.equal(postedBody._gotcha, undefined);

    const events = await page.evaluate(() => window.dataLayer || []);
    assert.ok(events.some((e) => e.event === 'generate_lead'), 'Expected generate_lead event in window.dataLayer');

    // No horizontal overflow on a phone
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `Expected no horizontal overflow, got ${overflow}px`);
    await context.close();
  });

  it('filters Accepted Items directory by search query and category and tracks click-to-call', async () => {
    const page = await browser.newPage();
    await page.goto(`${staticSrv.url}/accepted-items/`, { waitUntil: 'networkidle' });

    assert.equal(await page.locator('[data-directory-tools]').isHidden(), false);
    await page.fill('[data-item-search]', 'monitor');
    const countText = await page.locator('[data-item-count]').textContent();
    assert.match(countText, /shown/i);

    await page.fill('[data-item-search]', 'zzzz-nonexistent-item');
    assert.equal(await page.locator('[data-no-results]').isHidden(), false);

    await page.fill('[data-item-search]', '');
    await page.selectOption('[data-item-filter]', 'electronics');
    const visibleHousehold = await page.locator('[data-group][data-ewaste="false"]:not([hidden])').count();
    assert.equal(visibleHousehold, 0);

    // Click-to-call event tracking (prevent navigation to tel: protocol in headless)
    await page.evaluate(() => {
      document.querySelectorAll('a[href^="tel:"]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    });
    await page.locator('a[data-track="call"]').first().click();
    const events = await page.evaluate(() => window.dataLayer || []);
    assert.ok(events.some((e) => e.event === 'click_to_call'));
    await page.close();
  });

  it('renders the SEO Operations Dashboard SPA across all views without console or page errors', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`http://127.0.0.1:${adminPort}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.kpis');
    assert.match(await page.locator('h1').textContent(), /SEO Operations Dashboard/);

    const hashes = ['quality', 'pages', 'matrix', 'keywords', 'services', 'items', 'locations', 'neighborhoods', 'sitemap', 'verification', 'business', 'build'];
    for (const h of hashes) {
      await page.click(`[data-nav="${h}"]`);
      await page.waitForFunction((expected) => document.querySelector(`[data-nav="${expected}"]`)?.getAttribute('aria-current') === 'page', h);
    }

    await page.click('[data-nav="pages"]');
    await page.waitForSelector('button[data-open]');
    await page.locator('button[data-open]').first().click();
    await page.waitForSelector('#drawer[open]');
    const drawerText = await page.locator('#drawer').textContent();
    assert.ok(drawerText.length > 50, 'Expected populated editor drawer');

    assert.equal(errors.length, 0, `Unexpected dashboard errors: ${errors.join('; ')}`);
    await page.close();
  });
});
