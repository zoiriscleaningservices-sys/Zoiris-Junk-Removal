/**
 * cloud-bridge/api/bridge.mjs
 * Zoiris 24/7 Serverless Native Web Push (RFC 8291 `aes128gcm` + RFC 8292 `ES256` VAPID)
 * & AES-256-GCM Encrypted Lead Sync Bridge.
 *
 * Zero secrets in code — all cryptographic keys and tokens are read from environment variables:
 *   - BLOB_READ_WRITE_TOKEN
 *   - ZOIRIS_MASTER_KEY
 *   - ZOIRIS_OWNER_EMAIL
 *   - ZOIRIS_OWNER_PW_HASH
 *   - ZOIRIS_VAPID_SUBJECT
 *   - ZOIRIS_VAPID_PUBLIC_KEY
 *   - ZOIRIS_VAPID_PRIVATE_JWK
 *   - ZOIRIS_LIVE_TOPIC
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  pbkdf2Sync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual
} from 'node:crypto';
let blobSdkPromise = null;
function getBlobSdk() {
  if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob');
  return blobSdkPromise;
}

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'sharklasers.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
  'burnermail.io', 'mailnesia.com', 'inboxkitten.com', 'mail.tm', 'discard.email', 'fakemail.net',
  'example.com', 'example.org', 'test.com'
]);

const PROMO_PATTERNS = [
  /\bseo\b/i, /backlinks?/i, /guest\s*post/i, /first page of google/i, /rank(ing)? (higher|#?1)/i,
  /web\s*design/i, /website (redesign|traffic)/i, /digital marketing/i, /marketing (services|agency)/i,
  /lead generation/i, /crypto|bitcoin|forex|binary option/i, /casino|betting|viagra|cialis/i,
  /whats\s?app|telegram/i, /unsubscribe/i, /dear (sir|madam|business owner)/i
];
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ru|xyz|info|biz|top|site|online|shop)\b)/gi;
const URL_TEST = new RegExp(URL_RE.source, 'i');

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

export function normalizeBase64Url(input) {
  return String(input || '')
    .trim()
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/* ---------------- Password Hashing & Bearer Auth ---------------- */
export function hashOwnerPassword(password, saltHex = randomBytes(16).toString('hex')) {
  const derived = pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), 100000, 32, 'sha256').toString('hex');
  return `pbkdf2$${saltHex}$${derived}`;
}

export function verifyOwnerPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const candidate = hashOwnerPassword(password, parts[1]);
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createBearerToken(email, tokenSecretBuf, ttlSeconds = 365 * 86400) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payloadB64 = Buffer.from(
    JSON.stringify({
      sub: String(email).toLowerCase(),
      iat: nowSec,
      exp: nowSec + ttlSeconds
    })
  ).toString('base64url');
  const sigB64 = hmacSha256(tokenSecretBuf, payloadB64).toString('base64url');
  return `zbt1.${payloadB64}.${sigB64}`;
}

