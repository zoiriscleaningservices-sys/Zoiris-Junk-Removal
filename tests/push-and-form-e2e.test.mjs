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
import { decryptWebPushPayload, loadOrCreateVapidKeys } from '../server/webpush.mjs';
import { createBridgeHandler, hashOwnerPassword } from '../cloud-bridge/api/bridge.mjs';

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
    await context.route('https://services.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    );

    // Mock ArcGIS, Photon & U.S. Census JSONP geocoders for deterministic CI execution
    await context.route('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          suggestions: [{ text: '104 Dauphin St, Mobile, AL, 36602, USA', magicKey: 'mk-104-dauphin', isCollection: false }]
        })
      })
    );
    await context.route('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          candidates: [
            {
              address: '104 Dauphin St, Mobile, Alabama, 36602',
              location: { x: -88.043055, y: 30.691522 },
              score: 100,
              attributes: {
                Addr_type: 'PointAddress',
                StAddr: '104 Dauphin St',
                AddNum: '104',
                City: 'Mobile',
                Subregion: 'Mobile County',
                Region: 'Alabama',
                RegionAbbr: 'AL',
                Postal: '36602',
                Country: 'USA'
              }
            }
          ]
        })
      })
    );
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
                countrycode: 'US',
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
      if (u.pathname.endsWith('/json') || u.pathname.endsWith('/sse')) {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: 'event: open\ndata: {"event":"open"}\n\n'
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

    // Strip data-cloud-bridge on the form HTML in this test so the zero-bridge ntfy fallback path is tested cleanly
    await context.route(`${staticSrv.origin}/Zoiris-Junk-Removal/request-pickup/`, async (route) => {
      const resp = await route.fetch();
      const html = (await resp.text()).replace(/data-cloud-bridge="[^"]*"/g, 'data-cloud-bridge=""');
      return route.fulfill({ response: resp, body: html });
    });

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

  it('streams new website leads live in real time to open Owner browsers (zero reload via SSE) AND dispatches background Web Push to installed PWA via Cloud Bridge', async () => {
    const vapid = loadOrCreateVapidKeys(tempVault);
    const liveTopic = 'zoiris_live_e2e_stream_test';
    const bridgePushes = [];
    const sseClients = new Set();
    let bridgeOrigin = '';

    const bridgeHandler = createBridgeHandler({
      memoryMap: new Map(),
      env: {
        ZOIRIS_MEMORY_STORE: '1',
        ZOIRIS_MASTER_KEY: randomBytes(32).toString('base64url'),
        ZOIRIS_OWNER_EMAIL: ownerEmail,
        ZOIRIS_OWNER_PW_HASH: hashOwnerPassword(ownerPassword),
        ZOIRIS_VAPID_SUBJECT: 'mailto:owner@zoirisjunkremoval.com',
        ZOIRIS_VAPID_PUBLIC_KEY: vapid.publicKey,
        ZOIRIS_VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateJwk),
        ZOIRIS_LIVE_TOPIC: liveTopic
      },
      fetchImpl: async (targetUrl, init) => {
        const u = String(targetUrl);
        if (u.startsWith('https://web.push.apple.com/')) {
          bridgePushes.push({
            endpoint: u,
            headers: init?.headers || {},
            body: Buffer.from(init?.body || '')
          });
          return new Response('', { status: 201 });
        }
        if (u.includes(`/${liveTopic}`) && (init?.method || 'GET').toUpperCase() === 'POST') {
          const msgBody = String(init?.body || '{}');
          const sseFrame = `data: ${JSON.stringify({ id: 'live_1', event: 'message', topic: liveTopic, message: msgBody })}\n\n`;
          for (const clientRes of sseClients) {
            try {
              clientRes.write(sseFrame);
            } catch {}
          }
          return new Response('{"id":"live_1"}', { status: 200 });
        }
        return fetch(targetUrl, init);
      }
    });

    const bridgeServer = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname === `/${liveTopic}/sse`) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(`event: open\ndata: ${JSON.stringify({ id: 'open_1', event: 'open', topic: liveTopic })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      bridgeHandler(req, res);
    });

    await new Promise((resolve) => {
      bridgeServer.listen(0, '127.0.0.1', () => {
        bridgeOrigin = `http://127.0.0.1:${bridgeServer.address().port}`;
        resolve();
      });
    });

    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const consoleErrors = [];

    const setupGeoRoutes = async (ctx) => {
      await ctx.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: tinyPng }));
      await ctx.route('https://services.arcgisonline.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: tinyPng }));
      await ctx.route('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest**', (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            suggestions: [{ text: '1100 Congress Ave, Austin, TX, 78701, USA', magicKey: 'mk-1100-congress', isCollection: false }]
          })
        })
      );
      await ctx.route('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates**', (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            candidates: [
              {
                address: '1100 Congress Ave, Austin, Texas, 78701',
                location: { x: -97.74035, y: 30.27467 },
                score: 100,
                attributes: {
                  Addr_type: 'PointAddress',
                  StAddr: '1100 Congress Ave',
                  AddNum: '1100',
                  City: 'Austin',
                  Subregion: 'Travis County',
                  Region: 'Texas',
                  RegionAbbr: 'TX',
                  Postal: '78701',
                  Country: 'USA'
                }
              }
            ]
          })
        })
      );
      await ctx.route('https://photon.komoot.io/api/**', (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            features: [
              {
                geometry: { coordinates: [-97.74035, 30.27467] },
                properties: {
                  countrycode: 'US',
                  housenumber: '1100',
                  street: 'Congress Ave',
                  city: 'Austin',
                  state: 'Texas',
                  postcode: '78701',
                  county: 'Travis County'
                }
              }
            ]
          })
        })
      );
      await ctx.route('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress**', (r) => {
        const cb = new URL(r.request().url()).searchParams.get('callback') || 'cb';
        return r.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: `${cb}(${JSON.stringify({
            result: {
              addressMatches: [
                {
                  matchedAddress: '312 FAIRHOPE AVE, FAIRHOPE, AL, 36532',
                  coordinates: { x: -87.9036, y: 30.5229 },
                  addressComponents: { streetName: 'FAIRHOPE', suffixType: 'AVE', city: 'FAIRHOPE', state: 'AL', zip: '36532' },
                  geographies: { Counties: [{ GEOID: '01003', NAME: 'Baldwin County' }] }
                }
              ]
            }
          })});`
        });
      });
      // Route production Cloud Bridge URL to our isolated local Cloud Bridge instance
      await ctx.route('https://zoiris-cloud-bridge.vercel.app/**', async (route) => {
        const req = route.request();
        const target = req.url().replace('https://zoiris-cloud-bridge.vercel.app', bridgeOrigin);
        const resp = await fetch(target, {
          method: req.method(),
          headers: req.headers(),
          body: req.method() === 'GET' || req.method() === 'HEAD' ? undefined : req.postDataBuffer() || undefined
        });
        const buf = Buffer.from(await resp.arrayBuffer());
        const headers = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return route.fulfill({ status: resp.status, headers, body: buf });
      });
    };

    const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const customerCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      await setupGeoRoutes(ownerCtx);
      await setupGeoRoutes(customerCtx);

      await ownerCtx.addInitScript(
        ({ bUrl, sseUrl }) => {
          window.__ZOIRIS_CLOUD_BRIDGE_URL__ = bUrl;
          window.__ZOIRIS_LIVE_SSE_URL__ = sseUrl;
        },
        { bUrl: bridgeOrigin, sseUrl: `${bridgeOrigin}/${liveTopic}/sse` }
      );

      const ownerPage = await ownerCtx.newPage();
      ownerPage.on('pageerror', (e) => consoleErrors.push(`owner pageerror: ${e.message}`));

      // 1. Owner signs in at /owner/login/ directly using Cloud Bridge credentials (zero #pair link needed!)
      await ownerPage.goto(`${staticSrv.origin}/Zoiris-Junk-Removal/owner/login/`, { waitUntil: 'domcontentloaded' });
      await ownerPage.waitForSelector('#login-form:not([hidden])');
      await ownerPage.fill('#login-email', ownerEmail);
      await ownerPage.fill('#login-password', ownerPassword);
      await ownerPage.click('#login-submit');

      await ownerPage.waitForURL('**/Zoiris-Junk-Removal/owner/command-center/');
      await ownerPage.waitForFunction(() => window.__ZOIRIS_LIVE_CONNECTED__ === true, null, { timeout: 8000 });
      assert.equal((await ownerPage.locator('#cc-sse-pill').textContent()).trim(), 'Live 24/7');

      // 2. Register an installed-PWA Apple Web Push subscription via the Owner app's fetch layer
      const pwaEcdh = createECDH('prime256v1');
      pwaEcdh.generateKeys();
      const pwaAuth = randomBytes(16);
      const subResp = await ownerPage.evaluate(
        async (sub) => {
          const r = await fetch('/api/owner/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subscription: sub,
              deviceLabel: 'iPhone · Safari (App)',
              deviceKind: 'phone'
            })
          });
          return r.json();
        },
        {
          endpoint: 'https://web.push.apple.com/Q_installed_zoiris_pwa_device',
          keys: {
            p256dh: pwaEcdh.getPublicKey().toString('base64url'),
            auth: pwaAuth.toString('base64url')
          }
        }
      );
      assert.equal(subResp.ok, true);
      assert.equal(subResp.subscriptionCount, 1);
      assert.equal(bridgePushes.length, 1, 'Expected immediate welcome confirmation push to installed mobile app');
      const welcomePush = JSON.parse(decryptWebPushPayload(bridgePushes[0].body, pwaEcdh, pwaAuth));
      assert.equal(welcomePush.kind, 'welcome');

      bridgePushes.length = 0;

      // 3. While Owner Page stays untouched on /owner/command-center/, a Customer submits a pickup form in a separate browser!
      const custPage = await customerCtx.newPage();
      custPage.on('pageerror', (e) => consoleErrors.push(`customer pageerror: ${e.message}`));
      const pickCust = async (sel) => {
        const id = await custPage.locator(sel).first().getAttribute('id');
        await custPage.click(`label[for="${id}"]`);
      };

      await custPage.goto(`${staticSrv.origin}/Zoiris-Junk-Removal/request-pickup/`, { waitUntil: 'domcontentloaded' });
      await custPage.waitForTimeout(150);
      await custPage.click('label[for="pickup-request-cat-Appliances"]');
      await pickCust('input[name="selectedItem"][value="Refrigerators"]');
      await pickCust('input[name="estimatedQuantity"][value="1–2 items"]');
      await custPage.click('[data-pf-next]');

      await custPage.setInputFiles('#pickup-request-media-picker', [photoFixturePath]);
      await custPage.fill('#pickup-request-itemDescription', 'Stainless garage refrigerator ready by side driveway.');
      await custPage.click('[data-pf-next]');

      await custPage.fill('#pickup-request-address', '1100 Congress Ave');
      await custPage.waitForSelector('[data-address-list] [data-opt="0"]');
      await custPage.click('[data-address-list] [data-opt="0"]');
      await custPage.waitForSelector('[data-address-card]:not([hidden])');
      await pickCust('input[name="indoorsOrOutdoors"][value="Curbside / driveway"]');
      await custPage.click('[data-pf-next]');

      await custPage.fill('#pickup-request-firstName', 'Devon');
      await custPage.fill('#pickup-request-lastName', ' Brooks');
      await custPage.fill('#pickup-request-phone', '512-555-0344');
      await custPage.fill('#pickup-request-email', 'devon.brooks@zoiris-test.org');
      await custPage.check('#pickup-request-consentGiven');
      await custPage.waitForTimeout(3700);
      await custPage.click('[data-submit]');

      await custPage.waitForSelector('[data-lead-reference]', { timeout: 15000 });
      const liveLeadRef = (await custPage.locator('[data-lead-reference]').textContent()).trim();
      assert.match(liveLeadRef, /^ZJ-\d{4}-\d{6}$/);

      // 4. Verify Installed Mobile App received background RFC 8291 Web Push immediately (works even when app is closed!)
      assert.equal(bridgePushes.length, 1, 'Expected native Web Push dispatched immediately to installed PWA');
      const leadPush = JSON.parse(decryptWebPushPayload(bridgePushes[0].body, pwaEcdh, pwaAuth));
      assert.equal(leadPush.kind, 'new_lead');
      assert.match(leadPush.title, new RegExp(liveLeadRef));
      assert.match(leadPush.body, /Devon Brooks/);
      assert.match(leadPush.body, /Austin, TX/);
      assert.equal(leadPush.url, `/owner/leads/${liveLeadRef}`);

      // 5. Verify Owner Browser updated LIVE IN REAL TIME (< 4s) WITHOUT calling ownerPage.reload()!
      await ownerPage.waitForFunction(
        (ref) => document.body.textContent.includes(ref) && document.body.textContent.includes('Devon Brooks'),
        liveLeadRef,
        { timeout: 5000 }
      );

      // Open lead detail on Owner Browser and confirm decrypted photo + verified nationwide Austin, TX address + map pin
      await ownerPage.click(`a[href*="${liveLeadRef}"]`);
      await ownerPage.waitForSelector('.cc-lead-hero');
      assert.match(await ownerPage.locator('#cc-workspace').textContent(), /1100 Congress Ave, Austin, TX 78701/);
      assert.match(await ownerPage.locator('#cc-workspace').textContent(), /Travis County/);
      await ownerPage.waitForSelector('[data-lead-map] .zmap__pin');
      await ownerPage.waitForSelector('.cc-media-preview img');
      const liveImgW = await ownerPage.locator('.cc-media-preview img').first().evaluate((img) => img.naturalWidth);
      assert.ok(liveImgW > 100, `Expected decrypted photo rendered live in Owner browser, got width=${liveImgW}`);

      // 6. Delete lead in Owner Browser and confirm Cloud Bridge encrypted vault is purged too
      ownerPage.once('dialog', (d) => d.accept());
      await ownerPage.click('#ld-delete-lead');
      await ownerPage.waitForURL('**/Zoiris-Junk-Removal/owner/leads/');
      await ownerPage.waitForTimeout(300);

      const syncCheck = await ownerPage.evaluate(async (bOrigin) => {
        const tok = localStorage.getItem('zoiris.cloudBearerToken.v1');
        const r = await fetch(`${bOrigin}/api/owner/leads/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ knownLeadNumbers: [] })
        });
        return r.json();
      }, bridgeOrigin);
      assert.deepEqual(syncCheck.activeLeadNumbers, [], 'Deleted lead must be permanently removed from Cloud Bridge vault');
      assert.deepEqual(consoleErrors, [], `Unexpected browser errors: ${consoleErrors.join('; ')}`);
    } finally {
      for (const c of sseClients) {
        try {
          c.end();
        } catch {}
      }
      await ownerCtx.close();
      await customerCtx.close();
      await new Promise((r) => bridgeServer.close(r));
    }
  });
});
