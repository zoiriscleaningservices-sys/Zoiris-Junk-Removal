#!/usr/bin/env node
/**
 * server/index.mjs
 * Zoiris Command Center + Private CRM + Media Vault + Analytics Backend Server.
 *
 * Keeps the Astro public website 100% static (`dist/`) while providing:
 *  - Public write-only inquiry, media upload, and privacy-safe event endpoints (`/api/public/*`)
 *  - Owner authentication, TOTP MFA, rate limiting, and CSRF-protected sessions (`/api/auth/*`)
 *  - Short-lived HMAC-signed private media streaming with HTTP Range support (`/api/media/stream/*`)
 *  - Owner-only CRM, Pipeline, Calendar, Analytics, Search Console, Location Coverage,
 *    SEO Draft Generator, Capacity Monitor, Backups, and Security APIs (`/api/owner/*`)
 *  - Private `ZOIRIS COMMAND CENTER` UI routes (`/owner/*`)
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openZoirisDb, ROOT_DIR } from './db.mjs';
import { loadOrInitMasterKey, verifyMediaAccess } from './crypto-totp.mjs';
import { clearSessionCookie, createAuthManager, serializeSessionCookie } from './auth.mjs';
import { createStorageProvider } from './storage.mjs';
import { createRealtimeAndNotifications } from './realtime.mjs';
import { createAnalyticsService } from './analytics.mjs';
import { createCrmService, csvEscape } from './crm.mjs';
import { createGeoService } from './geo.mjs';
import { deletePage, DIST_DIR, loadData, savePage } from '../scripts/lib/load-data.mjs';
import { candidateToRecord, proposeCandidates } from '../src/lib/matrix.ts';
import { auditSite } from '../src/lib/audit.ts';

const COMMAND_CENTER_DIR = join(ROOT_DIR, 'command-center');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

export function createZoirisApp({
  dataDir = process.env.ZOIRIS_DATA_DIR,
  servePublicDist = process.env.SERVE_PUBLIC_DIST !== '0'
} = {}) {
  const ctx = openZoirisDb(dataDir);
  const masterKey = loadOrInitMasterKey(ctx.paths.secretFile);
  const auth = createAuthManager({ ctx, masterKey });
  const storage = createStorageProvider({ paths: ctx.paths });
  const realtime = createRealtimeAndNotifications({ ctx });
  const analytics = createAnalyticsService({ ctx });
  const geo = createGeoService({ masterKey });
  const crm = createCrmService({ ctx, storage, realtime, masterKey, geo });

  const cleanupInterval = setInterval(() => {
    try {
      crm.cleanupExpiredUploadSessions();
      realtime.retryFailedNotifications().catch(() => {});
    } catch {
      // ignore background maintenance errors
    }
  }, 15 * 60 * 1000);
  cleanupInterval.unref?.();

  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, { ctx, masterKey, auth, storage, realtime, analytics, crm, geo, servePublicDist });
    } catch (err) {
      const status = Number(err.status) || 500;
      const exposeMessage = status < 500 || status === 503 || status === 507 || err.expose === true;
      const body = {
        ok: false,
        error: exposeMessage ? String(err.message || 'Request failed.') : 'A server error occurred while processing your request.',
        businessPhone: '251-930-8621'
      };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      if (!res.headersSent) {
        sendJson(res, status, body, req);
      }
    }
  });

  return {
    server,
    ctx,
    auth,
    storage,
    realtime,
    analytics,
    crm,
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(cleanupInterval);
        realtime.closeAll();
        server.close(() => {
          try {
            ctx.close();
          } catch {
            // ignore
          }
          resolveClose();
        });
      })
  };
}

async function routeRequest(req, res, deps) {
  const { ctx, masterKey, auth, storage, realtime, analytics, crm, geo, servePublicDist } = deps;
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  // CORS preflight for public static-to-API cross-port / cross-subdomain calls
  if (method === 'OPTIONS' && pathname.startsWith('/api/public/')) {
    applyPublicCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. PUBLIC CUSTOMER INQUIRY, UPLOAD & AGGREGATED TELEMETRY ENDPOINTS    */
  /* ---------------------------------------------------------------------- */
  if (pathname.startsWith('/api/public/')) {
    applyPublicCors(req, res);

    if (pathname === '/api/public/upload-config' && method === 'GET') {
      return sendJson(res, 200, { ok: true, limits: crm.publicUploadLimits() }, req);
    }

    if (pathname === '/api/public/inquiries' && method === 'POST') {
      const body = await readJsonBody(req, 256 * 1024);
      const result = await crm.submitCustomerInquiry(body, {
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || '',
        idempotencyKey: req.headers['x-idempotency-key'] || ''
      });
      return sendJson(res, 201, result, req);
    }

    if (pathname === '/api/public/uploads' && method === 'POST') {
      const settings = ctx.getSettings();
      const maxUpload = Math.max(Number(settings.max_video_bytes || 100 * 1024 * 1024), Number(settings.max_photo_bytes || 15 * 1024 * 1024)) + 2 * 1024 * 1024;
      const { uploadToken, filename, buffer } = await readUploadPayload(req, maxUpload);
      const result = await crm.uploadCustomerMedia({
        uploadToken,
        buffer,
        filename,
        reqMeta: { ip: clientIp(req) }
      });
      return sendJson(res, 201, result, req);
    }

    if (pathname === '/api/public/uploads/complete' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      const token = body.uploadToken || req.headers['x-upload-token'] || '';
      return sendJson(res, 200, crm.completeUploadSession(token), req);
    }

    if (pathname === '/api/public/events' && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const result = analytics.recordWebEvent(body, req.headers['user-agent'] || '');
      return sendJson(res, 202, result, req);
    }

    if (
      (pathname === '/api/public/address/suggest' || pathname === '/api/public/address/verify' || pathname === '/api/public/address/reverse') &&
      method === 'POST'
    ) {
      if (!checkAddressRate(clientIp(req), pathname.endsWith('suggest') ? 150 : 40)) {
        return sendJson(res, 429, { ok: false, error: 'Too many address lookups. Please wait a minute or call 251-930-8621.' }, req);
      }
      const body = await readJsonBody(req, 8 * 1024);
      if (pathname.endsWith('suggest')) {
        return sendJson(res, 200, await geo.suggest(body.q || ''), req);
      }
      if (pathname.endsWith('reverse')) {
        return sendJson(res, 200, await geo.reverse(body.lat, body.lng), req);
      }
      const result = await geo.verify({ line: body.line, city: body.city, state: body.state, zip: body.zip });
      return sendJson(res, 200, { ok: true, ...result }, req);
    }

    // Explicitly block any attempt to read CRM tables through /api/public/*
    return sendJson(
      res,
      403,
      { ok: false, error: 'Forbidden: Public API endpoints never grant read access to CRM or customer records.' },
      req
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 2. PRIVATE SIGNED MEDIA STREAMING (Short-lived HMAC + Range support)   */
  /* ---------------------------------------------------------------------- */
  if (pathname.startsWith('/api/media/stream/')) {
    applyPrivateHeaders(res);
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req);
    }
    const attachmentId = decodeURIComponent(pathname.slice('/api/media/stream/'.length)).replace(/\/+$/, '');
    const kind = url.searchParams.get('kind') === 'preview' ? 'preview' : 'original';
    const disposition = url.searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
    const exp = url.searchParams.get('exp') || '';
    const sig = url.searchParams.get('sig') || '';

    if (!verifyMediaAccess({ attachmentId, kind, disposition, expiresAtUnix: exp, signature: sig }, masterKey)) {
      return sendJson(res, 403, { ok: false, error: 'Media access link is invalid or expired.' }, req);
    }

    const att = ctx.db.prepare('SELECT * FROM lead_attachments WHERE id = ?').get(attachmentId);
    if (!att || att.deletion_status !== 'active') {
      return sendJson(res, 404, { ok: false, error: 'Media record not found.' }, req);
    }

    const usePreview = kind === 'preview' && !!att.preview_key;
    const key = usePreview ? att.preview_key : att.storage_key;
    const mime = usePreview ? 'image/webp' : att.validated_mime;

    if (storage.name === 'local') {
      const st = await storage.statObject(key, usePreview ? 'preview' : 'original');
      if (!st) return sendJson(res, 404, { ok: false, error: 'Media file missing from vault.' }, req);

      const totalSize = st.size;
      const dispHeader =
        disposition === 'attachment'
          ? `attachment; filename="${att.safe_filename.replace(/"/g, '')}"`
          : `inline; filename="${att.safe_filename.replace(/"/g, '')}"`;

      const rangeHeader = req.headers.range;
      if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
        const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
        let start = startStr ? parseInt(startStr, 10) : 0;
        let end = endStr ? parseInt(endStr, 10) : totalSize - 1;
        if (start >= totalSize || end >= totalSize || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }
        const chunkLen = end - start + 1;
        trackEgress(ctx, chunkLen);
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': chunkLen,
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': dispHeader,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"
        });
        if (method === 'HEAD') return res.end();
        storage.createReadStream(key, usePreview ? 'preview' : 'original', { start, end }).pipe(res);
        return;
      }

      trackEgress(ctx, totalSize);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': dispHeader,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"
      });
      if (method === 'HEAD') return res.end();
      storage.createReadStream(key, usePreview ? 'preview' : 'original').pipe(res);
      return;
    }

    // Cloud storage adapters (Supabase / Cloudflare R2)
    const buf = await storage.fetchBuffer(key, usePreview ? 'preview' : 'original');
    if (!buf) return sendJson(res, 404, { ok: false, error: 'Media object not found.' }, req);
    trackEgress(ctx, buf.length);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Content-Disposition': `${disposition}; filename="${att.safe_filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store'
    });
    res.end(method === 'HEAD' ? undefined : buf);
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* 3. OWNER AUTHENTICATION ENDPOINTS (/api/auth/*)                        */
  /* ---------------------------------------------------------------------- */
  if (pathname.startsWith('/api/auth/')) {
    applyPrivateHeaders(res);
    const isSecure = Boolean(req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https');

    if (pathname === '/api/auth/status' && method === 'GET') {
      const session = auth.authenticateRequest(req, { requireCsrf: false });
      if (session?.rawToken) {
        res.setHeader('Set-Cookie', serializeSessionCookie(session.rawToken, session.idleSeconds, isSecure));
      }
      const count = auth.ownerCount();
      return sendJson(res, 200, {
        ok: true,
        authenticated: !!session,
        needsInitialSetup: count === 0,
        setupSecretConfigured: !!(process.env.OWNER_SETUP_SECRET && process.env.OWNER_SETUP_SECRET.length >= 16),
        owner: session?.owner || null,
        sessionId: session?.sessionId || null,
        currentDevice: session?.deviceLabel || null,
        deviceKind: session?.deviceKind || null,
        rememberDevice: session ? !!session.rememberDevice : true,
        activeDeviceCount: session?.activeDeviceCount || 0,
        csrfToken: session?.csrfToken || null,
        expiresAt: session?.expiresAt || null
      });
    }

    if (pathname === '/api/auth/setup' && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const owner = auth.provisionFirstOwner({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        setupSecret: body.setupSecret,
        allowCliBypass: false
      });
      const loginRes = auth.login({
        email: body.email,
        password: body.password,
        rememberDevice: body.rememberDevice !== false,
        deviceHint: body.deviceHint || null,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || ''
      });
      res.setHeader('Set-Cookie', serializeSessionCookie(loginRes.session.rawToken, loginRes.session.idleSeconds, isSecure));
      return sendJson(res, 201, {
        ok: true,
        owner,
        sessionId: loginRes.session.sessionId,
        currentDevice: loginRes.session.deviceLabel,
        deviceKind: loginRes.session.deviceKind,
        rememberDevice: loginRes.session.rememberDevice,
        activeDeviceCount: loginRes.session.activeDeviceCount,
        csrfToken: loginRes.session.csrfToken,
        expiresAt: loginRes.session.expiresAt
      });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const loginRes = auth.login({
        email: body.email,
        password: body.password,
        totp: body.totp,
        recoveryCode: body.recoveryCode,
        rememberDevice: body.rememberDevice !== false,
        deviceHint: body.deviceHint || null,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || ''
      });
      if (loginRes.mfaRequired) {
        return sendJson(res, 200, { ok: true, mfaRequired: true });
      }
      res.setHeader('Set-Cookie', serializeSessionCookie(loginRes.session.rawToken, loginRes.session.idleSeconds, isSecure));
      try {
        await realtime.notifyOwners({
          kind: 'security',
          title: `Signed in from ${loginRes.session.deviceLabel}`,
          body: `Owner dashboard session started (${loginRes.session.rememberDevice ? 'stays signed in 30 days' : 'temporary session'}).`,
          metadata: { sessionId: loginRes.session.sessionId, device: loginRes.session.deviceLabel }
        });
      } catch {
        // non-blocking sign-in notification
      }
      return sendJson(res, 200, {
        ok: true,
        mfaRequired: false,
        owner: loginRes.owner,
        sessionId: loginRes.session.sessionId,
        currentDevice: loginRes.session.deviceLabel,
        deviceKind: loginRes.session.deviceKind,
        rememberDevice: loginRes.session.rememberDevice,
        activeDeviceCount: loginRes.session.activeDeviceCount,
        csrfToken: loginRes.session.csrfToken,
        expiresAt: loginRes.session.expiresAt
      });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const session = auth.authenticateRequest(req, { requireCsrf: true });
      if (session) auth.logout(session.sessionId, session.owner);
      res.setHeader('Set-Cookie', clearSessionCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/recovery/request' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      const issued = auth.issueRecoveryToken(body.email);
      // If email provider is configured, send recovery token to owner's email; never return token in HTTP response!
      if (issued && process.env.EMAIL_PROVIDER_API_KEY) {
        await realtime.notifyOwners({
          kind: 'security',
          title: 'Zoiris Owner Account Recovery Token',
          body: `Your 15-minute account recovery token is: ${issued.token}`
        });
      }
      return sendJson(res, 200, {
        ok: true,
        message:
          'If an active owner account matches that email and an email provider is configured, a 15-minute recovery token has been sent. You can also generate a recovery token on the server via `npm run owner:provision -- --recover <email>`.'
      });
    }

    if (pathname === '/api/auth/recovery/complete' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      auth.completePasswordRecovery({ token: body.token, newPassword: body.newPassword });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'Auth endpoint not found.' });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. PROTECTED OWNER COMMAND CENTER API (/api/owner/*)                   */
  /* ---------------------------------------------------------------------- */
  if (pathname.startsWith('/api/owner/')) {
    applyPrivateHeaders(res);
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const session = auth.authenticateRequest(req, { requireCsrf: mutating });
    if (!session) {
      return sendJson(res, 401, { ok: false, error: 'Authentication required to access Zoiris Command Center.' });
    }
    const { owner } = session;

    if (pathname === '/api/owner/realtime' && method === 'GET') {
      realtime.addSseClient(res, owner);
      return;
    }

    if (pathname === '/api/owner/overview' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...crm.getDashboardOverview() });
    }

    if (pathname === '/api/owner/leads' && method === 'GET') {
      const result = crm.listLeads({
        q: url.searchParams.get('q') || '',
        status: url.searchParams.get('status') || '',
        priority: url.searchParams.get('priority') || '',
        unreadOnly: url.searchParams.get('unread') === '1',
        city: url.searchParams.get('city') || '',
        service: url.searchParams.get('service') || '',
        dateFrom: url.searchParams.get('from') || '',
        dateTo: url.searchParams.get('to') || '',
        includeArchived: url.searchParams.get('archived') === '1',
        sort: url.searchParams.get('sort') || 'newest',
        page: Number(url.searchParams.get('page') || 1),
        pageSize: Number(url.searchParams.get('pageSize') || 25)
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/owner/pipeline' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...crm.getPipelineBoard() });
    }

    const leadStatusMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/status$/);
    if (leadStatusMatch && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const detail = crm.updateLeadStatus({
        leadId: decodeURIComponent(leadStatusMatch[1]),
        newStatus: body.status,
        note: body.note || '',
        owner
      });
      return sendJson(res, 200, { ok: true, ...detail });
    }

    const leadNotesMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/notes$/);
    if (leadNotesMatch && method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      const detail = crm.addLeadNote({
        leadId: decodeURIComponent(leadNotesMatch[1]),
        noteType: body.noteType || 'internal_note',
        body: body.body || '',
        owner
      });
      return sendJson(res, 201, { ok: true, ...detail });
    }

    const leadFollowMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/follow-ups$/);
    if (leadFollowMatch && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const created = crm.createFollowUpTask({
        leadId: decodeURIComponent(leadFollowMatch[1]),
        title: body.title,
        dueDate: body.dueDate,
        notes: body.notes || '',
        owner
      });
      return sendJson(res, 201, { ok: true, task: created, detail: crm.getLeadDetail(created.leadId, owner, { markOpened: false }) });
    }

    const leadExportMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/export$/);
    if (leadExportMatch && method === 'GET') {
      const detail = crm.exportSingleLeadJson(decodeURIComponent(leadExportMatch[1]), owner);
      const fmt = url.searchParams.get('format') || 'json';
      if (fmt === 'csv') {
        const l = detail.lead;
        const csv =
          'lead_number,status,priority,created_at,full_name,phone,email,pickup_address,city,state,zip_code,requested_service,estimated_quantity,item_description,photo_count,video_count,estimate_dollars,scheduled_pickup_at\n' +
          [
            l.leadNumber,
            l.status,
            l.priority,
            l.createdAt,
            l.fullName,
            l.phone,
            l.email || '',
            l.pickupAddress,
            l.city,
            l.state,
            l.zipCode,
            l.requestedService,
            l.estimatedQuantity || '',
            l.itemDescription || '',
            l.photoCount,
            l.videoCount,
            l.estimateCents !== null ? (l.estimateCents / 100).toFixed(2) : '',
            l.scheduledPickupAt || ''
          ]
            .map(csvEscape)
            .join(',') +
          '\n';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${l.leadNumber}.csv"`
        });
        res.end(csv);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${detail.lead.leadNumber}.json"`
      });
      res.end(JSON.stringify(detail, null, 2));
      return;
    }

    if (pathname === '/api/owner/leads/bulk-delete' && method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      const resDel = await crm.bulkDeleteLeads({
        leadIds: Array.isArray(body.leadIds) ? body.leadIds : [],
        statuses: Array.isArray(body.statuses) ? body.statuses : [],
        all: body.all === true,
        owner
      });
      return sendJson(res, 200, resDel);
    }

    const leadMediaDeleteMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/media$/);
    if (leadMediaDeleteMatch && method === 'DELETE') {
      const resDel = await crm.deleteAllLeadMedia(decodeURIComponent(leadMediaDeleteMatch[1]), owner);
      return sendJson(res, 200, resDel);
    }

    const leadDetailMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)$/);
    if (leadDetailMatch) {
      const id = decodeURIComponent(leadDetailMatch[1]);
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, ...crm.getLeadDetail(id, owner, { markOpened: true }) });
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req, 64 * 1024);
        return sendJson(res, 200, { ok: true, ...crm.updateLeadFields({ leadId: id, patch: body, owner }) });
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, await crm.deleteLead(id, owner));
      }
    }

    const noteItemMatch = pathname.match(/^\/api\/owner\/notes\/([^/]+)$/);
    if (noteItemMatch && method === 'DELETE') {
      return sendJson(res, 200, crm.deleteLeadNote(decodeURIComponent(noteItemMatch[1]), owner));
    }

    const followTaskMatch = pathname.match(/^\/api\/owner\/follow-ups\/([^/]+)$/);
    if (followTaskMatch) {
      const tid = decodeURIComponent(followTaskMatch[1]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req, 16 * 1024);
        return sendJson(res, 200, crm.updateFollowUpTask({ taskId: tid, status: body.status, owner }));
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, crm.deleteFollowUpTask(tid, owner));
      }
    }

    if (pathname === '/api/owner/map/pins' && method === 'GET') {
      return sendJson(res, 200, { ok: true, pins: crm.listMapPins({ includeClosed: url.searchParams.get('all') === '1' }) });
    }

    if (pathname === '/api/owner/media' && method === 'GET') {
      const rows = ctx.db
        .prepare(
          `SELECT a.*, l.lead_number, l.full_name, l.city
           FROM lead_attachments a
           JOIN leads l ON l.id = a.lead_id
           WHERE a.deletion_status = 'active'
           ORDER BY a.created_at DESC
           LIMIT 100`
        )
        .all()
        .map((a) => ({
          id: a.id,
          leadId: a.lead_id,
          leadNumber: a.lead_number,
          customerName: a.full_name,
          city: a.city,
          mediaKind: a.media_kind,
          safeFilename: a.safe_filename,
          validatedMime: a.validated_mime,
          byteSize: a.byte_size,
          createdAt: a.created_at,
          previewUrl: crm.mintSignedMediaUrl(a.id, { kind: a.preview_key ? 'preview' : 'original', disposition: 'inline' }),
          streamUrl: crm.mintSignedMediaUrl(a.id, { kind: 'original', disposition: 'inline' }),
          downloadUrl: crm.mintSignedMediaUrl(a.id, { kind: 'original', disposition: 'attachment' })
        }));
      return sendJson(res, 200, { ok: true, attachments: rows, capacity: crm.getCapacityStatus() });
    }

    const mediaSignMatch = pathname.match(/^\/api\/owner\/media\/([^/]+)\/sign$/);
    if (mediaSignMatch && method === 'POST') {
      const body = await readJsonBody(req, 8 * 1024);
      const id = decodeURIComponent(mediaSignMatch[1]);
      const signedUrl = crm.mintSignedMediaUrl(id, {
        kind: body.kind === 'preview' ? 'preview' : 'original',
        disposition: body.disposition === 'attachment' ? 'attachment' : 'inline',
        ttlSeconds: body.ttlSeconds ?? null
      });
      return sendJson(res, 200, { ok: true, signedUrl });
    }

    if (pathname === '/api/owner/media/bulk-delete' && method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      const resDel = await crm.bulkDeleteMedia({
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
        filter: body.filter || '',
        owner
      });
      return sendJson(res, 200, resDel);
    }

    const mediaDeleteMatch = pathname.match(/^\/api\/owner\/media\/([^/]+)$/);
    if (mediaDeleteMatch && method === 'DELETE') {
      const resDel = await crm.deleteLeadAttachment(decodeURIComponent(mediaDeleteMatch[1]), owner);
      return sendJson(res, 200, resDel);
    }

    if (pathname === '/api/owner/customers' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ...crm.listCustomers({
          q: url.searchParams.get('q') || '',
          page: Number(url.searchParams.get('page') || 1),
          pageSize: Number(url.searchParams.get('pageSize') || 30)
        })
      });
    }

    if (pathname === '/api/owner/customers/merge' && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const merged = crm.mergeCustomers({
        targetCustomerId: body.targetCustomerId,
        sourceCustomerId: body.sourceCustomerId,
        confirmed: body.confirmed === true,
        owner
      });
      return sendJson(res, 200, { ok: true, ...merged });
    }

    const customerRedactMatch = pathname.match(/^\/api\/owner\/customers\/([^/]+)\/redact$/);
    if (customerRedactMatch && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      return sendJson(res, 200, await crm.deleteCustomerPii({ customerId: decodeURIComponent(customerRedactMatch[1]), confirmed: body.confirmed === true, owner }));
    }

    const customerDetailMatch = pathname.match(/^\/api\/owner\/customers\/([^/]+)$/);
    if (customerDetailMatch) {
      const cid = decodeURIComponent(customerDetailMatch[1]);
      if (method === 'GET') return sendJson(res, 200, { ok: true, ...crm.getCustomerDetail(cid) });
      if (method === 'PATCH') {
        const body = await readJsonBody(req, 32 * 1024);
        return sendJson(res, 200, { ok: true, ...crm.updateCustomerRecord({ customerId: cid, patch: body, owner }) });
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, await crm.deleteCustomer({ customerId: cid, confirmed: true, owner }));
      }
    }

    if (pathname === '/api/owner/calendar') {
      if (method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          timezone: 'America/Chicago',
          appointments: crm.listAppointments({
            fromDate: url.searchParams.get('from') || '',
            toDate: url.searchParams.get('to') || '',
            status: url.searchParams.get('status') || ''
          })
        });
      }
      if (method === 'POST') {
        const body = await readJsonBody(req, 32 * 1024);
        const appt = crm.createAppointment({
          leadId: body.leadId,
          scheduledDate: body.scheduledDate,
          timeWindow: body.timeWindow,
          instructions: body.instructions || '',
          title: body.title || '',
          owner
        });
        return sendJson(res, 201, { ok: true, appointment: appt });
      }
    }

    const apptMatch = pathname.match(/^\/api\/owner\/calendar\/([^/]+)$/);
    if (apptMatch) {
      const aid = decodeURIComponent(apptMatch[1]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req, 32 * 1024);
        const appt = crm.updateAppointment({
          appointmentId: aid,
          patch: body,
          owner
        });
        return sendJson(res, 200, { ok: true, appointment: appt });
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, crm.deleteAppointment(aid, owner));
      }
    }

    if (pathname === '/api/owner/analytics' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ...analytics.getAnalyticsReport({
          range: url.searchParams.get('range') || '30d',
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
          includeTestData: url.searchParams.get('includeTestData') === '1'
        })
      });
    }

    if (pathname === '/api/owner/analytics/realtime' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...analytics.getRealtimeTraffic() });
    }

    if (pathname === '/api/owner/search-performance' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ...analytics.getSearchPerformance({
          range: url.searchParams.get('range') || '30d',
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
          includeTestData: url.searchParams.get('includeTestData') === '1'
        }),
        locationPerformance: analytics.getLocationPerformance({
          includeTestData: url.searchParams.get('includeTestData') === '1'
        })
      });
    }

    if (pathname === '/api/owner/search-performance/import-csv' && method === 'POST') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const resImp = analytics.importGscCsv({
        csvText: body.csvText,
        snapshotDate: body.snapshotDate,
        dimensionKind: body.dimensionKind || 'query',
        isTestData: !!body.isTestData
      });
      ctx.logAudit({
        actorId: owner.id,
        actorEmail: owner.email,
        action: 'gsc.csv_imported',
        entityType: 'analytics_snapshots',
        metadata: resImp
      });
      return sendJson(res, 201, { ok: true, ...resImp });
    }

    if (pathname === '/api/owner/search-performance/sync' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      const synced = await analytics.syncSearchConsoleApi({ fromDate: body.fromDate, toDate: body.toDate });
      return sendJson(res, 200, { ok: true, ...synced });
    }

    if (pathname === '/api/owner/locations' && method === 'GET') {
      if (process.env.ZOIRIS_SYNC_JSON !== '0') ctx.syncContentToDb();
      const counties = ctx.db.prepare('SELECT * FROM counties ORDER BY name ASC').all();
      const municipalities = ctx.db
        .prepare('SELECT * FROM municipalities ORDER BY county_id ASC, name ASC')
        .all()
        .map((m) => ({ ...m, zipCodes: JSON.parse(m.zip_codes_json || '[]') }));
      const neighborhoods = ctx.db
        .prepare('SELECT * FROM neighborhoods ORDER BY municipality_id ASC, name ASC')
        .all()
        .map((n) => ({
          ...n,
          zipCodes: JSON.parse(n.zip_codes_json || '[]'),
          localEvidence: JSON.parse(n.local_evidence_json || '[]')
        }));
      const performance = analytics.getLocationPerformance();
      return sendJson(res, 200, { ok: true, counties, municipalities, neighborhoods, performance });
    }

    if (pathname === '/api/owner/locations/coverage' && method === 'PATCH') {
      const body = await readJsonBody(req, 32 * 1024);
      ctx.updateCoverage({
        entityKind: body.entityKind,
        id: body.id,
        coverageStatus: body.coverageStatus,
        pickupNotes: body.pickupNotes,
        owner
      });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/seo-pages' && method === 'GET') {
      const data = loadData();
      if (process.env.ZOIRIS_SYNC_JSON === '0') {
        const muniCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM municipalities').all().map((r) => [r.id, r.coverage_status]));
        const nbCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM neighborhoods').all().map((r) => [r.id, r.coverage_status]));
        for (const l of data.locations) if (muniCov.has(l.id)) l.coverage = muniCov.get(l.id);
        for (const n of data.neighborhoods) if (nbCov.has(n.id)) n.coverage = nbCov.get(n.id);
      }
      const audit = auditSite(data);
      const knownIds = new Set(data.pages.map((p) => p.id));
      const extraRegistryRows =
        process.env.ZOIRIS_SYNC_JSON === '0'
          ? ctx.db
              .prepare('SELECT * FROM page_registry ORDER BY updated_at DESC')
              .all()
              .filter((r) => !knownIds.has(r.id))
              .map((r) => ({
                id: r.id,
                type: r.page_type,
                path: r.path,
                status: r.status,
                title: r.title,
                primaryKeyword: r.primary_keyword,
                refs: { serviceId: r.service_id, locationId: r.location_id, neighborhoodId: r.neighborhood_id, countyId: r.county_id },
                score: r.quality_score,
                passesGate: !!r.passes_gate,
                blockers: ['Draft created in isolated session']
              }))
          : [];
      const pagesList = [
        ...extraRegistryRows,
        ...data.pages.map((p) => ({
          id: p.id,
          type: p.type,
          path: p.path,
          status: p.status,
          title: p.seo.title,
          primaryKeyword: p.seo.primaryKeyword,
          refs: p.refs,
          score: audit.reports[p.id]?.score ?? 0,
          passesGate: !!audit.reports[p.id]?.passesGate,
          blockers: audit.reports[p.id]?.blockers ?? []
        }))
      ];
      return sendJson(res, 200, {
        ok: true,
        counts: {
          ...audit.counts,
          total: audit.counts.total + extraRegistryRows.length,
          draft: (audit.counts.draft || 0) + extraRegistryRows.length
        },
        services: data.services,
        items: data.items,
        locations: data.locations,
        neighborhoods: data.neighborhoods,
        pages: pagesList
      });
    }

    if (pathname === '/api/owner/seo-pages/propose' && method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      const data = loadData();
      if (process.env.ZOIRIS_SYNC_JSON === '0') {
        const muniCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM municipalities').all().map((r) => [r.id, r.coverage_status]));
        const nbCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM neighborhoods').all().map((r) => [r.id, r.coverage_status]));
        for (const l of data.locations) if (muniCov.has(l.id)) l.coverage = muniCov.get(l.id);
        for (const n of data.neighborhoods) if (nbCov.has(n.id)) n.coverage = nbCov.get(n.id);
      }
      const candidates = proposeCandidates(data, {
        serviceIds: body.serviceIds || [],
        itemIds: body.itemIds || [],
        locationIds: body.locationIds || [],
        neighborhoodIds: body.neighborhoodIds || [],
        customerTypes: body.customerTypes || []
      });
      return sendJson(res, 200, { ok: true, candidates });
    }

    if (pathname === '/api/owner/seo-pages/create-draft' && method === 'POST') {
      const body = await readJsonBody(req, 64 * 1024);
      const data = loadData();
      if (process.env.ZOIRIS_SYNC_JSON === '0') {
        const muniCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM municipalities').all().map((r) => [r.id, r.coverage_status]));
        const nbCov = new Map(ctx.db.prepare('SELECT id, coverage_status FROM neighborhoods').all().map((r) => [r.id, r.coverage_status]));
        for (const l of data.locations) if (muniCov.has(l.id)) l.coverage = muniCov.get(l.id);
        for (const n of data.neighborhoods) if (nbCov.has(n.id)) n.coverage = nbCov.get(n.id);
      }
      const candidates = proposeCandidates(data, {
        serviceIds: body.serviceId ? [body.serviceId] : [],
        itemIds: body.itemId ? [body.itemId] : [],
        locationIds: body.locationId ? [body.locationId] : [],
        neighborhoodIds: body.neighborhoodId ? [body.neighborhoodId] : [],
        customerTypes: body.customerType ? [body.customerType] : []
      });
      const match = candidates[0];
      if (!match) {
        return sendJson(res, 400, { ok: false, error: 'Invalid service/location combination.' });
      }
      if (match.recommendation === 'exists' || match.recommendation === 'covered-by-existing') {
        return sendJson(res, 409, { ok: false, error: match.reasons.join(' '), existingPageId: match.existingPageId });
      }
      const today = new Date().toISOString().slice(0, 10);
      const record = candidateToRecord(match, today);
      record.status = 'draft'; // Always create in draft status — never auto-publish!
      record.seo.robotsIndex = false;
      if (process.env.ZOIRIS_SYNC_JSON !== '0') {
        savePage(record);
        ctx.syncContentToDb();
      } else {
        ctx.db
          .prepare(
            `INSERT OR REPLACE INTO page_registry (
               id, page_type, path, status, title, primary_keyword, service_id, location_id, neighborhood_id, county_id, robots_index, quality_score, passes_gate, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`
          )
          .run(
            record.id,
            record.type,
            record.path,
            record.status,
            record.seo.title,
            record.seo.primaryKeyword || '',
            record.refs?.serviceId || null,
            record.refs?.locationId || null,
            record.refs?.neighborhoodId || null,
            record.refs?.countyId || null,
            new Date().toISOString()
          );
      }
      ctx.logAudit({
        actorId: owner.id,
        actorEmail: owner.email,
        action: 'seo.draft_created',
        entityType: 'page_record',
        entityId: record.id,
        metadata: { path: record.path, status: record.status }
      });
      return sendJson(res, 201, { ok: true, record });
    }

    if (pathname === '/api/owner/analytics/events' && method === 'DELETE') {
      const deleted = Number(ctx.db.prepare('DELETE FROM web_events').run()?.changes || 0);
      ctx.logAudit({ actorId: owner.id, actorEmail: owner.email, action: 'analytics.events_cleared', entityType: 'web_events', metadata: { deleted } });
      ctx.compactDatabase();
      return sendJson(res, 200, { ok: true, deleted });
    }

    if (pathname === '/api/owner/search-performance/snapshots' && method === 'DELETE') {
      const deleted = Number(ctx.db.prepare('DELETE FROM analytics_snapshots').run()?.changes || 0);
      ctx.logAudit({ actorId: owner.id, actorEmail: owner.email, action: 'gsc.snapshots_cleared', entityType: 'analytics_snapshots', metadata: { deleted } });
      ctx.compactDatabase();
      return sendJson(res, 200, { ok: true, deleted });
    }

    const seoDraftDelMatch = pathname.match(/^\/api\/owner\/seo-pages\/([^/]+)$/);
    if (seoDraftDelMatch && method === 'DELETE') {
      const pid = decodeURIComponent(seoDraftDelMatch[1]);
      if (pid === 'propose' || pid === 'create-draft' || pid === 'rebuild') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
      }
      const data = loadData();
      const filePage = data.pages.find((p) => p.id === pid);
      const regRow = ctx.db.prepare('SELECT * FROM page_registry WHERE id = ?').get(pid);
      const status = filePage?.status || regRow?.status || '';
      if (!filePage && !regRow) {
        return sendJson(res, 404, { ok: false, error: 'Page record not found.' });
      }
      if (!['draft', 'idea', 'research'].includes(status)) {
        return sendJson(res, 400, { ok: false, error: 'Only draft, idea, or research pages can be deleted directly. Unpublish live pages first.' });
      }
      if (process.env.ZOIRIS_SYNC_JSON !== '0' && filePage) {
        deletePage(pid);
        ctx.syncContentToDb();
      }
      ctx.db.prepare('DELETE FROM page_registry WHERE id = ?').run(pid);
      ctx.logAudit({ actorId: owner.id, actorEmail: owner.email, action: 'seo.draft_deleted', entityType: 'page_record', entityId: pid });
      ctx.checkpointDatabase();
      return sendJson(res, 200, { ok: true, deletedId: pid });
    }

    if (pathname === '/api/owner/seo-pages/rebuild' && method === 'POST') {
      const result = await runStaticBuild();
      ctx.logAudit({
        actorId: owner.id,
        actorEmail: owner.email,
        action: 'seo.static_site_rebuilt',
        entityType: 'build',
        metadata: { code: result.code }
      });
      return sendJson(res, result.code === 0 ? 200 : 500, { ok: result.code === 0, ...result });
    }

    if (pathname === '/api/owner/exports/leads.csv' && method === 'GET') {
      ctx.logAudit({ actorId: owner.id, actorEmail: owner.email, action: 'leads.csv_exported', entityType: 'export' });
      const csv = crm.exportLeadsCsv();
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="zoiris-leads-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      res.end(csv);
      return;
    }

    if (pathname === '/api/owner/exports/analytics.csv' && method === 'GET') {
      const rep = analytics.getAnalyticsReport({ range: url.searchParams.get('range') || '30d' });
      const lines = ['page_path,page_views,sessions,phone_clicks,form_starts,crm_leads,qualified_leads'];
      for (const p of rep.topPages) {
        lines.push([p.pagePath, p.pageViews, p.sessions, p.phoneClicks, p.formStarts, p.crmLeads, p.qualifiedLeads].map(csvEscape).join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="zoiris-page-performance-${rep.window.fromDate}-to-${rep.window.toDate}.csv"`
      });
      res.end(lines.join('\n') + '\n');
      return;
    }

    if (pathname === '/api/owner/notifications') {
      if (method === 'GET') {
        const items = ctx.db
          .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 60')
          .all();
        const prefs =
          ctx.db.prepare('SELECT * FROM notification_preferences WHERE owner_id = ?').get(owner.id) || {
            in_app_enabled: 1,
            sound_enabled: 0,
            desktop_enabled: 0,
            email_enabled: 0,
            email_address: owner.email,
            sms_enabled: 0,
            sms_phone: ''
          };
        return sendJson(res, 200, { ok: true, notifications: items, preferences: prefs });
      }
      if (method === 'DELETE') {
        const deleted = Number(ctx.db.prepare('DELETE FROM notifications').run()?.changes || 0);
        ctx.checkpointDatabase();
        return sendJson(res, 200, { ok: true, deleted });
      }
    }

    const notifItemMatch = pathname.match(/^\/api\/owner\/notifications\/([a-f0-9-]{8,})$/i);
    if (notifItemMatch && method === 'DELETE') {
      const nid = decodeURIComponent(notifItemMatch[1]);
      ctx.db.prepare('DELETE FROM notifications WHERE id = ?').run(nid);
      ctx.checkpointDatabase();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/notifications/read-all' && method === 'POST') {
      ctx.db.prepare("UPDATE notifications SET is_read = 1, delivery_status = CASE WHEN channel = 'in_app' THEN 'read' ELSE delivery_status END, updated_at = ? WHERE is_read = 0").run(
        new Date().toISOString()
      );
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/notifications/retry' && method === 'POST') {
      const results = await realtime.retryFailedNotifications();
      return sendJson(res, 200, { ok: true, retried: results.length, results });
    }

    if (pathname === '/api/owner/notification-preferences' && method === 'PUT') {
      const b = await readJsonBody(req, 16 * 1024);
      const now = new Date().toISOString();
      ctx.db
        .prepare(
          `INSERT INTO notification_preferences (
            owner_id, in_app_enabled, sound_enabled, desktop_enabled, email_enabled, email_address,
            sms_enabled, sms_phone, notify_new_lead, notify_new_upload, notify_storage_alert, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id) DO UPDATE SET
            in_app_enabled = excluded.in_app_enabled,
            sound_enabled = excluded.sound_enabled,
            desktop_enabled = excluded.desktop_enabled,
            email_enabled = excluded.email_enabled,
            email_address = excluded.email_address,
            sms_enabled = excluded.sms_enabled,
            sms_phone = excluded.sms_phone,
            notify_new_lead = excluded.notify_new_lead,
            notify_new_upload = excluded.notify_new_upload,
            notify_storage_alert = excluded.notify_storage_alert,
            updated_at = excluded.updated_at`
        )
        .run(
          owner.id,
          b.inAppEnabled ? 1 : 0,
          b.soundEnabled ? 1 : 0,
          b.desktopEnabled ? 1 : 0,
          b.emailEnabled ? 1 : 0,
          String(b.emailAddress || owner.email).slice(0, 160),
          b.smsEnabled ? 1 : 0,
          String(b.smsPhone || '').slice(0, 30),
          b.notifyNewLead !== false ? 1 : 0,
          b.notifyNewUpload !== false ? 1 : 0,
          b.notifyStorageAlert !== false ? 1 : 0,
          now
        );
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/capacity' && method === 'GET') {
      const backups = existsSync(ctx.paths.backupsDir)
        ? readdirSync(ctx.paths.backupsDir)
            .filter((f) => f.endsWith('.sqlite'))
            .map((f) => {
              const st = statSync(join(ctx.paths.backupsDir, f));
              return { filename: f, byteSize: st.size, createdAt: st.mtime.toISOString() };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];
      return sendJson(res, 200, { ok: true, capacity: crm.getCapacityStatus(), backups });
    }

    if (pathname === '/api/owner/storage/cleanup' && method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const cleaned = await crm.cleanupStorage({
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
        owner
      });
      return sendJson(res, 200, cleaned);
    }

    if (pathname === '/api/owner/backups') {
      if (method === 'POST') {
        const created = crm.createDatabaseBackup(owner);
        return sendJson(res, 201, { ok: true, backup: created });
      }
      if (method === 'DELETE') {
        return sendJson(res, 200, crm.deleteAllBackups(owner));
      }
    }

    const backupDownloadMatch = pathname.match(/^\/api\/owner\/backups\/([a-zA-Z0-9._-]+)$/);
    if (backupDownloadMatch) {
      const fname = backupDownloadMatch[1];
      if (method === 'DELETE') {
        return sendJson(res, 200, crm.deleteBackup(fname, owner));
      }
      if (method === 'GET') {
        const full = resolve(ctx.paths.backupsDir, fname);
        if (!full.startsWith(resolve(ctx.paths.backupsDir)) || !existsSync(full)) {
          return sendJson(res, 404, { ok: false, error: 'Backup file not found.' });
        }
        const st = statSync(full);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `attachment; filename="${fname}"`
        });
        createReadStream(full).pipe(res);
        return;
      }
    }

    if (pathname === '/api/owner/settings') {
      if (method === 'GET') {
        const integrations = ctx.db.prepare('SELECT * FROM integrations ORDER BY id ASC').all().map((r) => ({
          ...r,
          configSummary: JSON.parse(r.config_summary_json || '{}')
        }));
        return sendJson(res, 200, { ok: true, settings: ctx.getSettings(), integrations });
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req, 32 * 1024);
        const editable = [
          ['max_photos', (v) => Math.max(1, Math.min(50, Number(v)))],
          ['max_videos', (v) => Math.max(0, Math.min(15, Number(v)))],
          ['max_photo_bytes', (v) => Math.max(1024 * 1024, Math.min(100 * 1024 * 1024, Number(v)))],
          ['max_video_bytes', (v) => Math.max(5 * 1024 * 1024, Math.min(1024 * 1024 * 1024, Number(v)))],
          ['preserve_original_uploads', (v) => !!v],
          ['storage_quota_bytes', (v) => Math.max(50 * 1024 * 1024, Number(v))],
          ['db_quota_bytes', (v) => Math.max(20 * 1024 * 1024, Number(v))],
          ['egress_quota_bytes', (v) => Math.max(100 * 1024 * 1024, Number(v))],
          ['quota_warn_70', (v) => Math.max(10, Math.min(99, Number(v)))],
          ['quota_warn_85', (v) => Math.max(15, Math.min(99, Number(v)))],
          ['quota_warn_95', (v) => Math.max(20, Math.min(100, Number(v)))],
          ['session_idle_minutes', (v) => Math.max(5, Math.min(43200, Number(v)))],
          ['signed_url_ttl_seconds', (v) => Math.max(30, Math.min(3600, Number(v)))]
        ];
        const updatedKeys = [];
        for (const [key, coerce] of editable) {
          if (body[key] !== undefined) {
            ctx.setSetting(key, coerce(body[key]), owner.id);
            updatedKeys.push(key);
          }
        }
        ctx.logAudit({
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'settings.updated',
          entityType: 'business_settings',
          metadata: { updatedKeys }
        });
        return sendJson(res, 200, { ok: true, settings: ctx.getSettings() });
      }
    }

    if (pathname === '/api/owner/security' && method === 'GET') {
      const sessions = auth.listActiveSessions(owner.id);
      const auditLogs = ctx.db
        .prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 100')
        .all()
        .map((a) => ({ ...a, metadata: JSON.parse(a.metadata_json || '{}') }));
      return sendJson(res, 200, {
        ok: true,
        owner,
        currentSessionId: session.sessionId,
        sessions,
        auditLogs
      });
    }

    if (pathname === '/api/owner/security/password' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      auth.changePassword(owner.id, body.currentPassword, body.newPassword, session.sessionId);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/security/mfa/begin' && method === 'POST') {
      return sendJson(res, 200, { ok: true, ...auth.beginMfaEnrollment(owner.id) });
    }

    if (pathname === '/api/owner/security/mfa/confirm' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      return sendJson(res, 200, { ok: true, ...auth.confirmMfaEnrollment(owner.id, body.code) });
    }

    if (pathname === '/api/owner/security/mfa/disable' && method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024);
      auth.disableMfa(owner.id, body.password);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/owner/security/revoke-sessions' && method === 'POST') {
      auth.revokeOtherSessions(owner.id, session.sessionId);
      return sendJson(res, 200, { ok: true });
    }

    const secSessMatch = pathname.match(/^\/api\/owner\/security\/sessions\/([^/]+)$/);
    if (secSessMatch && method === 'DELETE') {
      const targetId = decodeURIComponent(secSessMatch[1]);
      if (targetId === session.sessionId) {
        auth.logout(session.sessionId, owner);
        res.setHeader('Set-Cookie', clearSessionCookie());
        return sendJson(res, 200, { ok: true, signedOutCurrent: true });
      }
      return sendJson(res, 200, { signedOutCurrent: false, ...auth.revokeSessionById(owner.id, targetId, owner.email) });
    }

    if (pathname === '/api/owner/security/audit-logs' && method === 'DELETE') {
      const deleted = Number(ctx.db.prepare('DELETE FROM admin_audit_logs').run()?.changes || 0);
      ctx.db.prepare('DELETE FROM login_attempts').run();
      ctx.compactDatabase();
      return sendJson(res, 200, { ok: true, deleted });
    }

    return sendJson(res, 404, { ok: false, error: 'Owner API endpoint not found.' });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. PRIVATE ZOIRIS COMMAND CENTER WEB ROUTES (/owner/*)                 */
  /* ---------------------------------------------------------------------- */
  if (pathname === '/owner' || pathname.startsWith('/owner/')) {
    applyPrivateHeaders(res);

    // Serve static Command Center UI assets (/owner/assets/*)
    if (pathname.startsWith('/owner/assets/')) {
      const rel = normalize(pathname.slice('/owner/assets/'.length)).replace(/^[/\\]+/, '');
      const assetFile = resolve(COMMAND_CENTER_DIR, 'assets', rel);
      if (!assetFile.startsWith(resolve(COMMAND_CENTER_DIR, 'assets')) || !existsSync(assetFile)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': STATIC_MIME[extname(assetFile)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(readFileSync(assetFile));
      return;
    }

    const isLoginRoute = pathname === '/owner/login' || pathname === '/owner/login/';
    const session = auth.authenticateRequest(req, { requireCsrf: false });

    // Strict server-side route gate: unauthenticated access to any protected /owner/* route is blocked!
    if (!session && !isLoginRoute) {
      const acceptsHtml = String(req.headers.accept || '').includes('text/html');
      if (!acceptsHtml || req.headers['x-requested-with']) {
        return sendJson(res, 401, { ok: false, error: 'Authentication required.' });
      }
      const nextParam = encodeURIComponent(pathname + url.search);
      res.writeHead(302, { Location: `/owner/login/?next=${nextParam}` });
      res.end();
      return;
    }

    // Authenticated owner visiting /owner/ or /owner/login/ goes straight to /owner/command-center/
    if (session && (pathname === '/owner' || pathname === '/owner/' || isLoginRoute)) {
      res.writeHead(302, { Location: '/owner/command-center/' });
      res.end();
      return;
    }

    const shellPath = join(COMMAND_CENTER_DIR, isLoginRoute ? 'login.html' : 'app.html');
    if (!existsSync(shellPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Command Center UI shell missing.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, must-revalidate',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org https://basemap.nationalmap.gov; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'"
    });
    res.end(readFileSync(shellPath));
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* 6. OPTIONAL STATIC PUBLIC SITE SERVING (dist/) FOR UNIFIED PREVIEW     */
  /* ---------------------------------------------------------------------- */
  if ((pathname === '/favicon.svg' || pathname === '/favicon.ico') && method === 'GET') {
    const svgPath = join(ROOT_DIR, 'public', 'favicon.svg');
    if (existsSync(svgPath)) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(svgPath));
      return;
    }
  }

  if (servePublicDist && existsSync(DIST_DIR)) {
    let rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    let candidate = resolve(DIST_DIR, rel);
    if (!candidate.startsWith(resolve(DIST_DIR))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      candidate = join(candidate, 'index.html');
    }
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      res.writeHead(200, { 'Content-Type': STATIC_MIME[extname(candidate)] || 'application/octet-stream' });
      res.end(readFileSync(candidate));
      return;
    }
    const notFoundHtml = join(DIST_DIR, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(existsSync(notFoundHtml) ? readFileSync(notFoundHtml) : 'Not found');
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Route not found.' });
}

function applyPrivateHeaders(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function applyPublicCors(req, res) {
  const configuredOrigin = process.env.PUBLIC_SITE_URL || '';
  const reqOrigin = req.headers.origin || '';
  let allowOrigin = configuredOrigin || '*';
  if (
    reqOrigin &&
    (/^https?:\/\/(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(reqOrigin) ||
      /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(reqOrigin) ||
      reqOrigin === configuredOrigin)
  ) {
    allowOrigin = reqOrigin;
  }
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Idempotency-Key, X-Upload-Token, X-File-Name');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || '127.0.0.1';
}

const addressRateBuckets = new Map();
function checkAddressRate(ip, limit) {
  const now = Date.now();
  const key = `${limit}:${ip}`;
  const recent = (addressRateBuckets.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (recent.length >= limit) return false;
  recent.push(now);
  addressRateBuckets.set(key, recent);
  if (addressRateBuckets.size > 5000) addressRateBuckets.delete(addressRateBuckets.keys().next().value);
  return true;
}

function trackEgress(ctx, bytes) {
  try {
    const cur = Number(ctx.getSettings().monthly_egress_bytes || 0);
    ctx.setSetting('monthly_egress_bytes', cur + Number(bytes || 0), null);
  } catch {
    // ignore egress stat race
  }
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`Upload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const buf = await readRawBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('Malformed JSON payload.');
    err.status = 400;
    throw err;
  }
}

async function readUploadPayload(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '');
  const headerToken = String(req.headers['x-upload-token'] || '').trim();
  const headerFilename = req.headers['x-file-name'] ? decodeURIComponent(String(req.headers['x-file-name'])) : '';

  if (contentType.startsWith('multipart/form-data')) {
    const raw = await readRawBody(req, maxBytes);
    const webReq = new Request('http://zoiris.local/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: raw
    });
    const form = await webReq.formData();
    const file = form.get('file');
    const token = headerToken || String(form.get('uploadToken') || '').trim();
    if (!file || typeof file === 'string') {
      const err = new Error('Multipart upload missing `file` field.');
      err.status = 400;
      throw err;
    }
    const arrayBuf = await file.arrayBuffer();
    return {
      uploadToken: token,
      filename: file.name || headerFilename || 'upload.bin',
      buffer: Buffer.from(arrayBuf)
    };
  }

  const buffer = await readRawBody(req, maxBytes);
  return {
    uploadToken: headerToken,
    filename: headerFilename || 'upload.bin',
    buffer
  };
}