export function verifyBearerToken(rawHeaderOrToken, tokenSecretBuf) {
  const raw = String(rawHeaderOrToken || '').replace(/^Bearer\s+/i, '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'zbt1') return null;
  const expectedSig = hmacSha256(tokenSecretBuf, parts[1]);
  let actualSig;
  try {
    actualSig = Buffer.from(normalizeBase64Url(parts[2]), 'base64url');
  } catch {
    return null;
  }
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(normalizeBase64Url(parts[1]), 'base64url').toString('utf8'));
    if (!payload?.sub || !payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- AES-256-GCM Encrypted Blob Envelope ---------------- */
const MAGIC = Buffer.from('ZENC1', 'ascii');

export function encryptRecord(obj, aesKeyBuf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKeyBuf, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

export function decryptRecord(buf, aesKeyBuf) {
  const b = Buffer.from(buf);
  if (b.length < 33 || b.subarray(0, 5).toString('ascii') !== 'ZENC1') {
    throw new Error('Invalid encrypted blob header.');
  }
  const iv = b.subarray(5, 17);
  const tag = b.subarray(17, 33);
  const ct = b.subarray(33);
  const decipher = createDecipheriv('aes-256-gcm', aesKeyBuf, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/* ---------------- RFC 8291 + RFC 8292 Web Push ---------------- */
export function buildVapidAuthHeader(endpoint, vapidKeys, nowSec = Math.floor(Date.now() / 1000)) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const headerB64 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payloadB64 = Buffer.from(
    JSON.stringify({
      aud: audience,
      exp: nowSec + 12 * 3600,
      sub: vapidKeys.subject || 'mailto:owner@zoirisjunkremoval.com'
    })
  ).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const privKeyObj = createPrivateKey({ key: vapidKeys.privateJwk, format: 'jwk' });
  const sig = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: privKeyObj,
    dsaEncoding: 'ieee-p1363'
  });
  return `vapid t=${signingInput}.${sig.toString('base64url')}, k=${vapidKeys.publicKey}`;
}

export function encryptWebPushPayload(payloadText, subscriptionKeys) {
  const uaPublic = Buffer.from(normalizeBase64Url(subscriptionKeys.p256dh), 'base64url');
  const authSecret = Buffer.from(normalizeBase64Url(subscriptionKeys.auth), 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid push subscription p256dh key.');
  }
  if (authSecret.length !== 16) {
    throw new Error('Invalid push subscription auth secret.');
  }

  const senderEcdh = createECDH('prime256v1');
  senderEcdh.generateKeys();
  const asPublic = senderEcdh.getPublicKey();
  const ecdhSecret = senderEcdh.computeSecret(uaPublic);
  const salt = randomBytes(16);

  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic, Buffer.from([0x01])]);
  const ikm = hmacSha256(prkKey, keyInfo);

  const prk = hmacSha256(salt, ikm);
  const cek = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 16);
  const nonce = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 12);

  const padded = Buffer.concat([Buffer.from(String(payloadText), 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, encrypted]);
}

/* ---------------- Anti-Spam Screening ---------------- */
function screenSubmission(inq) {
  const fieldErrors = {};
  const flags = [];
  let score = 0;

  let d = String(inq.phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) {
    fieldErrors.phone = 'Enter a 10-digit US phone number.';
  } else {
    const area = d.slice(0, 3);
    const exch = d.slice(3, 6);
    const line = d.slice(6);
    if (/^[01]/.test(area) || /^[01]/.test(exch) || /^\d11$/.test(area)) {
      fieldErrors.phone = 'That phone number is not a valid US number.';
    } else if (/^(\d)\1{9}$/.test(d) || d === '1234567890' || d === '0123456789' || d === '9876543210') {
      fieldErrors.phone = 'Please enter your real phone number so we can reach you.';
    } else if (exch === '555' && /^01\d\d$/.test(line)) {
      fieldErrors.phone = '555-01xx numbers are fictional. Please enter your real phone number.';
    }
  }

  for (const key of ['firstName', 'lastName']) {
    const v = String(inq[key] || '');
    if (!v.trim()) continue;
    if (URL_TEST.test(v)) fieldErrors[key] = 'Names cannot contain links.';
    else if (!/\p{L}/u.test(v)) fieldErrors[key] = 'Please enter your real name.';
  }

  const email = String(inq.email || '').trim().toLowerCase();
  if (email) {
    const domain = email.split('@')[1] || '';
    if (DISPOSABLE_DOMAINS.has(domain)) {
      fieldErrors.email = 'Please use an email you actually check (temporary inboxes are not accepted), or leave it blank.';
    }
  }

  const text = ['itemDescription', 'otherItemDescription', 'accessInstructions', 'customerNotes']
    .map((k) => String(inq[k] || ''))
    .join(' \n ');
  const urlCount = (text.match(URL_RE) || []).length;
  if (urlCount) {
    flags.push(`${urlCount} link(s) in message`);
    score += Math.min(2, urlCount) * 35;
  }
  let promoHits = 0;
  for (const re of PROMO_PATTERNS) if (re.test(text)) promoHits++;
  if (promoHits) {
    flags.push(`Promotional wording (${promoHits})`);
    score += Math.min(3, promoHits) * 25;
  }

  return {
    blocked: score >= 70,
    fieldErrors,
    score,
    flags
  };
}

