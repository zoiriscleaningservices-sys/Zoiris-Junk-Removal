/**
 * server/cloud-relay.mjs
 * End-to-End Encrypted 24/7 Cloud Relay & Push Bridge (RSA-OAEP-2048 SHA-256 + AES-256-GCM).
 *
 * Allows the static GitHub Pages website (`https://zoiriscleaningservices-sys.github.io/Zoiris-Junk-Removal/`)
 * to accept verified pickup requests + compressed customer photos 24/7 with ZERO secrets in source code:
 *  - Public website encrypts customer PII + photos using ONLY the owner's RSA-OAEP Public Key (`spki`).
 *  - Push notification headers contain NO customer PII (only reference number, city, category, and photo count).
 *  - Both the Owner's Phone Vault (`local-vault.js`) AND the Node CRM Server (`server/index.mjs`) decrypt
 *    incoming sealed envelopes using the private key stored strictly in `.zoiris-private/relay-keypair.json`.
 */
import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeB64(str) {
  const s = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

/**
 * Encrypts a JSON-serializable object with AES-256-GCM and wraps the 256-bit key with RSA-OAEP-SHA256.
 * Matches WebCrypto `crypto.subtle` byte-for-byte (`ct` = `ciphertext || 16-byte GCM authTag`).
 */
export function encryptSealedEnvelope(payloadObj, publicKeySpkiB64) {
  const spkiDer = Buffer.from(normalizeB64(publicKeySpkiB64), 'base64');
  const pubKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const ctWithTag = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const wrappedKey = publicEncrypt(
    {
      key: pubKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    aesKey
  );

  return {
    v: 1,
    alg: 'RSA-OAEP-256+A256GCM',
    ek: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    ct: ctWithTag.toString('base64')
  };
}

/**
 * Decrypts an `RSA-OAEP-256+A256GCM` sealed envelope using the owner's PKCS#8 private key.
 */
export function decryptSealedEnvelope(envelope, privateKeyPkcs8B64Url) {
  if (!envelope || envelope.v !== 1 || !envelope.ek || !envelope.iv || !envelope.ct) {
    throw new Error('Malformed encrypted relay envelope.');
  }
  const pkcs8Der = Buffer.from(normalizeB64(privateKeyPkcs8B64Url), 'base64');
  const privKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const aesKey = privateDecrypt(
    {
      key: privKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(normalizeB64(envelope.ek), 'base64')
  );

  const iv = Buffer.from(normalizeB64(envelope.iv), 'base64');
  const ctWithTag = Buffer.from(normalizeB64(envelope.ct), 'base64');
  if (ctWithTag.length < 17) throw new Error('Ciphertext too short.');
  const ciphertext = ctWithTag.subarray(0, ctWithTag.length - 16);
  const authTag = ctWithTag.subarray(ctWithTag.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plainBuf.toString('utf8'));
}

export function loadRelayKeyConfig(vaultBaseDir) {
  const file = join(vaultBaseDir, 'relay-keypair.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.topic && parsed?.privateKeyPkcs8B64Url) {
        return {
          relayUrl: String(parsed.relayUrl || process.env.ZOIRIS_RELAY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
          topic: String(parsed.topic),
          publicKeySpkiB64: String(parsed.publicKeySpkiB64 || ''),
          privateKeyPkcs8B64Url: String(parsed.privateKeyPkcs8B64Url)
        };
      }
    } catch {
      // fall through to env
    }
  }
  if (process.env.ZOIRIS_RELAY_TOPIC && process.env.ZOIRIS_RELAY_PRIVATE_KEY) {
    return {
      relayUrl: String(process.env.ZOIRIS_RELAY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
      topic: String(process.env.ZOIRIS_RELAY_TOPIC).trim(),
      publicKeySpkiB64: String(process.env.ZOIRIS_RELAY_PUBLIC_KEY || '').trim(),
      privateKeyPkcs8B64Url: String(process.env.ZOIRIS_RELAY_PRIVATE_KEY).trim()
    };
  }
  return null;
}

export function createCloudRelaySync({ ctx, crm, fetchImpl = globalThis.fetch, autoPoll = false }) {
  const cfg = loadRelayKeyConfig(ctx.paths.baseDir);
  let lastSyncAt = null;
  let importedCount = 0;
  let syncing = false;
  let timer = null;

  function getSyncedSet() {
    const s = ctx.getSettings();
    const list = Array.isArray(s.synced_relay_ids) ? s.synced_relay_ids : [];
    return new Set(list);
  }

  function saveSyncedSet(set) {
    const arr = [...set].slice(-400);
    ctx.setSetting('synced_relay_ids', arr, null);
  }

  async function syncNow() {
    if (!cfg || syncing) return { ok: Boolean(cfg), imported: 0 };
    syncing = true;
    let imported = 0;
    try {
      const pollUrl = `${cfg.relayUrl}/${encodeURIComponent(cfg.topic)}/json?poll=1`;
      const res = await fetchImpl(pollUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, imported: 0, status: res.status };
      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const seen = getSyncedSet();
      let dirty = false;

      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!msg?.id || msg.event !== 'message') continue;
        if (seen.has(msg.id)) continue;

        let rawEnvelopeText = '';
        if (msg.attachment?.url) {
          try {
            const attRes = await fetchImpl(msg.attachment.url, { signal: AbortSignal.timeout(12000) });
            if (attRes.ok) rawEnvelopeText = await attRes.text();
          } catch {
            continue; // retry on next poll if transient download glitch
          }
        } else if (typeof msg.message === 'string' && msg.message.trim().startsWith('{')) {
          rawEnvelopeText = msg.message.trim();
        } else {
          // Plain non-envelope notification (e.g., test push alert)
          seen.add(msg.id);
          dirty = true;
          continue;
        }

        let envelope;
        try {
          envelope = JSON.parse(rawEnvelopeText);
        } catch {
          seen.add(msg.id);
          dirty = true;
          continue;
        }
        if (envelope?.v !== 1 || !envelope?.ct) {
          seen.add(msg.id);
          dirty = true;
          continue;
        }

        try {
          const decrypted = decryptSealedEnvelope(envelope, cfg.privateKeyPkcs8B64Url);
          const inquiry = decrypted.inquiry || decrypted;
          const mediaItems = Array.isArray(decrypted.media) ? decrypted.media : [];
          const created = await crm.submitCustomerInquiry(
            {
              ...inquiry,
              expectedFiles: mediaItems.length,
              consentGiven: true
            },
            {
              ip: 'github-pages-relay',
              userAgent: inquiry.userAgent || 'GitHubPagesRelay/1.0',
              idempotencyKey: inquiry.idempotencyKey || `relay-${msg.id}`,
              preferredLeadNumber: decrypted.leadNumber || inquiry.leadNumber || '',
              preVerifiedGeo: decrypted.verifiedGeo || null
            }
          );

          if (!created.deduplicated && created.uploadToken && mediaItems.length) {
            for (const item of mediaItems) {
              if (!item?.dataB64) continue;
              const buf = Buffer.from(normalizeB64(item.dataB64), 'base64');
              await crm.uploadCustomerMedia({
                uploadToken: created.uploadToken,
                buffer: buf,
                filename: item.filename || 'pickup-photo.jpg',
                reqMeta: { ip: 'github-pages-relay' }
              });
            }
            crm.completeUploadSession(created.uploadToken);
          }

          imported++;
          importedCount++;
          seen.add(msg.id);
          dirty = true;
        } catch {
          // Mark invalid/spam/duplicate envelope seen so it never loops endlessly
          seen.add(msg.id);
          dirty = true;
        }
      }

      if (dirty) saveSyncedSet(seen);
      lastSyncAt = new Date().toISOString();
      return { ok: true, imported };
    } catch {
      return { ok: false, imported };
    } finally {
      syncing = false;
    }
  }

  async function sendTestRelayAlert({ clickUrl = 'https://www.zoirisjunkremoval.com/owner/command-center/' } = {}) {
    if (!cfg) {
      const err = new Error('24/7 Cloud Push Relay is not configured in .zoiris-private/relay-keypair.json.');
      err.status = 400;
      throw err;
    }
    const qs = new URLSearchParams({
      title: 'Zoiris Lock-Screen Test Alert',
      message: 'Your 24/7 background phone notifications are active! Tap to open Zoiris Command Center.',
      priority: 'high',
      tags: 'white_check_mark,truck',
      click: clickUrl
    });
    const res = await fetchImpl(`${cfg.relayUrl}/${encodeURIComponent(cfg.topic)}?${qs.toString()}`, {
      method: 'POST',
      body: 'Zoiris background push test OK',
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      throw new Error(`Push relay returned HTTP ${res.status}`);
    }
    return { ok: true, topic: cfg.topic };
  }

  if (cfg && autoPoll) {
    setTimeout(() => {
      syncNow().catch(() => {});
    }, 1500).unref?.();
    timer = setInterval(() => {
      syncNow().catch(() => {});
    }, 20 * 1000);
    timer.unref?.();
  }

  return {
    configured: Boolean(cfg),
    status() {
      return {
        configured: Boolean(cfg),
        relayUrl: cfg?.relayUrl || '',
        topic: cfg?.topic || '',
        publicKeySpkiB64: cfg?.publicKeySpkiB64 || '',
        ntfySubscribeUrl: cfg ? `${cfg.relayUrl}/${cfg.topic}` : '',
        ntfyAppDeepLink: cfg ? `ntfy://${cfg.relayUrl.replace(/^https?:\/\//, '')}/${cfg.topic}` : '',
        pairingFragment: cfg ? `pair=${encodeURIComponent(cfg.privateKeyPkcs8B64Url)}&topic=${encodeURIComponent(cfg.topic)}` : '',
        lastSyncAt,
        importedCount
      };
    },
    syncNow,
    sendTestRelayAlert,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
