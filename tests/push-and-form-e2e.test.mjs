/**
 * tests/push-and-form-e2e.test.mjs
 * Comprehensive automated verification of:
 *  1. RFC 8291 (aes128gcm) + RFC 8292 (ES256 VAPID) Native Web Push encryption, round-trip decryption,
 *     owner subscription API, stale 410 pruning, and automatic background push dispatch on new customer leads.
 *  2. Static GitHub Pages 4-step Customer Pickup Form (`prepare-github-pages.mjs` subpath build with NO backend server):
 *     live Photon address autocomplete, U.S. Census JSONP verification, photo compression, RSA-OAEP-2048 + AES-256-GCM
 *     sealing (zero plaintext PII in relay notification headers), `#pair=...` 1-tap Phone Vault decryption with
 *     attached photo + map pin, AND Node CRM `cloud-relay.mjs` sync + Web Push dispatch.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

import { ROOT } from '../scripts/lib/load-data.mjs';
import { createZoirisApp } from '../server/index.mjs';
import { decryptWebPushPayload } from '../server/webpush.mjs';

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
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2'
};

function startSubpathStaticServer(pagesRoot, basePath = '/Zoiris-Junk-Removal') {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (!u.pathname.startsWith(basePath)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const sub = u.pathname.slice(basePath.length) || '/';
      const rel = normalize(decodeURIComponent(sub)).replace(/^[/\\]+/, '');
      let file = join(pagesRoot, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!file.startsWith(pagesRoot) || !existsSync(file)) {
        const nf = join(pagesRoot, '404.html');
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(existsSync(nf) ? readFileSync(nf) : 'Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, origin: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

function replaceRelayKeyInDir(dir, topic, pubSpkiB64) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) replaceRelayKeyInDir(full, topic, pubSpkiB64);
    else if (full.endsWith('.html')) {
      const before = readFileSync(full, 'utf8');
      const after = before
        .replace(/data-relay-topic="[^"]*"/g, `data-relay-topic="${topic}"`)
        .replace(/data-relay-pubkey="[^"]*"/g, `data-relay-pubkey="${pubSpkiB64}"`);
      if (after !== before) writeFileSync(full, after, 'utf8');
    }
  }
}

describe('Background Phone Push Notifications (RFC 8291 Web Push + 24/7 Encrypted Static GitHub Pages Relay)', () => {
  let tempVault;
  let pagesDist;
  let fixtureDir;
  let photoFixturePath;
  let staticSrv;
  let app;
  let crmUrl;
  let browser;

  const pushedEnvelopes = [];
  const relayMessages = [];
  let testKeypair;
  const testTopic = 'zoiris_test_topic_1234567890';
  const ownerEmail = 'owner@zoirisjunkremoval.com';
  const ownerPassword = 'Zoiris-Push-Test-2026!';

  before(async () => {
    assert.ok(executablePath, 'Chrome or Edge executable required for Playwright E2E tests');
    process.env.ZOIRIS_SYNC_JSON = '0';
    process.env.ZOIRIS_TEST_HOOKS = '1';
    process.env.ZOIRIS_GEOCODER = 'mock';

    tempVault = mkdtempSync(join(tmpdir(), 'zoiris-push-vault-'));
    pagesDist = mkdtempSync(join(tmpdir(), 'zoiris-pages-dist-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'zoiris-push-fixtures-'));

    // Generate ephemeral RSA-2048 keypair for test isolation (works in CI without .zoiris-private)
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeySpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const privateKeyPkcs8B64Url = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
    testKeypair = { publicKeySpkiB64, privateKeyPkcs8B64Url };

    writeFileSync(
      join(tempVault, 'relay-keypair.json'),
      JSON.stringify({
        relayUrl: 'https://ntfy.sh',
        topic: testTopic,
        publicKeySpkiB64,
        privateKeyPkcs8B64Url
      }),
      'utf8'
    );

    // Create sample customer photo
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default || sharpMod;
    photoFixturePath = join(fixtureDir, 'curbside-mattress.jpg');
    const jpg = await sharp({
      create: { width: 480, height: 360, channels: 3, background: { r: 242, g: 107, b: 29 } }
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    writeFileSync(photoFixturePath, jpg);

    // Copy built dist/ into pagesDist and run prepare-github-pages.mjs with subpath /Zoiris-Junk-Removal
    const cpRes = spawnSync(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');fs.cpSync(${JSON.stringify(join(ROOT, 'dist'))},${JSON.stringify(pagesDist)},{recursive:true});`
      ],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(cpRes.status, 0, cpRes.stderr);

    const prepRes = spawnSync(process.execPath, ['scripts/prepare-github-pages.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PAGES_DIST_DIR: pagesDist, PAGES_BASE_PATH: '/Zoiris-Junk-Removal' },
      encoding: 'utf8'
    });
    assert.equal(prepRes.status, 0, prepRes.stderr);
    replaceRelayKeyInDir(pagesDist, testTopic, publicKeySpkiB64);

    staticSrv = await startSubpathStaticServer(pagesDist, '/Zoiris-Junk-Removal');

    // Start Node CRM app with custom mock pushFetchImpl & relayFetchImpl
    app = createZoirisApp({
      dataDir: tempVault,
      servePublicDist: true,
      enableRelaySync: false,
      pushFetchImpl: async (endpoint, init) => {
        if (String(endpoint).includes('/stale-410')) {
          return new Response('Gone', { status: 410 });
        }
        pushedEnvelopes.push({
          endpoint: String(endpoint),
          method: init.method,
          headers: init.headers,
          body: Buffer.from(init.body)
        });
        return new Response('', { status: 201 });
      },
      relayFetchImpl: async (urlStr) => {
        if (String(urlStr).includes('/json?poll=1')) {
          const lines = relayMessages.map((m) => JSON.stringify(m)).join('\n');
          return new Response(lines ? lines + '\n' : '', { status: 200 });
        }
        if (String(urlStr).includes('/att/')) {
          const id = String(urlStr).split('/att/')[1];
          const found = relayMessages.find((m) => m.id === id);
          return new Response(found?._rawAttachment || '', { status: 200 });
        }
        return new Response('{"id":"test"}', { status: 200 });
      }
    });

    app.auth.provisionFirstOwner({
      email: ownerEmail,
      displayName: 'Lucia Zoiris',
      password: ownerPassword,
      allowCliBypass: true
    });

    await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        crmUrl = `http://127.0.0.1:${app.server.address().port}`;
        resolve();
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (staticSrv?.server) await new Promise((r) => staticSrv.server.close(r));
    if (app) await app.close();
    for (const d of [tempVault, pagesDist, fixtureDir]) {
      if (d && existsSync(d)) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('delivers RFC 8291 encrypted Web Push notifications with ES256 VAPID when a customer submits a pickup request and prunes 410 stale endpoints', async () => {
    // 1. Sign in as owner on Node CRM server
    const loginRes = await fetch(`${crmUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, rememberDevice: true })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    const loginJson = await loginRes.json();
    const csrf = loginJson.csrfToken;

    // 2. Create real browser ECDH P-256 push subscription keys + one stale endpoint
    const subEcdh = createECDH('prime256v1');
    subEcdh.generateKeys();
    const clientAuth = randomBytes(16);

    const activeSub = {
      endpoint: 'https://web.push.apple.com/Q1_active_iphone_pwa_endpoint',
      keys: {
        p256dh: subEcdh.getPublicKey().toString('base64url'),
        auth: clientAuth.toString('base64url')
      }
    };
    const staleSub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/stale-410',
      keys: {
        p256dh: subEcdh.getPublicKey().toString('base64url'),
        auth: clientAuth.toString('base64url')
      }
    };

    for (const subscription of [activeSub, staleSub]) {
      const r = await fetch(`${crmUrl}/api/owner/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Zoiris-CSRF': csrf },
        body: JSON.stringify({ subscription, deviceLabel: 'iPhone · Safari (App)', deviceKind: 'phone' })
      });
      assert.equal(r.status, 201);
    }

    const stBefore = await (await fetch(`${crmUrl}/api/owner/push/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(stBefore.subscriptionCount, 2);
    assert.ok(stBefore.vapidPublicKey.length > 60);

    // 3. Customer submits a pickup inquiry via /api/public/inquiries while owner app is closed
    pushedEnvelopes.length = 0;
    const inqRes = await fetch(`${crmUrl}/api/public/inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Marcus',
        lastName: 'Vance',
        phone: '251-555-0291',
        email: 'marcus.vance@zoiris-test.org',
        pickupAddress: '1450 Government St',
        city: 'Mobile',
        state: 'AL',
        zipCode: '36604',
        requestedService: 'Appliance Removal',
        selectedItems: [{ category: 'Appliances', name: 'Refrigerators' }],
        estimatedQuantity: '1–2 items',
        indoorsOrOutdoors: 'Curbside / driveway',
        consentGiven: true,
        formStartedAt: Date.now() - 9000
      })
    });
    assert.equal(inqRes.status, 201);
    const inqJson = await inqRes.json();
    assert.match(inqJson.leadNumber, /^ZJ-\d{4}-\d{6}$/);

    // 4. Verify Web Push HTTP delivery + RFC 8291 decryption + automatic 410 pruning
    assert.equal(pushedEnvelopes.length, 1, 'Expected 1 active push envelope delivered');
    const env = pushedEnvelopes[0];
    assert.equal(env.endpoint, activeSub.endpoint);
    assert.equal(env.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(env.headers.Urgency, 'high');
    assert.match(env.headers.Authorization, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/);

    const decryptedPush = JSON.parse(decryptWebPushPayload(env.body, subEcdh, clientAuth));
    assert.match(decryptedPush.title, new RegExp(inqJson.leadNumber));
    assert.match(decryptedPush.body, /Marcus Vance/);
    assert.equal(decryptedPush.url, `/owner/leads/${inqJson.leadNumber}`);

    const stAfter = await (await fetch(`${crmUrl}/api/owner/push/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(stAfter.subscriptionCount, 1, 'Stale 410 subscription must be pruned automatically');
  });

  it('completes all 4 customer form steps on static GitHub Pages (zero backend), encrypts PII + photo, triggers lock-screen relay push, and decrypts into both Phone Vault & Node CRM', async () => {
    const consoleErrors = [];
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    let capturedRelayQuery = null;

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('https://tile.openstreetmap.org/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    );
    await context.route('https://basemap.nationalmap.gov/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    );

    // Mock Photon live autocomplete & U.S. Census JSONP geocoder for deterministic CI execution
    await context.route('https://photon.komoot.io/api/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          features: [
            {
              geometry: { coordinates: [-88.0431, 30.6915] },
              properties: {
                housenumber: '104',
                street: 'Dauphin St',
                city: 'Mobile',
                state: 'Alabama',
                postcode: '36602',
                county: 'Mobile County'
              }
            }
          ]
        })
      })
    );
    await context.route('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress**', (route) => {
      const reqUrl = new URL(route.request().url());
      const cb = reqUrl.searchParams.get('callback') || 'cb';
      const payload = {
        result: {
          addressMatches: [
            {
              matchedAddress: '104 DAUPHIN ST, MOBILE, AL, 36602',
              coordinates: { x: -88.043055, y: 30.691522 },
              addressComponents: {
                streetName: 'DAUPHIN',
                suffixType: 'ST',
                city: 'MOBILE',
                state: 'AL',
                zip: '36602'
              },
              geographies: {
                Counties: [{ GEOID: '01097', NAME: 'Mobile County' }]
              }
            }
          ]
        }
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: `${cb}(${JSON.stringify(payload)});`
      });
    });

    // Mock ntfy.sh relay POST, poll, SSE stream, and encrypted attachment download
    await context.route(`https://ntfy.sh/${testTopic}**`, async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (req.method() === 'POST') {
        capturedRelayQuery = Object.fromEntries(u.searchParams.entries());
        const rawBody = req.postData() || '';
        const msgId = `msg_${relayMessages.length + 1}`;
        relayMessages.push({
          id: msgId,
          time: Math.floor(Date.now() / 1000),
          event: 'message',
          topic: testTopic,
          title: capturedRelayQuery.title || '',
          message: capturedRelayQuery.message || '',
          attachment: {
            name: 'zoiris-lead.enc',
            url: `https://ntfy.sh/att/${msgId}`
          },
          _rawAttachment: rawBody
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ id: msgId, event: 'message' })
        });
      }
      if (u.pathname.endsWith('/json') && u.searchParams.get('poll') === '1') {
        const ndjson = relayMessages.map((m) => JSON.stringify(m)).join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: ndjson ? ndjson + '\n' : ''
        });
      }
      if (u.pathname.endsWith('/json')) {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: ': keepalive\n\n'
        });
      }
      return route.fulfill({ status: 200, body: '{}' });
    });

    await context.route('https://ntfy.sh/att/**', (route) => {
      const id = route.request().url().split('/att/')[1];
      const found = relayMessages.find((m) => m.id === id);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: found?._rawAttachment || ''
      });
    });

    const page = await context.newPage();
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource.*404/i.test(msg.text())) {
        consoleErrors.push(`console.error: ${msg.text()}`);
      }
    });

    const pick = async (sel) => {
      const inputId = await page.locator(sel).first().getAttribute('id');
      await page.click(`label[for="${inputId}"]`);
    };

    /* ---------------- PART 1: Customer Submits Form on Static GitHub Pages ---------------- */
    await page.goto(`${staticSrv.origin}/Zoiris-Junk-Removal/request-pickup/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);

    // Step 1: Select category, item, load size
    await page.click('label[for="pickup-request-cat-Furniture"]');
    await pick('input[name="selectedItem"][value="Mattresses"]');
    await pick('input[name="estimatedQuantity"][value="1–2 items"]');
    await page.click('[data-pf-next]');

    // Step 2: Attach real JPEG photo
    await page.setInputFiles('#pickup-request-media-picker', [photoFixturePath]);
    assert.equal(await page.locator('[data-photo-count]').textContent(), '1');
    await page.fill('#pickup-request-itemDescription', 'King mattress and box spring wrapped in plastic by garage door.');
    await page.click('[data-pf-next]');

    // Step 3: Live Photon autocomplete + U.S. Census JSONP verification on static host
    await page.fill('#pickup-request-address', '104 Dauphin St');
    await page.waitForSelector('[data-address-list] [data-opt="0"]');
    await page.click('[data-address-list] [data-opt="0"]');
    await page.waitForSelector('[data-address-card]:not([hidden])');
    assert.match(await page.locator('[data-verified-text]').textContent(), /104 Dauphin St, Mobile, AL 36602/i);
    assert.match(await page.locator('[data-verified-county]').textContent(), /Mobile County/i);
    await pick('input[name="indoorsOrOutdoors"][value="Curbside / driveway"]');
    await page.click('[data-pf-next]');

    // Step 4: Contact details + consent + submit
    await page.fill('#pickup-request-firstName', 'Elena');
    await page.fill('#pickup-request-lastName', 'Morales');
    await page.fill('#pickup-request-phone', '251-555-0277');
    await page.fill('#pickup-request-email', 'elena.morales@zoiris-test.org');
    await page.check('#pickup-request-consentGiven');
    await page.waitForTimeout(3700);
    await page.click('[data-submit]');

    await page.waitForSelector('[data-lead-reference]', { timeout: 15000 });
    const staticLeadRef = (await page.locator('[data-lead-reference]').textContent()).trim();
    assert.match(staticLeadRef, /^ZJ-\d{4}-\d{6}$/);
    assert.match(await page.locator('[data-confirmation-panel]').textContent(), /1 media file\(s\) were securely attached/i);

    // Verify encrypted relay message: ZERO plaintext customer PII in query params or raw body!
    assert.ok(capturedRelayQuery, 'Expected high-priority push notification posted to relay');
    assert.equal(capturedRelayQuery.priority, 'high');
    assert.match(capturedRelayQuery.title, new RegExp(staticLeadRef));
    assert.doesNotMatch(capturedRelayQuery.message, /Elena|Morales|0277|Dauphin/i, 'Push banner must contain zero customer PII');

    const rawCipherBody = relayMessages[0]._rawAttachment;
    assert.doesNotMatch(rawCipherBody, /Elena|Morales|0277|Dauphin/i, 'Encrypted envelope must not leak plaintext PII');
    const parsedEnvelope = JSON.parse(rawCipherBody);
    assert.equal(parsedEnvelope.v, 1);
    assert.equal(parsedEnvelope.alg, 'RSA-OAEP-256+A256GCM');

    /* ---------------- PART 2: Owner Phone Vault Pairs via #pair=... & Decrypts Lead + Photo ---------------- */
    const pairUrl = `${staticSrv.origin}/Zoiris-Junk-Removal/owner/login/#pair=${encodeURIComponent(testKeypair.privateKeyPkcs8B64Url)}&topic=${encodeURIComponent(testTopic)}`;
    await page.goto(pairUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#setup-form:not([hidden])');

    // Verify private key hash was immediately scrubbed from URL bar
    assert.equal(new URL(page.url()).hash, '', 'URL hash must be scrubbed immediately after pairing');
    assert.match(await page.locator('#auth-notice').textContent(), /paired on this device/i);

    // Provision owner on phone vault
    await page.fill('#setup-name', 'Lucia Zoiris');
    await page.fill('#setup-email', ownerEmail);
    await page.fill('#setup-password', ownerPassword);
    await page.click('#setup-form button[type="submit"]');

    // Wait for Command Center Today view + automatic relay sync of Elena Morales's request!
    await page.waitForURL('**/Zoiris-Junk-Removal/owner/command-center/');
    await page.waitForFunction(
      (expectedRef) => document.body.textContent.includes(expectedRef) && document.body.textContent.includes('Elena Morales'),
      staticLeadRef,
      { timeout: 15000 }
    );

    // Open lead detail and verify decrypted address, badge, and customer photo blob!
    await page.click(`a[href*="${staticLeadRef}"]`);
    await page.waitForSelector('.cc-lead-hero');
    const detailText = await page.locator('#cc-workspace').textContent();
    assert.match(detailText, /Elena Morales/);
    assert.match(detailText, /104 Dauphin St, Mobile, AL 36602/);
    assert.match(detailText, /Address verified/);
    assert.match(detailText, /King mattress and box spring/);

    await page.waitForSelector('.cc-media-preview img');
    const imgWidth = await page.locator('.cc-media-preview img').first().evaluate((img) => img.naturalWidth);
    assert.ok(imgWidth > 100, `Expected decrypted customer photo to render in Phone Vault, got naturalWidth=${imgWidth}`);

    /* ---------------- PART 3: Node CRM Server Also Syncs Same Relay Envelope & Fires Web Push ---------------- */
    pushedEnvelopes.length = 0;
    const nodeSync = await app.cloudRelay.syncNow();
    assert.equal(nodeSync.ok, true);
    assert.equal(nodeSync.imported, 1);

    const sqlLead = app.ctx.db.prepare('SELECT * FROM leads WHERE lead_number = ?').get(staticLeadRef);
    assert.ok(sqlLead, 'Expected static GitHub Pages lead synced into SQLite CRM');
    assert.equal(sqlLead.address_status, 'verified');
    assert.equal(sqlLead.photo_count, 1);
    assert.equal(pushedEnvelopes.length, 1, 'Expected Node CRM relay sync to also dispatch native Web Push');

    assert.deepEqual(consoleErrors, [], `Unexpected browser errors: ${consoleErrors.join('; ')}`);
    await context.close();
  });
});