/* ---------------- Storage Adapter (Vercel Blob or Test Memory Store) ---------------- */
function createEncryptedStore({ aesKeyBuf, namespace, token, memoryMap, fetchImpl }) {
  if (memoryMap) {
    return {
      async putJson(relPath, obj) {
        const pathname = `${namespace}/${relPath}`;
        const buf = encryptRecord(obj, aesKeyBuf);
        memoryMap.set(pathname, { pathname, url: `mem://${pathname}`, size: buf.length, uploadedAt: new Date(), buf });
        return { pathname, url: `mem://${pathname}` };
      },
      async listPrefix(relPrefix) {
        const fullPrefix = `${namespace}/${relPrefix}`;
        const out = [];
        for (const item of memoryMap.values()) {
          if (item.pathname.startsWith(fullPrefix)) out.push(item);
        }
        return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
      },
      async readJson(item) {
        const found = memoryMap.get(item.pathname);
        if (!found) return null;
        return decryptRecord(found.buf, aesKeyBuf);
      },
      async deleteItems(items) {
        for (const it of items) memoryMap.delete(typeof it === 'string' ? it : it.pathname);
      }
    };
  }

  return {
    async putJson(relPath, obj) {
      const { put: blobPut } = await getBlobSdk();
      const pathname = `${namespace}/${relPath}`;
      const buf = encryptRecord(obj, aesKeyBuf);
      return blobPut(pathname, buf, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/octet-stream',
        token
      });
    },
    async listPrefix(relPrefix) {
      const { list: blobList } = await getBlobSdk();
      const fullPrefix = `${namespace}/${relPrefix}`;
      const all = [];
      let cursor;
      for (let i = 0; i < 5; i++) {
        const res = await blobList({ prefix: fullPrefix, limit: 1000, cursor, token });
        all.push(...(res.blobs || []));
        if (!res.hasMore || !res.cursor) break;
        cursor = res.cursor;
      }
      return all.sort((a, b) => a.pathname.localeCompare(b.pathname));
    },
    async readJson(item) {
      const r = await fetchImpl(item.url, { cache: 'no-store' });
      if (!r.ok) return null;
      const arr = await r.arrayBuffer();
      return decryptRecord(Buffer.from(arr), aesKeyBuf);
    },
    async deleteItems(items) {
      const urls = items.map((it) => (typeof it === 'string' ? it : it.url)).filter(Boolean);
      if (!urls.length) return;
      const { del: blobDel } = await getBlobSdk();
      await blobDel(urls, { token });
    }
  };
}