function runStaticBuild() {
  return new Promise((resolveBuild) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['run', 'build'], { cwd: ROOT_DIR, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => {
      resolveBuild({ code: code ?? 1, output: (stdout + '\n' + stderr).slice(-4000) });
    });
  });
}

function detectLanAddress() {
  try {
    const nets = networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const n of list || []) {
        if (n && n.family === 'IPv4' && !n.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) {
          return n.address;
        }
      }
    }
  } catch {}
  return '';
}

// Direct CLI execution
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.ZOIRIS_PORT || process.env.PORT || 4500);
  const host = process.env.ZOIRIS_HOST || '0.0.0.0';
  const app = createZoirisApp();
  app.server.listen(port, host, () => {
    const localHostLabel = host === '0.0.0.0' ? '127.0.0.1' : host;
    const lanIp = host === '0.0.0.0' ? detectLanAddress() : '';
    console.log(`\n  Zoiris Command Center & Private CRM Server`);
    console.log(`  → Public Static Site (if built): http://${localHostLabel}:${port}/`);
    console.log(`  → Private Owner Command Center:  http://${localHostLabel}:${port}/owner/command-center/`);
    if (lanIp) {
      console.log(`  → Sign in from Phone on Wi-Fi:   http://${lanIp}:${port}/owner/command-center/`);
    }
    console.log(`  → Private Vault Directory:       ${app.ctx.paths.baseDir}\n`);
  });
}
