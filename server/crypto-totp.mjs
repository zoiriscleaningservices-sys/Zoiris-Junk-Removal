/**
 * server/crypto-totp.mjs
 * Password hashing (scrypt), AES-256-GCM secret encryption at rest,
 * RFC 6238 TOTP MFA (HMAC-SHA1), recovery code hashing, and HMAC signed URL tokens.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function loadOrInitMasterKey(secretFile) {
  if (process.env.ZOIRIS_SERVER_SECRET && process.env.ZOIRIS_SERVER_SECRET.length >= 32) {
    return createHash('sha256').update(process.env.ZOIRIS_SERVER_SECRET).digest();
  }
  if (existsSync(secretFile)) {
    const hex = readFileSync(secretFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  }
  mkdirSync(dirname(secretFile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(secretFile, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr)
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function encryptSecret(plaintext, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

export function decryptSecret(payload, masterKey) {
  const [ivHex, tagHex, encHex] = String(payload || '').split('.');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

export function generateBase32Secret(byteLen = 20) {
  const bytes = randomBytes(byteLen);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(str) {
  const cleaned = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(base32Secret, timestampMs = Date.now(), stepSeconds = 30, digits = 6) {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = decodeBase32(base32Secret);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function verifyTotp(base32Secret, code, windowSteps = 1, nowMs = Date.now()) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidate = totpCode(base32Secret, nowMs + w * 30000);
    if (safeEqualStrings(candidate, clean)) return true;
  }
  return false;
}

export function buildOtpAuthUri({ email, secret, issuer = 'Zoiris Command Center' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 8) {
  const plain = [];
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const code = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
    plain.push(code);
    hashes.push(sha256Hex(code));
  }
  return { plain, hashes };
}

export function signMediaAccess({ attachmentId, kind = 'original', disposition = 'inline', expiresAtUnix }, masterKey) {
  const payload = `${attachmentId}:${kind}:${disposition}:${expiresAtUnix}`;
  return createHmac('sha256', masterKey).update(payload).digest('hex');
}

export function verifyMediaAccess({ attachmentId, kind = 'original', disposition = 'inline', expiresAtUnix, signature }, masterKey) {
  const exp = Number(expiresAtUnix);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = signMediaAccess({ attachmentId, kind, disposition, expiresAtUnix: exp }, masterKey);
  return safeEqualStrings(expected, String(signature || ''));
}