async function readJsonBody(req, maxBytes = 4.3 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (Buffer.isBuffer(req.body)) {
      const txt = req.body.toString('utf8').trim();
      return txt ? JSON.parse(txt) : {};
    }
    if (typeof req.body === 'string') {
      const txt = req.body.trim();
      return txt ? JSON.parse(txt) : {};
    }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error('Request payload exceeds maximum size.');
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, req, status, obj) {
  const origin = req.headers?.origin || '*';
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key, X-Zoiris-CSRF');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export function createBridgeHandler(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const memoryMap = options.memoryMap || (env.ZOIRIS_MEMORY_STORE === '1' ? new Map() : null);

  function getRuntimeSecrets() {
    const masterKey = String(env.ZOIRIS_MASTER_KEY || '').trim();
    if (!masterKey) {
      const err = new Error('Cloud Bridge is missing ZOIRIS_MASTER_KEY configuration.');
      err.status = 500;
      throw err;
    }
    const aesKeyBuf = createHash('sha256').update(masterKey).digest();
    const tokenSecretBuf = hmacSha256(aesKeyBuf, 'zoiris-bearer-v1');
    const namespace = `zvault_${hmacSha256(aesKeyBuf, 'zoiris-ns-v1').toString('hex').slice(0, 16)}`;
    const ownerEmail = String(env.ZOIRIS_OWNER_EMAIL || 'owner@zoirisjunkremoval.com').trim().toLowerCase();
    const ownerPwHash = String(env.ZOIRIS_OWNER_PW_HASH || '').trim();
    const liveTopic = String(env.ZOIRIS_LIVE_TOPIC || 'zoiris_live_eeaf07c6f04d03eee2').trim();
    const relayUrl = String(env.ZOIRIS_RELAY_URL || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    const vapidPublicKey = String(env.ZOIRIS_VAPID_PUBLIC_KEY || '').trim();
    let vapidPrivateJwk = null;
    if (env.ZOIRIS_VAPID_PRIVATE_JWK) {
      try {
        vapidPrivateJwk =
          typeof env.ZOIRIS_VAPID_PRIVATE_JWK === 'string'
            ? JSON.parse(env.ZOIRIS_VAPID_PRIVATE_JWK)
            : env.ZOIRIS_VAPID_PRIVATE_JWK;
      } catch {}
    }
    const vapid =
      vapidPublicKey && vapidPrivateJwk
        ? {
            subject: String(env.ZOIRIS_VAPID_SUBJECT || `mailto:${ownerEmail}`),
            publicKey: vapidPublicKey,
            privateJwk: vapidPrivateJwk
          }
        : null;

    const store = createEncryptedStore({
      aesKeyBuf,
      namespace,
      token: env.BLOB_READ_WRITE_TOKEN,
      memoryMap,
      fetchImpl
    });

    return { aesKeyBuf, tokenSecretBuf, ownerEmail, ownerPwHash, liveTopic, relayUrl, vapid, store };
  }

  async function publishLiveSignal(cfg, eventObj) {
    if (!cfg.liveTopic || options.disableLiveBroadcast) return;
    try {
      await fetchImpl(`${cfg.relayUrl}/${encodeURIComponent(cfg.liveTopic)}`, {
        method: 'POST',
        headers: {
          Title: 'Zoiris Sync Signal',
          Priority: 'default'
        },
        body: JSON.stringify(eventObj),
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // Non-fatal: clients also reconcile on focus & interval
    }
  }

  async function loadActiveSubscriptions(store) {
    const items = await store.listPrefix('push/sub_');
    const byEndpoint = new Map();
    const staleItems = [];

    await Promise.all(
      items.map(async (item) => {
        try {
          const rec = await store.readJson(item);
          if (!rec?.endpoint || !rec?.p256dh || !rec?.auth) return;
          const prev = byEndpoint.get(rec.endpoint);
          if (!prev || String(item.pathname) > String(prev.item.pathname)) {
            if (prev) staleItems.push(prev.item);
            byEndpoint.set(rec.endpoint, { item, rec });
          } else {
            staleItems.push(item);
          }
        } catch {}
      })
    );

    if (staleItems.length) {
      store.deleteItems(staleItems).catch(() => {});
    }
    return [...byEndpoint.values()];
  }

  async function sendWebPushToDevices(cfg, payloadObj, targetEndpoint = null) {
    if (!cfg.vapid) return { sent: 0, failed: 0, total: 0 };
    const entries = await loadActiveSubscriptions(cfg.store);
    const filtered = targetEndpoint ? entries.filter((e) => e.rec.endpoint === targetEndpoint) : entries;
    if (!filtered.length) return { sent: 0, failed: 0, total: 0 };

    const payloadText = JSON.stringify(payloadObj);
    let sent = 0;
    let failed = 0;
    const deadItems = [];

    await Promise.all(
      filtered.map(async ({ item, rec }) => {
        try {
          const body = encryptWebPushPayload(payloadText, { p256dh: rec.p256dh, auth: rec.auth });
          const authorization = buildVapidAuthHeader(rec.endpoint, cfg.vapid);
          const r = await fetchImpl(rec.endpoint, {
            method: 'POST',
            headers: {
              Authorization: authorization,
              'Content-Type': 'application/octet-stream',
              'Content-Encoding': 'aes128gcm',
              'Content-Length': String(body.length),
              TTL: '86400',
              Urgency: 'high'
            },
            body,
            signal: AbortSignal.timeout(10000)
          });
          if (r.status === 404 || r.status === 410) {
            deadItems.push(item);
            failed++;
            return;
          }
          if (!r.ok) {
            failed++;
            return;
          }
          sent++;
        } catch {
          failed++;
        }
      })
    );

    if (deadItems.length) {
      await cfg.store.deleteItems(deadItems).catch(() => {});
    }
    return { sent, failed, total: filtered.length };
  }

  async function getEffectiveOwnerCredentials(cfg) {
    try {
      const overrides = await cfg.store.listPrefix('auth/pw_');
      if (overrides.length) {
        const latest = overrides[overrides.length - 1];
        const parsed = await cfg.store.readJson(latest);
        if (parsed?.passwordHash) {
          return {
            email: String(parsed.email || cfg.ownerEmail).toLowerCase(),
            passwordHash: parsed.passwordHash,
            displayName: parsed.displayName || 'Zoiris Owner'
          };
        }
      }
    } catch {}
    return {
      email: cfg.ownerEmail,
      passwordHash: cfg.ownerPwHash,
      displayName: 'Zoiris Owner'
    };
  }

  function requireBearer(req, cfg) {
    const authHeader = req.headers?.authorization || '';
    const claims = verifyBearerToken(authHeader, cfg.tokenSecretBuf);
    if (!claims) {
      const err = new Error('Cloud authentication required. Sign in with your owner email and password.');
      err.status = 401;
      throw err;
    }
    return claims;
  }

  return async function handler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      const origin = req.headers?.origin || '*';
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key, X-Zoiris-CSRF');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.end();
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://localhost');
    } catch {
      return sendJson(res, req, 400, { ok: false, error: 'Malformed URL.' });
    }
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';

    try {
      if (pathname === '/' || pathname === '/api/health') {
        const cfg = getRuntimeSecrets();
        return sendJson(res, req, 200, {
          ok: true,
          service: 'zoiris-cloud-bridge',
          webPushReady: Boolean(cfg.vapid?.publicKey),
          liveSseUrl: `${cfg.relayUrl}/${cfg.liveTopic}/sse`
        });
      }

      const cfg = getRuntimeSecrets();

      /* ---------------- 1. Public Config & Customer Form Submission ---------------- */
      if (pathname === '/api/public/config' && method === 'GET') {
        return sendJson(res, req, 200, {
          ok: true,
          vapidPublicKey: cfg.vapid?.publicKey || '',
          liveTopic: cfg.liveTopic,
          liveSseUrl: `${cfg.relayUrl}/${cfg.liveTopic}/sse`
        });
      }

      if (pathname === '/api/public/submit' && method === 'POST') {
        const body = await readJsonBody(req);
        const inq = body.inquiry && typeof body.inquiry === 'object' ? body.inquiry : body;
        if (inq._gotcha) {
          return sendJson(res, req, 200, { ok: true, leadNumber: 'ZJ-IGNORED' });
        }

        const screen = screenSubmission(inq);
        if (screen.blocked) {
          return sendJson(res, req, 422, {
            ok: false,
            error: 'This request looks automated or promotional, so it was not sent. Please call 251-930-8621 if you need a pickup.'
          });
        }
        if (Object.keys(screen.fieldErrors).length) {
          return sendJson(res, req, 400, {
            ok: false,
            error: 'Please check the highlighted fields.',
            fieldErrors: screen.fieldErrors
          });
        }

        const rawLeadNum = String(body.leadNumber || inq.leadNumber || '').trim();
        const leadNumber = /^ZJ-\d{4}-[A-Z0-9]{4,10}$/i.test(rawLeadNum)
          ? rawLeadNum.toUpperCase()
          : `ZJ-${new Date().getFullYear()}-${String(100000 + randomBytes(4).readUInt32BE(0) % 900000)}`;

        // Idempotency check against existing leads with same leadNumber
        const existing = await cfg.store.listPrefix('leads/');
        const suffix = `_${leadNumber}.enc`;
        if (existing.some((b) => b.pathname.endsWith(suffix))) {
          return sendJson(res, req, 200, { ok: true, deduplicated: true, leadNumber, leadId: leadNumber });
        }

        const submittedAt = new Date().toISOString();
        const tsKey = String(Date.now()).padStart(13, '0');
        const media = Array.isArray(body.media) ? body.media.slice(0, 8) : [];
        const verifiedGeo = body.verifiedGeo || null;

        const record = {
          leadNumber,
          submittedAt,
          inquiry: inq,
          verifiedGeo,
          media,
          spamScore: screen.score,
          spamFlags: screen.flags
        };

        await cfg.store.putJson(`leads/${tsKey}_${leadNumber}.enc`, record);

        const fullName = String(inq.name || `${inq.firstName || ''} ${inq.lastName || ''}`.trim() || 'New Customer').trim();
        const city = String(verifiedGeo?.address?.city || inq.city || 'Mobile').trim();
        const svc = String(inq.requestedService || 'Junk Removal').trim();
        const mediaNote = media.length ? ` · ${media.length} photo${media.length === 1 ? '' : 's'}` : '';

        // Dispatch Native Installed-PWA Background Push + Realtime Browser SSE Signal in parallel
        const [webPush] = await Promise.all([
          sendWebPushToDevices(cfg, {
            kind: 'new_lead',
            leadNumber,
            title: `New Pickup Request · ${leadNumber}`,
            body: `${fullName} · ${city}, AL · ${svc}${mediaNote}`,
            url: `/owner/leads/${leadNumber}`,
            tag: `zoiris-lead-${leadNumber}`
          }),
          publishLiveSignal(cfg, {
            type: 'lead.created',
            leadNumber,
            ts: Date.now()
          })
        ]);

        return sendJson(res, req, 201, {
          ok: true,
          leadId: leadNumber,
          leadNumber,
          uploadToken: '',
          webPushSent: webPush.sent
        });
      }

      /* ---------------- 2. Owner Cloud Login & Token Verification ---------------- */
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const creds = await getEffectiveOwnerCredentials(cfg);

        if (!creds.passwordHash || email !== creds.email || !verifyOwnerPassword(password, creds.passwordHash)) {
          return sendJson(res, req, 401, { ok: false, error: 'Invalid owner email or password.' });
        }

        const bearerToken = createBearerToken(creds.email, cfg.tokenSecretBuf);
        return sendJson(res, req, 200, {
          ok: true,
          bearerToken,
          owner: {
            email: creds.email,
            displayName: creds.displayName
          },
          vapidPublicKey: cfg.vapid?.publicKey || '',
          liveTopic: cfg.liveTopic,
          liveSseUrl: `${cfg.relayUrl}/${cfg.liveTopic}/sse`
        });
      }

      if (pathname === '/api/auth/verify' && method === 'GET') {
        const claims = requireBearer(req, cfg);
        return sendJson(res, req, 200, {
          ok: true,
          authenticated: true,
          email: claims.sub,
          vapidPublicKey: cfg.vapid?.publicKey || '',
          liveTopic: cfg.liveTopic,
          liveSseUrl: `${cfg.relayUrl}/${cfg.liveTopic}/sse`
        });
      }

      /* ---------------- 3. Protected Owner Push & Lead Sync Endpoints ---------------- */
      requireBearer(req, cfg);

      if (pathname === '/api/owner/security/password' && method === 'POST') {
        const body = await readJsonBody(req);
        const creds = await getEffectiveOwnerCredentials(cfg);
        if (!verifyOwnerPassword(String(body.currentPassword || ''), creds.passwordHash)) {
          return sendJson(res, req, 401, { ok: false, error: 'Current password did not match.' });
        }
        const newPw = String(body.newPassword || '');
        if (newPw.length < 8) {
          return sendJson(res, req, 400, { ok: false, error: 'Choose at least 8 characters.' });
        }
        const oldBlobs = await cfg.store.listPrefix('auth/pw_');
        const newHash = hashOwnerPassword(newPw);
        await cfg.store.putJson(`auth/pw_${String(Date.now()).padStart(13, '0')}.enc`, {
          email: creds.email,
          displayName: creds.displayName,
          passwordHash: newHash,
          updatedAt: new Date().toISOString()
        });
        if (oldBlobs.length) await cfg.store.deleteItems(oldBlobs).catch(() => {});
        return sendJson(res, req, 200, { ok: true });
      }

      if (pathname === '/api/owner/push/status' && method === 'GET') {
        const entries = await loadActiveSubscriptions(cfg.store);
        return sendJson(res, req, 200, {
          ok: true,
          cloudConnected: true,
          supported: Boolean(cfg.vapid?.publicKey),
          vapidPublicKey: cfg.vapid?.publicKey || '',
          subscriptionCount: entries.length,
          subscriptions: entries.map(({ rec }) => ({
            id: rec.id,
            deviceLabel: rec.deviceLabel,
            deviceKind: rec.deviceKind,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt
          })),
          liveTopic: cfg.liveTopic,
          liveSseUrl: `${cfg.relayUrl}/${cfg.liveTopic}/sse`
        });
      }

      if (pathname === '/api/owner/push/subscribe' && method === 'POST') {
        const body = await readJsonBody(req);
        const sub = body.subscription || {};
        const endpoint = String(sub.endpoint || '').trim();
        const p256dh = normalizeBase64Url(sub.keys?.p256dh);
        const auth = normalizeBase64Url(sub.keys?.auth);
        if (!endpoint || !/^https?:\/\//i.test(endpoint) || !p256dh || !auth) {
          return sendJson(res, req, 400, { ok: false, error: 'Valid push subscription endpoint and encryption keys are required.' });
        }

        const subId = createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
        const existingForEndpoint = await cfg.store.listPrefix(`push/sub_${subId}_`);
        const nowIso = new Date().toISOString();
        const rec = {
          id: subId,
          endpoint,
          p256dh,
          auth,
          deviceLabel: String(body.deviceLabel || 'Owner Mobile App').slice(0, 120),
          deviceKind: String(body.deviceKind || 'phone').slice(0, 32),
          userAgent: String(req.headers?.['user-agent'] || '').slice(0, 240),
          createdAt: nowIso,
          updatedAt: nowIso
        };

        await cfg.store.putJson(`push/sub_${subId}_${String(Date.now()).padStart(13, '0')}.enc`, rec);
        if (existingForEndpoint.length) {
          await cfg.store.deleteItems(existingForEndpoint).catch(() => {});
        }

        if (body.sendWelcome !== false) {
          await sendWebPushToDevices(
            cfg,
            {
              kind: 'welcome',
              title: 'Zoiris Mobile App Alerts Enabled',
              body: 'Success! New website pickup requests will pop up right here — even when the app is closed.',
              url: '/owner/command-center/',
              tag: 'zoiris-welcome'
            },
            endpoint
          );
        }

        const entries = await loadActiveSubscriptions(cfg.store);
        return sendJson(res, req, 201, {
          ok: true,
          subscriptionCount: entries.length,
          subscriptions: entries.map((x) => ({
            id: x.rec.id,
            deviceLabel: x.rec.deviceLabel,
            deviceKind: x.rec.deviceKind,
            updatedAt: x.rec.updatedAt
          }))
        });
      }

      if (pathname === '/api/owner/push/subscribe' && method === 'DELETE') {
        const body = await readJsonBody(req);
        const endpoint = String(body.endpoint || '').trim();
        const id = endpoint ? createHash('sha256').update(endpoint).digest('hex').slice(0, 24) : String(body.id || '').trim();
        if (id) {
          const matches = await cfg.store.listPrefix(`push/sub_${id}_`);
          if (matches.length) await cfg.store.deleteItems(matches);
        }
        const entries = await loadActiveSubscriptions(cfg.store);
        return sendJson(res, req, 200, { ok: true, subscriptionCount: entries.length });
      }

      if (pathname === '/api/owner/push/test' && method === 'POST') {
        const [webPush] = await Promise.all([
          sendWebPushToDevices(cfg, {
            kind: 'test',
            title: 'Zoiris Background App Test',
            body: 'Your installed Zoiris app notifications are working 100% — even when closed!',
            url: '/owner/command-center/',
            tag: 'zoiris-test-alert'
          }),
          publishLiveSignal(cfg, { type: 'push.test', ts: Date.now() })
        ]);
        return sendJson(res, req, 200, {
          ok: true,
          webPush
        });
      }

      if (pathname === '/api/owner/leads/sync' && method === 'POST') {
        const body = await readJsonBody(req);
        const known = new Set(Array.isArray(body.knownLeadNumbers) ? body.knownLeadNumbers.map((x) => String(x).toUpperCase()) : []);
        const blobs = await cfg.store.listPrefix('leads/');

        const activeLeadNumbers = [];
        const missingBlobs = [];
        for (const b of blobs) {
          const m = b.pathname.match(/_(ZJ-[A-Z0-9-]+)\.enc$/i);
          const leadNum = m ? m[1].toUpperCase() : '';
          if (leadNum) activeLeadNumbers.push(leadNum);
          if (!leadNum || !known.has(leadNum)) {
            missingBlobs.push(b);
          }
        }

        // Newest-first so most urgent incoming requests land first; cap response under 3.2 MB
        missingBlobs.reverse();
        const leads = [];
        let approxBytes = 0;
        let hasMore = false;

        for (const item of missingBlobs) {
          if (leads.length >= 20 || approxBytes > 3.0 * 1024 * 1024) {
            hasMore = true;
            break;
          }
          try {
            const rec = await cfg.store.readJson(item);
            if (rec) {
              const sz = JSON.stringify(rec).length;
              if (leads.length > 0 && approxBytes + sz > 3.2 * 1024 * 1024) {
                hasMore = true;
                break;
              }
              leads.push(rec);
              approxBytes += sz;
            }
          } catch {}
        }

        return sendJson(res, req, 200, {
          ok: true,
          leads,
          activeLeadNumbers,
          hasMore
        });
      }

      if (pathname === '/api/owner/leads/bulk-delete' && method === 'POST') {
        const body = await readJsonBody(req);
        const blobs = await cfg.store.listPrefix('leads/');
        let toDelete = [];
        const deletedNumbers = [];

        if (body.all === true) {
          toDelete = blobs;
          for (const b of blobs) {
            const m = b.pathname.match(/_(ZJ-[A-Z0-9-]+)\.enc$/i);
            if (m) deletedNumbers.push(m[1].toUpperCase());
          }
        } else if (Array.isArray(body.leadNumbers) && body.leadNumbers.length) {
          const targets = new Set(body.leadNumbers.map((x) => String(x).toUpperCase()));
          for (const b of blobs) {
            const m = b.pathname.match(/_(ZJ-[A-Z0-9-]+)\.enc$/i);
            const num = m ? m[1].toUpperCase() : '';
            if (num && targets.has(num)) {
              toDelete.push(b);
              deletedNumbers.push(num);
            }
          }
        }

        if (toDelete.length) {
          await cfg.store.deleteItems(toDelete);
          await publishLiveSignal(cfg, {
            type: 'lead.deleted',
            leadNumbers: deletedNumbers,
            ts: Date.now()
          });
        }
        return sendJson(res, req, 200, { ok: true, deletedCount: toDelete.length, deletedNumbers });
      }

      const singleDelMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)$/);
      if (singleDelMatch && method === 'DELETE') {
        const target = decodeURIComponent(singleDelMatch[1]).toUpperCase();
        const blobs = await cfg.store.listPrefix('leads/');
        const matches = blobs.filter((b) => b.pathname.toUpperCase().endsWith(`_${target}.ENC`));
        if (matches.length) {
          await cfg.store.deleteItems(matches);
          await publishLiveSignal(cfg, {
            type: 'lead.deleted',
            leadNumbers: [target],
            ts: Date.now()
          });
        }
        return sendJson(res, req, 200, { ok: true, deletedCount: matches.length, leadNumber: target });
      }

      return sendJson(res, req, 404, { ok: false, error: 'Route not found.' });
    } catch (err) {
      const status = Number(err?.status || 500);
      return sendJson(res, req, status, {
        ok: false,
        error: err?.message || 'Unexpected cloud bridge error.'
      });
    }
  };
}

export default createBridgeHandler();
