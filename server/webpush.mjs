/**
 * server/webpush.mjs
 * Standards-compliant Web Push implementation (RFC 8291 `aes128gcm` + RFC 8292 `vapid` ES256)
 * using pure Node.js `node:crypto` with zero external dependencies.
 *
 * Delivers background OS push notifications to iPhone/iPad Home Screen PWAs (iOS 16.4+),
 * Android Chrome/Edge/Firefox/Samsung Internet PWAs, and Desktop browsers even when
 * the Zoiris Command Center app is closed and the phone screen is locked.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Loads or generates a persistent P-256 VAPID keypair inside `.zoiris-private/vapid.json`
 * (or reads `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` environment variables).
 */
export function loadOrCreateVapidKeys(vaultBaseDir) {
  const vapidFile = join(vaultBaseDir, 'vapid.json');
  if (existsSync(vapidFile)) {
    try {
      const parsed = JSON.parse(readFileSync(vapidFile, 'utf8'));
      if (parsed?.publicKey && parsed?.privateJwk) return parsed;
    } catch {
      // regenerate below if corrupted
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const uncompressedPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url')
  ]);

  const record = {
    createdAt: new Date().toISOString(),
    subject: process.env.VAPID_SUBJECT || 'mailto:owner@zoirisjunkremoval.com',
    publicKey: uncompressedPub.toString('base64url'),
    privateJwk: privJwk
  };

  try {
    writeFileSync(vapidFile, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch {
    // ignore read-only fs in ephemeral environments
  }
  return record;
}

/**
 * Builds an RFC 8292 ES256 VAPID Authorization header (`vapid t=<jwt>, k=<pubKey>`).
 */
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

  const jwt = `${signingInput}.${sig.toString('base64url')}`;
  return {
    authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
    jwt
  };
}

/**
 * Encrypts a UTF-8 JSON string using RFC 8291 (`aes128gcm` Content-Encoding).
 */
export function encryptWebPushPayload(payloadText, subscriptionKeys) {
  const uaPublic = Buffer.from(normalizeBase64Url(subscriptionKeys.p256dh), 'base64url');
  const authSecret = Buffer.from(normalizeBase64Url(subscriptionKeys.auth), 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid push subscription p256dh key (expected 65-byte uncompressed P-256 key).');
  }
  if (authSecret.length !== 16) {
    throw new Error('Invalid push subscription auth secret (expected 16 bytes).');
  }

  const senderEcdh = createECDH('prime256v1');
  senderEcdh.generateKeys();
  const asPublic = senderEcdh.getPublicKey();
  const ecdhSecret = senderEcdh.computeSecret(uaPublic);
  const salt = randomBytes(16);

  // RFC 8291 Section 3.3: IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, L=32)
  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic, Buffer.from([0x01])]);
  const ikm = hmacSha256(prkKey, keyInfo);

  // RFC 8291 Section 3.4 & RFC 8188: derive 16-byte CEK and 12-byte NONCE
  const prk = hmacSha256(salt, ikm);
  const cek = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 16);
  const nonce = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 12);

  // RFC 8188 single final record: plaintext || 0x02
  const plaintext = Buffer.from(String(payloadText), 'utf8');
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // 86-byte aes128gcm binary header: salt(16) || rs(4, BE=4096) || idlen(1, 65) || keyid(65)
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, encrypted]);
}

/**
 * Decrypts an RFC 8291 `aes128gcm` body (used in automated unit & E2E tests to prove exact browser compatibility).
 */
export function decryptWebPushPayload(bodyBuffer, receiverEcdh, authSecretBuffer) {
  const buf = Buffer.from(bodyBuffer);
  const salt = buf.subarray(0, 16);
  const idLen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idLen);
  const ciphertextAndTag = buf.subarray(21 + idLen);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

  const uaPublic = receiverEcdh.getPublicKey();
  const ecdhSecret = receiverEcdh.computeSecret(asPublic);

  const prkKey = hmacSha256(authSecretBuffer, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic, Buffer.from([0x01])]);
  const ikm = hmacSha256(prkKey, keyInfo);

  const prk = hmacSha256(salt, ikm);
  const cek = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 16);
  const nonce = hmacSha256(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'ascii'), Buffer.from([0x01])])).subarray(0, 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end--;
  if (end < 0 || padded[end] !== 0x02) throw new Error('Invalid RFC 8188 record delimiter');
  return padded.subarray(0, end).toString('utf8');
}

