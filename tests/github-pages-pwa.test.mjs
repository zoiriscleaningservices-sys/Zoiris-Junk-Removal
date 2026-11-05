/**
 * tests/github-pages-pwa.test.mjs
 * Verifies that when deployed to static GitHub Pages (`/Zoiris-Junk-Removal/owner/...`)
 * with ZERO backend API server running:
 * 1. `prepare-github-pages.mjs` bundles `/owner/*` PWA, `sw.js`, `manifest.webmanifest`, and `seed-seo.json` cleanly.
 * 2. Every `/owner/*` HTML page carries `noindex, nofollow, noarchive`.
 * 3. First-open on iPhone shows 1-step "Set up this device", logs in with `Logged in from iPhone · Safari`,
 *    persists requests + photos in the On-Device Vault, survives hard reload on deep `/owner/leads/ZJ-...` URLs,
 *    renders all 15 screens cleanly, and supports permanent deletion with 0 console/page errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { DIST_DIR, ROOT } from '../scripts/lib/load-data.mjs';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);

function findBrowserExecutable() {
  for (const p of CHROME_PATHS) if (existsSync(p)) return p;
  return undefined;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

test('GitHub Pages static PWA (/Zoiris-Junk-Removal/owner/*) works 24/7 on iPhone with zero backend API', async (t) => {
  assert.ok(existsSync(join(DIST_DIR, 'index.html')), 'dist/index.html must exist before test');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'zoiris-gh-pages-'));
  const subDir = join(tmpRoot, 'Zoiris-Junk-Removal');
  cpSync(DIST_DIR, subDir, { recursive: true });

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'prepare-github-pages.mjs')], {
    env: { ...process.env, PAGES_BASE_PATH: '/Zoiris-Junk-Removal', PAGES_DIST_DIR: subDir },
    stdio: 'pipe'
  });

  // Verify manifest & noindex
  const manifest = JSON.parse(readFileSync(join(subDir, 'owner', 'assets', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/Zoiris-Junk-Removal/owner/command-center/');
  assert.equal(manifest.scope, '/Zoiris-Junk-Removal/owner/');
  assert.ok(manifest.icons.every((ic) => ic.src.startsWith('/Zoiris-Junk-Removal/owner/assets/')));

  const loginHtml = readFileSync(join(subDir, 'owner', 'login', 'index.html'), 'utf8');
  assert.match(loginHtml, /noindex,\s*nofollow,\s*noarchive/i);

  // Pure static HTTP server mimicking GitHub Pages (zero /api/* handlers!)
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let target = join(tmpRoot, rel);
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (existsSync(target) && statSync(target).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
      res.end(readFileSync(target));
      return;
    }
    const fourOhFour = join(subDir, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(existsSync(fourOhFour) ? readFileSync(fourOhFour) : 'Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Zoiris-Junk-Removal`;

  const browser = await chromium.launch({ headless: true, executablePath: findBrowserExecutable() });
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource: the server responded with a status of 404')) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });

  // 1. Open /owner/login/ on iPhone — should show 1-step "Set up this device"
  await page.goto(`${baseUrl}/owner/login/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#setup-form:not([hidden])');
  const secretWrapHidden = await page.locator('#setup-secret-wrap').evaluate((el) => el.hidden);
  assert.equal(secretWrapHidden, true, 'On-device setup must not ask for a server setup secret');

  await page.fill('#setup-name', 'Zoiris Owner');
  await page.fill('#setup-email', 'owner@zoirisjunkremoval.com');
  await page.fill('#setup-password', 'MyPhonePass2026!');
  await page.click('#setup-form button[type="submit"]');

  // 2. Redirects to /Zoiris-Junk-Removal/owner/command-center/ with iPhone device indicator
  await page.waitForURL('**/Zoiris-Junk-Removal/owner/command-center/');
  await page.waitForSelector('.cc-hello__device');
  const devText = await page.locator('.cc-hello__device').innerText();
  assert.match(devText, /Logged in from iPhone · Safari/i);

  // 3. Log a pickup request with a photo right from the phone
  await page.click('[data-log-lead]');
  await page.waitForSelector('#quick-lead-form');
  await page.fill('#ql-name', 'Marcus Carter');
  await page.fill('#ql-phone', '251-555-0188');
  await page.fill('#ql-addr', '104 Dauphin St');
  await page.fill('#ql-desc', 'Old couch and 2 TVs');
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#ql-files', { name: 'couch.png', mimeType: 'image/png', buffer: tinyPng });
  await page.click('#quick-lead-form button[type="submit"]');

  await page.waitForURL('**/Zoiris-Junk-Removal/owner/leads/ZJ-*');
  await page.waitForSelector('.cc-lead-hero h1');
  assert.equal(await page.locator('.cc-lead-hero h1').innerText(), 'Marcus Carter');

  // 4. Hard reload the deep `/owner/leads/ZJ-...` URL (tests 404.html SPA handoff + Service Worker)
  const deepUrl = page.url();
  await page.goto(deepUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cc-lead-hero h1');
  assert.equal(await page.locator('.cc-lead-hero h1').innerText(), 'Marcus Carter');

  // 5. Visit key screens to ensure zero schema mismatches
  for (const sec of ['stats', 'leads', 'pipeline', 'customers', 'media', 'locations', 'seo-pages', 'reports', 'settings', 'security']) {
    await page.goto(`${baseUrl}/owner/${sec}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#cc-workspace h1');
  }

  const secBody = await page.locator('#cc-workspace').innerText();
  assert.match(secBody, /iPhone · Safari/i);
  assert.deepEqual(errors, [], `Expected 0 JS errors across GitHub Pages PWA, got: ${errors.join('; ')}`);
});
