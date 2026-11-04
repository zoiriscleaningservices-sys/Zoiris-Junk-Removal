/**
 * server/storage.mjs
 * Private customer media storage abstraction + OWASP file upload security.
 *
 * Supported backends via `STORAGE_PROVIDER`:
 *  - `local`    : Private filesystem vault outside web root (`.zoiris-private/media/`)
 *  - `supabase` : Supabase Storage private bucket (`customer-media`) via service-role REST API
 *  - `r2`       : Cloudflare R2 / S3-compatible private bucket via AWS Signature V4
 *
 * Security controls (OWASP File Upload Cheat Sheet):
 *  1. Strict filename extension allowlist.
 *  2. Strict binary magic-byte signature inspection (never trusts browser MIME).
 *  3. Explicit block of executable/script/archive headers (`MZ`, `ELF`, `<?php`, `<svg`, `<html`, `<script`, `PK`).
 *  4. Random UUID storage paths outside public web root (`<YYYY>/<MM>/<leadId>/<uuid>.<ext>`).
 *  5. Separate EXIF-stripped WebP thumbnail generation via `sharp` while keeping original evidence intact.
 *  6. Authenticated owner-only HMAC-signed short-TTL retrieval with HTTP Range support for video streaming.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.mp4',
  '.mov',
  '.webm'
]);

const FORBIDDEN_SIGNATURES = [
  { label: 'Windows PE executable', check: (b) => b[0] === 0x4d && b[1] === 0x5a }, // MZ
  { label: 'ELF binary', check: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  { label: 'ZIP/Office archive', check: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  { label: 'Shell script', check: (b) => b[0] === 0x23 && b[1] === 0x21 }, // #!
  {
    label: 'HTML/SVG/Script markup',
    check: (b) => {
      const head = b.subarray(0, Math.min(256, b.length)).toString('utf8').trimStart().toLowerCase();
      return (
        head.startsWith('<!doctype') ||
        head.startsWith('<html') ||
        head.startsWith('<script') ||
        head.startsWith('<svg') ||
        head.startsWith('<?xml') ||
        head.startsWith('<?php')
      );
    }
  }
];

export function sanitizeOriginalFilename(rawName = 'upload') {
  const base = String(rawName)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .trim();
  return (base || 'upload').slice(0, 140);
}

export function inspectMediaBuffer(buffer, rawFilename = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return { ok: false, status: 415, error: 'File is empty or truncated.' };
  }

  for (const rule of FORBIDDEN_SIGNATURES) {
    if (rule.check(buffer)) {
      return { ok: false, status: 415, error: `Rejected unsafe file content (${rule.label}).` };
    }
  }

  const safeName = sanitizeOriginalFilename(rawFilename);
  const ext = extname(safeName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported file extension "${ext || 'none'}". Allowed: JPG, PNG, WebP, HEIC, MP4, MOV, WebM.`
    };
  }

  const sig = detectBinarySignature(buffer);
  if (!sig) {
    return {
      ok: false,
      status: 415,
      error: 'File binary signature did not match any supported photo or video format.'
    };
  }

  return {
    ok: true,
    safeFilename: safeName,
    originalFilename: String(rawFilename || safeName).slice(0, 180),
    mime: sig.mime,
    ext: sig.ext,
    kind: sig.kind,
    byteSize: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex')
  };
}

export function detectBinarySignature(buf) {
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'photo' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png', kind: 'photo' };
  }
  // WebP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'photo' };
  }
  // ISO Base Media File Format (ftyp box at offset 4)
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) {
      return { mime: 'image/heic', ext: 'heic', kind: 'photo' };
    }
    if (brand === 'qt  ') {
      return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    }
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'mp4v', 'dash'].includes(brand)) {
      return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    }
  }
  // Classic QuickTime MOV without ftyp (moov / wide / free / mdat atom)
  const atom = buf.subarray(4, 8).toString('ascii');
  if (['moov', 'wide', 'mdat'].includes(atom) && buf[0] === 0x00) {
    return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
  }
  // WebM: EBML header 1A 45 DF A3 containing 'webm' doctype in first 64 bytes
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const headerSlice = buf.subarray(0, Math.min(96, buf.length)).toString('ascii').toLowerCase();
    if (headerSlice.includes('webm')) {
      return { mime: 'video/webm', ext: 'webm', kind: 'video' };
    }
  }
  return null;
}

export async function generateSafePhotoPreview(buffer, mime) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default || sharpMod;
    const img = sharp(buffer, { failOn: 'error', limitInputPixels: 6400 * 6400 });
    const meta = await img.metadata();
    const previewBuffer = await img
      .rotate() // auto-orient & strip EXIF metadata by default
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      previewBuffer,
      width: meta.width || null,
      height: meta.height || null
    };
  } catch {
    return null;
  }
}

export function buildStorageKey(leadId, ext, prefix = '') {
  const now = new Date();
  const yr = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const cleanPrefix = prefix ? `${prefix}/` : '';
  return `${cleanPrefix}${yr}/${mo}/${leadId}/${randomUUID()}.${ext}`;
}

export function createStorageProvider({ paths, providerName = process.env.STORAGE_PROVIDER || 'local' }) {
  const provider = providerName.toLowerCase();
  const bucket = process.env.STORAGE_BUCKET || 'customer-media';

  if (provider === 'supabase') {
    return createSupabaseStorageAdapter({ bucket });
  }
  if (provider === 'r2') {
    return createR2StorageAdapter({ bucket });
  }
  return createLocalVaultAdapter({ paths, bucket });
}

function createLocalVaultAdapter({ paths, bucket }) {
  function resolveSafe(rootDir, key) {
    const clean = String(key).replace(/^[/\\]+/, '').replace(/\.\./g, '');
    const target = resolve(rootDir, clean);
    if (!target.startsWith(resolve(rootDir))) {
      throw new Error('Invalid storage path traversal attempt blocked.');
    }
    return target;
  }

  return {
    name: 'local',
    bucket,
    async putOriginal(key, buffer) {
      const target = resolveSafe(paths.originalsDir, key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer, { mode: 0o600 });
      return { key, byteSize: buffer.length };
    },
    async putPreview(key, buffer) {
      const target = resolveSafe(paths.previewsDir, key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer, { mode: 0o600 });
      return { key, byteSize: buffer.length };
    },
    async statObject(key, kind = 'original') {
      const dir = kind === 'preview' ? paths.previewsDir : paths.originalsDir;
      const target = resolveSafe(dir, key);
      if (!existsSync(target)) return null;
      const st = statSync(target);
      return { size: st.size, path: target };
    },
    createReadStream(key, kind = 'original', range = null) {
      const dir = kind === 'preview' ? paths.previewsDir : paths.originalsDir;
      const target = resolveSafe(dir, key);
      if (!existsSync(target)) return null;
      return range ? createReadStream(target, { start: range.start, end: range.end }) : createReadStream(target);
    },
    async deleteObject(key, previewKey = null) {
      for (const [dir, k] of [
        [paths.originalsDir, key],
        [paths.previewsDir, previewKey]
      ]) {
        if (!k) continue;
        const target = resolveSafe(dir, k);
        if (existsSync(target)) {
          unlinkSync(target);
          pruneEmptyParents(dirname(target), resolve(dir));
        }
      }
    },
    sweepOrphans(activeOriginalKeys = new Set(), activePreviewKeys = new Set()) {
      let filesDeleted = 0;
      let bytesFreed = 0;
      let dirsRemoved = 0;

      const sweepRoot = (rootDir, keepSet) => {
        if (!existsSync(rootDir)) return;
        const absRoot = resolve(rootDir);
        const walk = (currDir) => {
          for (const entry of readdirSync(currDir, { withFileTypes: true })) {
            const full = join(currDir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
              try {
                if (readdirSync(full).length === 0) {
                  rmdirSync(full);
                  dirsRemoved++;
                }
              } catch {
                // ignore concurrent fs changes
              }
            } else if (entry.isFile()) {
              const relKey = full.slice(absRoot.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
              if (!keepSet || !keepSet.has(relKey)) {
                try {
                  const sz = statSync(full).size;
                  unlinkSync(full);
                  filesDeleted++;
                  bytesFreed += sz;
                } catch {
                  // ignore concurrent unlink
                }
              }
            }
          }
        };
        walk(absRoot);
      };

      sweepRoot(paths.originalsDir, activeOriginalKeys);
      sweepRoot(paths.previewsDir, activePreviewKeys);
      sweepRoot(paths.tempDir, null);

      return { filesDeleted, bytesFreed, dirsRemoved };
    },
    totalDiskBytes() {
      return sumDirBytes(paths.originalsDir) + sumDirBytes(paths.previewsDir) + sumDirBytes(paths.tempDir);
    }
  };
}

function pruneEmptyParents(startDir, stopRoot) {
  let curr = resolve(startDir);
  const root = resolve(stopRoot);
  while (curr.length > root.length && curr.startsWith(root)) {
    try {
      if (!existsSync(curr) || readdirSync(curr).length > 0) break;
      rmdirSync(curr);
      curr = dirname(curr);
    } catch {
      break;
    }
  }
}

function sumDirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += sumDirBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function createSupabaseStorageAdapter({ bucket }) {
  const baseUrl = (process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  async function uploadToPath(fullKey, buffer, contentType) {
    const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${fullKey}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'false'
      },
      body: buffer
    });
    if (!res.ok) throw new Error(`Supabase Storage upload failed: HTTP ${res.status}`);
    return { key: fullKey, byteSize: buffer.length };
  }

  return {
    name: 'supabase',
    bucket,
    putOriginal: (key, buffer, mime) => uploadToPath(`originals/${key}`, buffer, mime),
    putPreview: (key, buffer) => uploadToPath(`previews/${key}`, buffer, 'image/webp'),
    async statObject() {
      return null;
    },
    async fetchBuffer(key, kind = 'original') {
      const prefix = kind === 'preview' ? 'previews/' : 'originals/';
      const res = await fetch(`${baseUrl}/storage/v1/object/authenticated/${bucket}/${prefix}${key}`, {
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
    async deleteObject(key, previewKey = null) {
      const prefixes = [`originals/${key}`];
      if (previewKey) prefixes.push(`previews/${previewKey}`);
      await fetch(`${baseUrl}/storage/v1/object/${bucket}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes })
      });
    },
    sweepOrphans: () => ({ filesDeleted: 0, bytesFreed: 0, dirsRemoved: 0 }),
    totalDiskBytes: () => 0
  };
}

function createR2StorageAdapter({ bucket }) {
  const endpoint = (process.env.R2_ENDPOINT || '').replace(/\/+$/, '');
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const region = 'auto';

  function awsSignV4(method, objectKey, payloadBuffer, contentType = 'application/octet-stream') {
    const url = new URL(`${endpoint}/${bucket}/${objectKey}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(payloadBuffer).digest('hex');
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

    const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      url: url.toString(),
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
      }
    };
  }

  async function putObj(prefix, key, buffer, mime) {
    const signed = awsSignV4('PUT', `${prefix}/${key}`, buffer, mime);
    const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: buffer });
    if (!res.ok) throw new Error(`Cloudflare R2 upload failed: HTTP ${res.status}`);
    return { key, byteSize: buffer.length };
  }

  return {
    name: 'r2',
    bucket,
    putOriginal: (key, buffer, mime) => putObj('originals', key, buffer, mime),
    putPreview: (key, buffer) => putObj('previews', key, buffer, 'image/webp'),
    async statObject() {
      return null;
    },
    async fetchBuffer(key, kind = 'original') {
      const prefix = kind === 'preview' ? 'previews' : 'originals';
      const signed = awsSignV4('GET', `${prefix}/${key}`, Buffer.alloc(0));
      const res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
    async deleteObject(key, previewKey = null) {
      for (const [p, k] of [
        ['originals', key],
        ['previews', previewKey]
      ]) {
        if (!k) continue;
        const signed = awsSignV4('DELETE', `${p}/${k}`, Buffer.alloc(0));
        await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
      }
    },
    sweepOrphans: () => ({ filesDeleted: 0, bytesFreed: 0, dirsRemoved: 0 }),
    totalDiskBytes: () => 0
  };
}
