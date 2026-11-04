/**
 * tests/crm-security.test.mjs
 * Automated negative, access-control, CSRF, binary media inspection,
 * HMAC signed URL expiration/tampering, brute-force lockout, RFC 6238 TOTP MFA,
 * database failure safeguard, and storage quota protection tests.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZoirisApp } from '../server/index.mjs';
import { totpCode } from '../server/crypto-totp.mjs';

function makeValidPngBuffer() {
  // Minimal valid 1x1 PNG (67 bytes)
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
  );
}

function makeValidJpegBuffer(extraBytes = 0) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = extraBytes > 0 ? Buffer.alloc(extraBytes, 0x20) : Buffer.alloc(0);
  const tail = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, pad, tail]);
}

describe('Zoiris Command Center — Security, Access Control & Negative Safeguards', () => {
  let tempVault;
  let app;
  let baseUrl;
  let ownerCookie = '';
  let csrfToken = '';
  const ownerEmail = 'security-owner@zoirisjunkremoval.com';
  const ownerPassword = 'Zoiris-Strong-Password-2026!';

  before(async () => {
    process.env.ZOIRIS_SYNC_JSON = '0';
    process.env.ZOIRIS_TEST_HOOKS = '1';
    process.env.ZOIRIS_GEOCODER = 'mock';
    tempVault = mkdtempSync(join(tmpdir(), 'zoiris-sec-test-'));
    app = createZoirisApp({ dataDir: tempVault, servePublicDist: false });
    app.auth.provisionFirstOwner({
      email: ownerEmail,
      displayName: 'Zoiris Security Owner',
      password: ownerPassword,
      allowCliBypass: true
    });
    await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${app.server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (app) await app.close();
    if (tempVault && existsSync(tempVault)) {
      try {
        rmSync(tempVault, { recursive: true, force: true });
      } catch {}
    }
  });

  it('blocks all unauthenticated /owner/* routes, /api/owner/* routes, and public CRM read attempts', async () => {
    // HTML navigation to /owner/command-center/ redirects to /owner/login/
    const htmlRedirect = await fetch(`${baseUrl}/owner/command-center/`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual'
    });
    assert.equal(htmlRedirect.status, 302);
    assert.match(htmlRedirect.headers.get('location') || '', /^\/owner\/login\//);
    assert.equal(htmlRedirect.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

    // JSON/programmatic navigation to /owner/* returns 401
    for (const route of ['/owner/command-center/', '/owner/leads/', '/owner/media/', '/owner/security/']) {
      const r = await fetch(`${baseUrl}${route}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
      assert.equal(r.status, 401, `Expected 401 on unauthenticated ${route}`);
    }

    // All /api/owner/* endpoints reject unauthenticated access with 401
    for (const apiPath of ['/api/owner/overview', '/api/owner/leads', '/api/owner/customers', '/api/owner/media', '/api/owner/capacity', '/api/owner/security']) {
      const r = await fetch(`${baseUrl}${apiPath}`);
      assert.equal(r.status, 401, `Expected 401 on ${apiPath}`);
    }

    // Public endpoints never allow reading leads or customers
    for (const pubRead of ['/api/public/leads', '/api/public/customers', '/api/public/inquiries']) {
      const r = await fetch(`${baseUrl}${pubRead}`);
      assert.equal(r.status, 403, `Expected 403 on ${pubRead}`);
    }

    // Provisioning endpoint permanently blocks re-setup once an owner exists
    const hijackSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker@evil.example',
        displayName: 'Attacker',
        password: 'Attacker-Password-12345!'
      })
    });
    assert.ok([401, 403, 409].includes(hijackSetup.status), `Expected 401/403/409 on repeat setup, got ${hijackSetup.status}`);
  });

  it('only accepts real, in-area addresses and genuine contact details (anti-scam & anti-spam screening)', async () => {
    const post = (path, body) =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const base = {
      firstName: 'Maria',
      lastName: 'Gomez',
      phone: '(251) 555-0261',
      email: 'maria.gomez@zoiris-test.org',
      pickupAddress: '1450 Government St',
      city: 'Mobile',
      state: 'AL',
      zipCode: '36604',
      requestedService: 'Furniture Removal',
      selectedItems: [{ category: 'Furniture', name: 'Couches' }],
      consentGiven: true
    };

    // Address verification endpoint: real address → signed token + coordinates + county
    const okRes = await (await post('/api/public/address/verify', { line: '1450 Government St', city: 'Mobile', zip: '36604' })).json();
    assert.equal(okRes.status, 'verified');
    assert.equal(okRes.address.countyName, 'Mobile County');
    assert.ok(Number.isFinite(okRes.address.lat) && okRes.token.includes('.'));

    const fakeRes = await (await post('/api/public/address/verify', { line: '99999 Fake St', city: 'Mobile' })).json();
    assert.equal(fakeRes.status, 'not-found');
    const outRes = await (await post('/api/public/address/verify', { line: '100 Peachtree St', city: 'Atlanta', state: 'GA' })).json();
    assert.equal(outRes.status, 'outside-area');
    const noNum = await (await post('/api/public/address/verify', { line: 'Government Street' })).json();
    assert.equal(noNum.status, 'not-found');
    assert.match(noNum.message, /house or building number/i);

    // Suggestions are filtered to the service area and never expose CRM data
    const sug = await (await post('/api/public/address/suggest', { q: '1450 Government St' })).json();
    assert.equal(sug.suggestions[0].city, 'Mobile');
    assert.equal(Object.keys(sug).includes('leads'), false);

    // Inquiries with fake or out-of-area addresses are rejected with a friendly field error
    let r = await post('/api/public/inquiries', { ...base, pickupAddress: '99999 Fake St' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).fieldErrors.pickupAddress, /couldn't find/i);
    r = await post('/api/public/inquiries', { ...base, pickupAddress: '100 Peachtree St', city: 'Atlanta', state: 'GA', zipCode: '30303' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).fieldErrors.pickupAddress, /outside Mobile and Baldwin/i);

    // A tampered address token is ignored, so the server re-checks the typed (fake) address
    const [b64, sig] = okRes.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b64, 'base64url').toString()), line: '1 Forged Way' })).toString('base64url');
    r = await post('/api/public/inquiries', { ...base, pickupAddress: '99999 Fake St', addressToken: `${forged}.${sig}` });
    assert.equal(r.status, 400);

    // Fictional / impossible phone numbers and throwaway inboxes are rejected
    r = await post('/api/public/inquiries', { ...base, phone: '251-555-0123' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).fieldErrors.phone, /fictional/i);
    r = await post('/api/public/inquiries', { ...base, phone: '111-111-1111' });
    assert.equal(r.status, 400);
    r = await post('/api/public/inquiries', { ...base, email: 'someone@mailinator.com' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).fieldErrors.email, /temporary inboxes/i);
    r = await post('/api/public/inquiries', { ...base, firstName: 'www.cheap-seo.xyz' });
    assert.equal(r.status, 400);

    // Promotional spam with links, submitted by a bot in under 5 seconds, is blocked outright (422)
    r = await post('/api/public/inquiries', {
      ...base,
      itemDescription: 'Dear business owner, we offer SEO backlinks to rank #1 on the first page of Google: https://best-seo.xyz',
      source: 'zoiris-website',
      formStartedAt: Date.now() - 800
    });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /251-930-8621/);

    // A genuine request with a valid token is saved with the canonical verified address + coordinates
    r = await post('/api/public/inquiries', { ...base, pickupAddress: '1450 government street', addressToken: okRes.token, source: 'zoiris-website', formStartedAt: Date.now() - 60000 });
    assert.equal(r.status, 201);
    const saved = await r.json();
    const row = app.ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(saved.leadId);
    assert.equal(row.pickup_address, '1450 Government St');
    assert.equal(row.address_status, 'verified');
    assert.equal(row.county_name, 'Mobile County');
    assert.equal(row.spam_score, 0);

    // Owner map pins are private
    const pins = await fetch(`${baseUrl}/api/owner/map/pins`);
    assert.equal(pins.status, 401);
  });

  it('enforces CSRF protection on authenticated mutations and isolates Customer A vs Customer B uploads', async () => {
    // Sign in as owner
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword })
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    ownerCookie = setCookie.split(';')[0];
    const loginData = await loginRes.json();
    csrfToken = loginData.csrfToken;
    assert.ok(csrfToken && csrfToken.length >= 24);

    // Submit Customer A and Customer B inquiries
    const inqA = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
        body: JSON.stringify({
          firstName: 'Alice',
          lastName: 'Carter',
          phone: '251-555-0201',
          pickupAddress: '101 Bienville Sq',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36602',
          requestedService: 'Furniture Removal',
          selectedItems: [{ category: 'Furniture', name: 'Couches' }],
          consentGiven: true,
          expectedFiles: 2
        })
      })
    ).json();
    assert.equal(inqA.ok, true);

    const inqB = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.12' },
        body: JSON.stringify({
          firstName: 'Brian',
          lastName: 'Dawson',
          phone: '251-555-0202',
          pickupAddress: '202 Dauphin St',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36604',
          requestedService: 'Appliance Removal',
          selectedItems: [{ category: 'Appliances', name: 'Refrigerators' }],
          consentGiven: true,
          expectedFiles: 0
        })
      })
    ).json();
    assert.equal(inqB.ok, true);

    // Customer A cannot use uploadToken to read Customer B's lead
    const readAttempt = await fetch(`${baseUrl}/api/owner/leads/${inqB.leadNumber}`, {
      headers: { Authorization: `Bearer ${inqA.uploadToken}`, 'X-Upload-Token': inqA.uploadToken }
    });
    assert.equal(readAttempt.status, 401);

    // Mutating owner API without X-Zoiris-CSRF is rejected even with valid session cookie!
    const missingCsrf = await fetch(`${baseUrl}/api/owner/leads/${inqA.leadId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ status: 'Contacted' })
    });
    assert.equal(missingCsrf.status, 403);

    // Valid CSRF succeeds
    const okCsrf = await fetch(`${baseUrl}/api/owner/leads/${inqA.leadId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-Zoiris-CSRF': csrfToken
      },
      body: JSON.stringify({ status: 'Contacted', note: 'CSRF verified' })
    });
    assert.equal(okCsrf.status, 200);
  });

  it('rejects disguised executables, HTML/script files, oversized files, and tampered/expired signed media URLs', async () => {
    const inq = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' },
        body: JSON.stringify({
          firstName: 'Claire',
          lastName: 'Monroe',
          phone: '251-555-0233',
          pickupAddress: '330 Springhill Ave',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36608',
          requestedService: 'Electronics Pickup',
          selectedItems: [{ category: 'Electronics', name: 'Monitors' }],
          consentGiven: true,
          expectedFiles: 3
        })
      })
    ).json();

    // 1. Windows PE executable (`MZ`) disguised as `couch.jpg` -> 415
    const fakeExeAsJpg = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64, 0x41)]);
    const exeRes = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': inq.uploadToken,
        'X-File-Name': 'couch.jpg'
      },
      body: fakeExeAsJpg
    });
    assert.equal(exeRes.status, 415);

    // 2. HTML/JavaScript XSS payload disguised as `item.png` -> 415
    const xssPayload = Buffer.from('<script>alert("xss")</script> padding bytes to exceed twelve bytes');
    const xssRes = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': inq.uploadToken,
        'X-File-Name': 'item.png'
      },
      body: xssPayload
    });
    assert.equal(xssRes.status, 415);

    // 3. Valid PNG upload succeeds and stores outside dist/ and public/
    const pngRes = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': inq.uploadToken,
        'X-File-Name': 'valid-monitor.png'
      },
      body: makeValidPngBuffer()
    });
    assert.equal(pngRes.status, 201);
    const pngData = await pngRes.json();
    assert.ok(pngData.attachmentId);

    // Unsigned direct stream request -> 403
    const unsignedStream = await fetch(`${baseUrl}/api/media/stream/${pngData.attachmentId}`);
    assert.equal(unsignedStream.status, 403);

    // Mint valid signed URL via owner API, then test valid vs tampered vs expired
    const signRes = await (
      await fetch(`${baseUrl}/api/owner/media/${pngData.attachmentId}/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
          'X-Zoiris-CSRF': csrfToken
        },
        body: JSON.stringify({ kind: 'original', disposition: 'inline', ttlSeconds: 60 })
      })
    ).json();
    assert.equal(signRes.ok, true);

    const validStream = await fetch(`${baseUrl}${signRes.signedUrl}`);
    assert.equal(validStream.status, 200);
    assert.equal(validStream.headers.get('content-type'), 'image/png');
    assert.equal(validStream.headers.get('cache-control'), 'private, no-store');

    // Tampered signature -> 403
    const tamperedUrl = signRes.signedUrl.replace(/sig=[0-9a-f]+/, 'sig=0000000000000000000000000000000000000000000000000000000000000000');
    const tamperedRes = await fetch(`${baseUrl}${tamperedUrl}`);
    assert.equal(tamperedRes.status, 403);

    // Expired timestamp -> 403
    const expiredUrl = app.crm.mintSignedMediaUrl(pngData.attachmentId, { ttlSeconds: -10 });
    const expiredRes = await fetch(`${baseUrl}${expiredUrl}`);
    assert.equal(expiredRes.status, 403);

    // 4. Oversized photo upload (> configured max_photo_bytes) -> 413
    app.ctx.setSetting('max_photo_bytes', 2048, null); // 2 KB for fast test
    const tooLargeJpeg = makeValidJpegBuffer(4096); // ~4 KB
    const overRes = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': inq.uploadToken,
        'X-File-Name': 'huge-photo.jpg'
      },
      body: tooLargeJpeg
    });
    assert.equal(overRes.status, 413);
    app.ctx.setSetting('max_photo_bytes', 15 * 1024 * 1024, null);
  });

  it('never fakes submission success on database failure and preserves text leads when media storage hits 100% quota', async () => {
    // 1. Simulated database failure -> HTTP 503 with phone fallback, zero false success
    const dbFailRes = await fetch(`${baseUrl}/api/public/inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.45' },
      body: JSON.stringify({
        _simulateDbFailure: true,
        firstName: 'Devon',
        lastName: 'Price',
        phone: '251-555-0299',
        pickupAddress: '500 Government St',
        city: 'Mobile',
        state: 'AL',
        zipCode: '36602',
        requestedService: 'Junk Removal',
        selectedItems: [{ category: 'Furniture', name: 'Chairs' }],
        consentGiven: true
      })
    });
    assert.equal(dbFailRes.status, 503);
    const dbFailJson = await dbFailRes.json();
    assert.equal(dbFailJson.ok, false);
    assert.equal(dbFailJson.businessPhone, '251-930-8621');

    // 2. Storage quota threshold alerts (70%, 85%, 95%) + 100% hard quota block while preserving text lead
    app.ctx.setSetting('storage_quota_bytes', 1000, null);
    app.ctx.setSetting('last_storage_alert_threshold', 0, null);

    const quotaInq = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.46' },
        body: JSON.stringify({
          firstName: 'Evelyn',
          lastName: 'Brooks',
          phone: '251-555-0277',
          pickupAddress: '710 Airport Blvd',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36609',
          requestedService: 'Garage Cleanouts',
          selectedItems: [{ category: 'Other', name: 'Garage contents' }],
          consentGiven: true,
          expectedFiles: 2
        })
      })
    ).json();
    assert.equal(quotaInq.ok, true);

    // Upload ~800 bytes -> crosses 70%/85% threshold and triggers storage alert notification
    const nearFullJpeg = makeValidJpegBuffer(760);
    const okUp = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': quotaInq.uploadToken,
        'X-File-Name': 'garage-1.jpg'
      },
      body: nearFullJpeg
    });
    assert.equal(okUp.status, 201);

    // Second upload exceeds 1000-byte quota -> returns 507 Insufficient Storage, yet text lead remains intact!
    const fullUp = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': quotaInq.uploadToken,
        'X-File-Name': 'garage-2.jpg'
      },
      body: nearFullJpeg
    });
    assert.equal(fullUp.status, 507);
    const fullJson = await fullUp.json();
    assert.match(fullJson.error, /already saved/i);
    assert.match(fullJson.error, /251-930-8621/);

    // Verify lead is safely persisted in CRM
    const savedLead = await (
      await fetch(`${baseUrl}/api/owner/leads/${quotaInq.leadNumber}`, {
        headers: { Cookie: ownerCookie }
      })
    ).json();
    assert.equal(savedLead.ok, true);
    assert.equal(savedLead.lead.fullName, 'Evelyn Brooks');

    // Restore generous storage quota
    app.ctx.setSetting('storage_quota_bytes', 1024 * 1024 * 1024, null);
  });

  it('permanently deletes leads, customers, media, notes, reminders, appointments, backups, drafts, and reclaims disk space', async () => {
    const ownerHeaders = {
      'Content-Type': 'application/json',
      Cookie: ownerCookie,
      'X-Zoiris-CSRF': csrfToken
    };

    // Create two fresh inquiries with real photo attachments
    const inq1 = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.71' },
        body: JSON.stringify({
          firstName: 'Frank',
          lastName: 'Holloway',
          phone: '251-555-0271',
          pickupAddress: '401 Dauphin St',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36602',
          requestedService: 'Furniture Removal',
          selectedItems: [{ category: 'Furniture', name: 'Couches' }],
          consentGiven: true,
          expectedFiles: 2
        })
      })
    ).json();
    assert.equal(inq1.ok, true);

    const inq2 = await (
      await fetch(`${baseUrl}/api/public/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.72' },
        body: JSON.stringify({
          firstName: 'Grace',
          lastName: 'Lin',
          phone: '251-555-0272',
          pickupAddress: '600 Government St',
          city: 'Mobile',
          state: 'AL',
          zipCode: '36602',
          requestedService: 'Electronics Pickup',
          selectedItems: [{ category: 'Electronics', name: 'Monitors' }],
          consentGiven: true,
          expectedFiles: 1
        })
      })
    ).json();
    assert.equal(inq2.ok, true);

    // Upload 2 photos to inq1 and 1 photo to inq2
    for (const name of ['sofa-1.jpg', 'sofa-2.jpg']) {
      const up = await fetch(`${baseUrl}/api/public/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': inq1.uploadToken, 'X-File-Name': name },
        body: makeValidJpegBuffer(8192)
      });
      assert.equal(up.status, 201);
    }
    const up2 = await fetch(`${baseUrl}/api/public/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': inq2.uploadToken, 'X-File-Name': 'tv.jpg' },
      body: makeValidJpegBuffer(8192)
    });
    assert.equal(up2.status, 201);

    // Add note, follow-up reminder, and scheduled appointment to inq1, then delete each individually
    const noteRes = await (
      await fetch(`${baseUrl}/api/owner/leads/${inq1.leadId}/notes`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ noteType: 'internal_note', body: 'Temporary note to delete' })
      })
    ).json();
    assert.equal(noteRes.ok, true);
    const noteId = noteRes.notes[0].id;
    const delNote = await fetch(`${baseUrl}/api/owner/notes/${noteId}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(delNote.status, 200);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM lead_notes WHERE id = ?').get(noteId).n, 0);

    const taskRes = await (
      await fetch(`${baseUrl}/api/owner/leads/${inq1.leadId}/follow-ups`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ title: 'Call Frank', dueDate: '2026-12-01' })
      })
    ).json();
    assert.equal(taskRes.ok, true);
    const delTask = await fetch(`${baseUrl}/api/owner/follow-ups/${taskRes.task.id}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(delTask.status, 200);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM follow_up_tasks WHERE id = ?').get(taskRes.task.id).n, 0);

    const apptRes = await (
      await fetch(`${baseUrl}/api/owner/calendar`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ leadId: inq1.leadId, scheduledDate: '2026-12-02', timeWindow: '8:00 AM – 11:00 AM' })
      })
    ).json();
    assert.equal(apptRes.ok, true);
    const delAppt = await fetch(`${baseUrl}/api/owner/calendar/${apptRes.appointment.id}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(delAppt.status, 200);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE id = ?').get(apptRes.appointment.id).n, 0);

    // Delete all media on inq1 and verify files + DB rows are physically gone
    const attRows1 = app.ctx.db.prepare('SELECT storage_key FROM lead_attachments WHERE lead_id = ?').all(inq1.leadId);
    assert.equal(attRows1.length, 2);
    for (const r of attRows1) {
      assert.equal(existsSync(join(app.ctx.paths.mediaDir, 'originals', r.storage_key)), true);
    }
    const delLeadMedia = await (await fetch(`${baseUrl}/api/owner/leads/${inq1.leadId}/media`, { method: 'DELETE', headers: ownerHeaders })).json();
    assert.equal(delLeadMedia.ok, true);
    assert.equal(delLeadMedia.deletedCount, 2);
    for (const r of attRows1) {
      assert.equal(existsSync(join(app.ctx.paths.mediaDir, 'originals', r.storage_key)), false);
    }
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM lead_attachments WHERE lead_id = ?').get(inq1.leadId).n, 0);

    // Delete inq1 lead itself -> lead + orphan customer removed
    const lead1CustomerId = app.ctx.db.prepare('SELECT customer_id FROM leads WHERE id = ?').get(inq1.leadId).customer_id;
    const delLead1 = await (await fetch(`${baseUrl}/api/owner/leads/${inq1.leadId}`, { method: 'DELETE', headers: ownerHeaders })).json();
    assert.equal(delLead1.ok, true);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE id = ?').get(inq1.leadId).n, 0);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(lead1CustomerId).n, 0);

    // Delete Customer 2 directly -> cascades lead2 + physical media file on disk
    const attRow2 = app.ctx.db.prepare('SELECT storage_key FROM lead_attachments WHERE lead_id = ?').get(inq2.leadId);
    assert.equal(existsSync(join(app.ctx.paths.mediaDir, 'originals', attRow2.storage_key)), true);
    const lead2CustomerId = app.ctx.db.prepare('SELECT customer_id FROM leads WHERE id = ?').get(inq2.leadId).customer_id;
    const delCust2 = await (await fetch(`${baseUrl}/api/owner/customers/${lead2CustomerId}`, { method: 'DELETE', headers: ownerHeaders })).json();
    assert.equal(delCust2.ok, true);
    assert.equal(existsSync(join(app.ctx.paths.mediaDir, 'originals', attRow2.storage_key)), false);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE id = ?').get(inq2.leadId).n, 0);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(lead2CustomerId).n, 0);

    // Create + delete backups
    const bk1 = await (await fetch(`${baseUrl}/api/owner/backups`, { method: 'POST', headers: ownerHeaders })).json();
    const bk2 = await (await fetch(`${baseUrl}/api/owner/backups`, { method: 'POST', headers: ownerHeaders })).json();
    assert.equal(existsSync(join(app.ctx.paths.backupsDir, bk1.backup.filename)), true);
    const delBk1 = await fetch(`${baseUrl}/api/owner/backups/${encodeURIComponent(bk1.backup.filename)}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(delBk1.status, 200);
    assert.equal(existsSync(join(app.ctx.paths.backupsDir, bk1.backup.filename)), false);
    const delAllBk = await (await fetch(`${baseUrl}/api/owner/backups`, { method: 'DELETE', headers: ownerHeaders })).json();
    assert.equal(delAllBk.ok, true);
    assert.equal(existsSync(join(app.ctx.paths.backupsDir, bk2.backup.filename)), false);

    // Create + delete SEO draft while protecting live published pages
    const draftRes = await (
      await fetch(`${baseUrl}/api/owner/seo-pages/create-draft`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ serviceId: 'appliance-removal', locationId: 'spanish-fort-al' })
      })
    ).json();
    assert.equal(draftRes.ok, true);
    const delDraft = await fetch(`${baseUrl}/api/owner/seo-pages/${encodeURIComponent(draftRes.record.id)}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(delDraft.status, 200);

    const seoList = await (await fetch(`${baseUrl}/api/owner/seo-pages`, { headers: { Cookie: ownerCookie } })).json();
    const publishedPage = seoList.pages.find((p) => p.status === 'published');
    assert.ok(publishedPage);
    const livePageBlocked = await fetch(`${baseUrl}/api/owner/seo-pages/${encodeURIComponent(publishedPage.id)}`, {
      method: 'DELETE',
      headers: ownerHeaders
    });
    assert.equal(livePageBlocked.status, 400);

    // Storage cleanup hub sweeps everything & compacts SQLite cleanly
    const cleanOut = await (
      await fetch(`${baseUrl}/api/owner/storage/cleanup`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ scopes: ['all_leads_customers', 'all_media', 'backups', 'analytics', 'logs', 'orphan_media'] })
      })
    ).json();
    assert.equal(cleanOut.ok, true);
    assert.equal(cleanOut.capacity.mediaStorage.activeAttachmentCount, 0);
    assert.equal(cleanOut.capacity.mediaStorage.activeOriginalBytes, 0);
    assert.equal(cleanOut.capacity.breakdown.allLeadsCount, 0);
  });

  it('tracks simultaneous multi-device owner logins, identifies each device, renews 30-day cookies, and revokes individual devices', async () => {
    // 1. Sign in simultaneously from an iPhone (PWA standalone) and an Android Phone
    const iphoneRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        'X-Forwarded-For': '198.51.100.71'
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword,
        rememberDevice: true,
        deviceHint: { platform: 'iPhone', maxTouchPoints: 5, standalone: true }
      })
    });
    assert.equal(iphoneRes.status, 200);
    const iphoneCookieHeader = iphoneRes.headers.get('set-cookie') || '';
    assert.match(iphoneCookieHeader, /Max-Age=2592000/); // 30 days
    const iphoneCookie = iphoneCookieHeader.split(';')[0];
    const iphoneData = await iphoneRes.json();
    assert.equal(iphoneData.currentDevice, 'iPhone · Safari (App)');
    assert.equal(iphoneData.deviceKind, 'phone');
    assert.equal(iphoneData.rememberDevice, true);

    const androidRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        'X-Forwarded-For': '198.51.100.72'
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword,
        rememberDevice: true,
        deviceHint: { platform: 'Android', maxTouchPoints: 5, standalone: false }
      })
    });
    assert.equal(androidRes.status, 200);
    const androidCookie = (androidRes.headers.get('set-cookie') || '').split(';')[0];
    const androidData = await androidRes.json();
    assert.equal(androidData.currentDevice, 'Android Phone · Chrome');
    assert.equal(androidData.deviceKind, 'phone');
    assert.ok(androidData.activeDeviceCount >= 3); // original ownerCookie + iPhone + Android

    // 2. Both devices AND the original desktop session stay signed in simultaneously
    const iphoneStatus = await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: iphoneCookie } })).json();
    assert.equal(iphoneStatus.authenticated, true);
    assert.equal(iphoneStatus.currentDevice, 'iPhone · Safari (App)');

    const androidStatusRes = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: androidCookie } });
    assert.match(androidStatusRes.headers.get('set-cookie') || '', /Max-Age=2592000/); // sliding 30-day renewal
    const androidStatus = await androidStatusRes.json();
    assert.equal(androidStatus.authenticated, true);
    assert.equal(androidStatus.currentDevice, 'Android Phone · Chrome');

    // 3. Security endpoint lists all active devices, and owner can sign out just the Android device
    const secBefore = await (await fetch(`${baseUrl}/api/owner/security`, { headers: { Cookie: iphoneCookie } })).json();
    assert.equal(secBefore.currentSessionId, iphoneData.sessionId);
    const labels = secBefore.sessions.map((s) => s.deviceLabel);
    assert.ok(labels.includes('iPhone · Safari (App)'));
    assert.ok(labels.includes('Android Phone · Chrome'));

    const revokeAndroid = await (
      await fetch(`${baseUrl}/api/owner/security/sessions/${androidData.sessionId}`, {
        method: 'DELETE',
        headers: { Cookie: iphoneCookie, 'X-Zoiris-CSRF': iphoneData.csrfToken }
      })
    ).json();
    assert.equal(revokeAndroid.ok, true);
    assert.equal(revokeAndroid.signedOutCurrent, false);

    // Android is now signed out, while iPhone and original desktop remain signed in
    const androidAfter = await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: androidCookie } })).json();
    assert.equal(androidAfter.authenticated, false);
    const iphoneAfter = await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: iphoneCookie } })).json();
    assert.equal(iphoneAfter.authenticated, true);
  });

  it('enforces RFC 6238 TOTP MFA enrollment, recovery codes, and brute-force login lockout', async () => {
    // 1. Enroll TOTP MFA on owner account
    const beginMfa = await (
      await fetch(`${baseUrl}/api/owner/security/mfa/begin`, {
        method: 'POST',
        headers: { Cookie: ownerCookie, 'X-Zoiris-CSRF': csrfToken }
      })
    ).json();
    assert.equal(beginMfa.ok, true);
    assert.ok(beginMfa.secret);
    assert.match(beginMfa.otpauthUri, /^otpauth:\/\/totp\//);

    const validCode = totpCode(beginMfa.secret);
    const confirmMfa = await (
      await fetch(`${baseUrl}/api/owner/security/mfa/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
          'X-Zoiris-CSRF': csrfToken
        },
        body: JSON.stringify({ code: validCode })
      })
    ).json();
    assert.equal(confirmMfa.ok, true);
    assert.equal(confirmMfa.recoveryCodes.length, 8);

    // 2. Password-only login now demands MFA (`mfaRequired: true`) without issuing a session cookie
    const challengeRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.50' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword })
    });
    assert.equal(challengeRes.status, 200);
    const challengeJson = await challengeRes.json();
    assert.equal(challengeJson.mfaRequired, true);
    assert.equal(challengeRes.headers.get('set-cookie'), null);

    // 3. Wrong 6-digit TOTP rejected with 401
    const badTotp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.51' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, totp: '000000' })
    });
    assert.equal(badTotp.status, 401);

    // 4. Valid 6-digit TOTP succeeds
    const goodTotp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.52' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, totp: totpCode(beginMfa.secret) })
    });
    assert.equal(goodTotp.status, 200);
    assert.equal((await goodTotp.json()).mfaRequired, false);

    // 5. One-time recovery code succeeds once and is consumed (replay rejected with 401)
    const oneCode = confirmMfa.recoveryCodes[0];
    const recLogin1 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.53' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, recoveryCode: oneCode })
    });
    assert.equal(recLogin1.status, 200);

    const recLoginReplay = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.54' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, recoveryCode: oneCode })
    });
    assert.equal(recLoginReplay.status, 401);

    // 6. Brute-force lockout after repeated invalid attempts from an attacker IP
    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99' },
        body: JSON.stringify({ email: 'unknown-target@zoirisjunkremoval.com', password: 'Wrong-Password!' })
      });
      lastStatus = r.status;
      if (lastStatus === 429) break;
    }
    assert.equal(lastStatus, 429, 'Expected HTTP 429 lockout after repeated failed logins');
  });
});