/**
 * Creates the Web Push manager bound to the SQLite CRM context.
 */
export function createWebPushManager({ ctx, fetchImpl = globalThis.fetch }) {
  const vapid = loadOrCreateVapidKeys(ctx.paths.baseDir);

  function saveSubscription({ ownerId, subscription, deviceLabel = '', deviceKind = 'phone', userAgent = '' }) {
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = normalizeBase64Url(subscription?.keys?.p256dh);
    const auth = normalizeBase64Url(subscription?.keys?.auth);
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
      const err = new Error('Valid push endpoint URL is required.');
      err.status = 400;
      throw err;
    }
    if (!p256dh || !auth) {
      const err = new Error('Push encryption keys (p256dh + auth) are required.');
      err.status = 400;
      throw err;
    }
    const now = new Date().toISOString();
    const id = randomBytes(12).toString('hex');
    ctx.db
      .prepare(
        `INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, device_label, device_kind, user_agent, created_at, updated_at, fail_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(endpoint) DO UPDATE SET
           owner_id = excluded.owner_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           device_label = excluded.device_label,
           device_kind = excluded.device_kind,
           user_agent = excluded.user_agent,
           updated_at = excluded.updated_at,
           fail_count = 0`
      )
      .run(
        id,
        ownerId,
        endpoint,
        p256dh,
        auth,
        String(deviceLabel || 'Owner Device').slice(0, 120),
        String(deviceKind || 'phone').slice(0, 32),
        String(userAgent || '').slice(0, 240),
        now,
        now
      );

    return listSubscriptions(ownerId);
  }

  function removeSubscription({ ownerId, endpoint, id }) {
    if (endpoint) {
      ctx.db.prepare('DELETE FROM push_subscriptions WHERE owner_id = ? AND endpoint = ?').run(ownerId, String(endpoint));
    } else if (id) {
      ctx.db.prepare('DELETE FROM push_subscriptions WHERE owner_id = ? AND id = ?').run(ownerId, String(id));
    }
    return listSubscriptions(ownerId);
  }

  function listSubscriptions(ownerId = null) {
    const rows = ownerId
      ? ctx.db.prepare('SELECT id, owner_id, endpoint, device_label, device_kind, created_at, last_sent_at, fail_count FROM push_subscriptions WHERE owner_id = ? ORDER BY updated_at DESC').all(ownerId)
      : ctx.db.prepare('SELECT * FROM push_subscriptions ORDER BY updated_at DESC').all();
    return rows;
  }

  async function sendPushToOwner(ownerId, payloadObj) {
    const subs = ownerId
      ? ctx.db.prepare('SELECT * FROM push_subscriptions WHERE owner_id = ?').all(ownerId)
      : ctx.db.prepare('SELECT * FROM push_subscriptions').all();
    if (!subs.length) return { sent: 0, failed: 0, total: 0 };

    const payloadJson = JSON.stringify(payloadObj);
    let sent = 0;
    let failed = 0;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          const body = encryptWebPushPayload(payloadJson, { p256dh: sub.p256dh, auth: sub.auth });
          const { authorization } = buildVapidAuthHeader(sub.endpoint, vapid);
          const res = await fetchImpl(sub.endpoint, {
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

          if (res.status === 404 || res.status === 410) {
            ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            failed++;
            return;
          }
          if (!res.ok) {
            ctx.db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id);
            failed++;
            return;
          }
          ctx.db.prepare('UPDATE push_subscriptions SET last_sent_at = ?, fail_count = 0 WHERE id = ?').run(new Date().toISOString(), sub.id);
          sent++;
        } catch {
          ctx.db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id);
          failed++;
        }
      })
    );

    return { sent, failed, total: subs.length };
  }

  return {
    publicKey: vapid.publicKey,
    saveSubscription,
    removeSubscription,
    listSubscriptions,
    sendPushToOwner
  };
}
