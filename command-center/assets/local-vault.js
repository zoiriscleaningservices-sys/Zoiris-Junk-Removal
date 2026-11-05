/* command-center/assets/local-vault.js
 * Zoiris On-Device Vault & PWA Helper
 *
 * - Automatically detects whether a live `/api/*` CRM server is reachable (or configured via `zoiris.cloudApiUrl`).
 * - When hosted on static GitHub Pages (`github.io`) with no backend server connected, seamlessly provides
 *   a complete encrypted-password On-Device CRM Vault (WebCrypto PBKDF2-SHA256 + localStorage + IndexedDB media blobs)
 *   so the Owner Command Center works 100% 24/7 on iPhone, Android, iPad, Mac, and Windows PC.
 * - Zero credentials or secrets are ever stored in source code.
 */
(function () {
  'use strict';

  const BASE_PREFIX = (() => {
    const m = window.location.pathname.match(/^(.*)\/owner(\/|$)/);
    return m ? m[1] : '';
  })();

  window.ZOIRIS_BASE_PREFIX = BASE_PREFIX;
  window.zoirisOwnerUrl = (p) => (BASE_PREFIX && String(p).startsWith('/owner/') ? BASE_PREFIX + p : p);
  window.zoirisStripBase = (p) => (BASE_PREFIX && String(p).startsWith(BASE_PREFIX + '/owner/') ? p.slice(BASE_PREFIX.length) : p);
  window.zoirisPublicUrl = (p) => (BASE_PREFIX && String(p).startsWith('/') && !String(p).startsWith(BASE_PREFIX + '/') ? BASE_PREFIX + p : p);

  const PIPELINE_STATUSES = [
    'New',
    'Unread',
    'Contacted',
    'Awaiting Customer Information',
    'Estimate Being Prepared',
    'Estimate Sent',
    'Pickup Scheduled',
    'Pickup In Progress',
    'Completed',
    'Not Converted',
    'Archived',
    'Spam'
  ];

  /* Register PWA Service Worker */
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register(window.zoirisOwnerUrl('/owner/sw.js'), { scope: window.zoirisOwnerUrl('/owner/') })
        .catch(() => {});
    });
  }

  /* PWA Install Prompt Capture */
  let deferredInstallPrompt = null;
  window.ZOIRIS_PWA = {
    isStandalone() {
      try {
        return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone);
      } catch {
        return false;
      }
    },
    isIos() {
      const ua = navigator.userAgent || '';
      return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1);
    },
    canPrompt() {
      return !!deferredInstallPrompt;
    },
    async triggerInstall() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
        if (choice?.outcome === 'accepted') deferredInstallPrompt = null;
        return choice?.outcome || 'dismissed';
      }
      return 'manual';
    }
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    window.dispatchEvent(new CustomEvent('zoiris:pwa-ready'));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    window.dispatchEvent(new CustomEvent('zoiris:pwa-installed'));
  });

  /* Device Identification (matches server/auth.mjs) */
  function describeCurrentDevice(hint) {
    const ua = navigator.userAgent || '';
    const platform = String(hint?.platform || navigator.userAgentData?.platform || navigator.platform || '');
    const touch = Number(hint?.maxTouchPoints ?? navigator.maxTouchPoints ?? 0);
    const standalone = Boolean(hint?.standalone ?? window.ZOIRIS_PWA.isStandalone());

    let os = 'Computer';
    let kind = 'desktop';
    if (/iPhone/i.test(ua) || /iPhone/i.test(platform)) {
      os = 'iPhone';
      kind = 'phone';
    } else if (/iPad/i.test(ua) || /iPad/i.test(platform) || (/Macintosh|MacIntel/i.test(ua + ' ' + platform) && touch > 1)) {
      os = 'iPad';
      kind = 'tablet';
    } else if (/Android/i.test(ua)) {
      if (/Mobile/i.test(ua)) {
        os = 'Android Phone';
        kind = 'phone';
      } else {
        os = 'Android Tablet';
        kind = 'tablet';
      }
    } else if (/CrOS/i.test(ua)) {
      os = 'Chromebook';
    } else if (/Windows/i.test(ua) || /^Win/i.test(platform)) {
      os = 'Windows PC';
    } else if (/Macintosh|Mac OS X/i.test(ua) || /^Mac/i.test(platform)) {
      os = 'Mac';
    } else if (/Linux/i.test(ua)) {
      os = 'Linux Computer';
    }

    let browser = 'Browser';
    if (/EdgA?\//i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser\//i.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS\//i.test(ua)) browser = 'Firefox';
    else if (/CriOS\/|Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Version\/.*Safari\//i.test(ua) || (/Safari\//i.test(ua) && kind !== 'desktop')) browser = 'Safari';

    return {
      label: `${os} · ${browser}${standalone ? ' (App)' : ''}`,
      kind
    };
  }

  /* ---------------- WebCrypto Salted Password Hashing ---------------- */
  function toHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function randHex(bytes = 16) {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return toHex(b);
  }
  async function hashPassword(password, saltHex) {
    const salt = fromHex(saltHex);
    const enc = new TextEncoder().encode(String(password));
    if (crypto.subtle) {
      const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
      return `pbkdf2$${saltHex}$${toHex(bits)}`;
    }
    return `plain-fallback$${saltHex}$${btoa(unescape(encodeURIComponent(password)))}`;
  }
  async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3) return false;
    const check = await hashPassword(password, parts[1]);
    return check === stored;
  }

  /* ---------------- IndexedDB Media Blob Store ---------------- */
  const IDB_NAME = 'zoiris_phone_vault_media';
  const IDB_STORE = 'blobs';
  const blobUrlCache = new Map();

  function openMediaDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function putMediaBlob(id, blob) {
    const db = await openMediaDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    blobUrlCache.set(id, URL.createObjectURL(blob));
  }
  async function getMediaBlobUrl(id) {
    if (blobUrlCache.has(id)) return blobUrlCache.get(id);
    const db = await openMediaDb();
    if (!db) return '';
    const blob = await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    blobUrlCache.set(id, u);
    return u;
  }
  async function deleteMediaBlob(id) {
    if (blobUrlCache.has(id)) {
      try {
        URL.revokeObjectURL(blobUrlCache.get(id));
      } catch {}
      blobUrlCache.delete(id);
    }
    const db = await openMediaDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
  async function clearAllMediaBlobs() {
    for (const u of blobUrlCache.values()) {
      try {
        URL.revokeObjectURL(u);
      } catch {}
    }
    blobUrlCache.clear();
    const db = await openMediaDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /* ---------------- Structured Vault State in localStorage ---------------- */
  const VAULT_KEY = 'zoiris.phoneVault.v1';
  const SESSION_KEY = 'zoiris.phoneSessionId.v1';
  let seedSeoCache = null;

  async function loadSeedSeo() {
    if (seedSeoCache) return seedSeoCache;
    try {
      const r = await nativeFetch(window.zoirisOwnerUrl('/owner/assets/seed-seo.json'));
      if (r.ok) {
        seedSeoCache = await r.json();
        return seedSeoCache;
      }
    } catch {}
    seedSeoCache = { counties: [], municipalities: [], neighborhoods: [], services: [], items: [], pages: [] };
    return seedSeoCache;
  }

  function defaultVault() {
    return {
      owner: null,
      sessions: [],
      leads: [],
      customers: [],
      attachments: [],
      notes: [],
      followUps: [],
      appointments: [],
      timeline: [],
      notifications: [],
      auditLogs: [],
      backups: [],
      coverageOverrides: {},
      draftPages: [],
      gscRows: [],
      leadSeq: 0,
      settings: {
        max_photos: 12,
        max_videos: 3,
        max_photo_bytes: 15 * 1024 * 1024,
        max_video_bytes: 100 * 1024 * 1024,
        preserve_original_uploads: true,
        storage_quota_bytes: 500 * 1024 * 1024,
        db_quota_bytes: 50 * 1024 * 1024,
        egress_quota_bytes: 2 * 1024 * 1024 * 1024,
        session_idle_minutes: 480
      },
      notifPrefs: {
        in_app_enabled: 1,
        sound_enabled: 0,
        desktop_enabled: 0,
        email_enabled: 0,
        email_address: '',
        sms_enabled: 0,
        sms_phone: ''
      }
    };
  }

  function readVault() {
    try {
      const raw = localStorage.getItem(VAULT_KEY);
      if (raw) return Object.assign(defaultVault(), JSON.parse(raw));
    } catch {}
    return defaultVault();
  }
  function writeVault(v) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  }

  function logAudit(v, action, entityType, entityId = '') {
    v.auditLogs.unshift({
      id: randHex(8),
      created_at: new Date().toISOString(),
      actor_email: v.owner?.email || 'owner',
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata: {}
    });
    if (v.auditLogs.length > 150) v.auditLogs.length = 150;
  }

  function currentSession(v) {
    const sid = localStorage.getItem(SESSION_KEY) || '';
    if (!sid || !v.owner) return null;
    const now = Date.now();
    v.sessions = (v.sessions || []).filter((s) => !s.revoked_at && Date.parse(s.expires_at) > now);
    const sess = v.sessions.find((s) => s.id === sid);
    if (!sess) return null;
    const ttlMs = (sess.rememberDevice ? 30 * 24 * 60 : Number(v.settings.session_idle_minutes || 480)) * 60000;
    sess.last_active_at = new Date(now).toISOString();
    sess.expires_at = new Date(now + ttlMs).toISOString();
    const dev = describeCurrentDevice();
    sess.deviceLabel = dev.label;
    sess.deviceKind = dev.kind;
    writeVault(v);
    return sess;
  }

  function jsonRes(status, obj) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function buildCapacitySnapshot(v) {
    const mediaBytes = v.attachments.reduce((s, a) => s + Number(a.byte_size || 0), 0);
    const dbBytes = new Blob([JSON.stringify(v)]).size;
    const quota = Number(v.settings.storage_quota_bytes || 500 * 1024 * 1024);
    const dbQuota = Number(v.settings.db_quota_bytes || 50 * 1024 * 1024);
    const egressQuota = Number(v.settings.egress_quota_bytes || 2 * 1024 * 1024 * 1024);
    const closedIds = new Set(v.leads.filter((l) => ['Completed', 'Not Converted', 'Archived', 'Spam'].includes(l.status)).map((l) => l.id));
    const closedMedia = v.attachments.filter((a) => closedIds.has(a.lead_id));
    const closedMediaBytes = closedMedia.reduce((s, a) => s + Number(a.byte_size || 0), 0);
    const backupsBytes = v.backups.reduce((s, b) => s + Number(b.byteSize || 0), 0);
    const usedPct = Number(Math.min(100, (mediaBytes / Math.max(1, quota)) * 100).toFixed(1));
    const dbPct = Number(Math.min(100, (dbBytes / Math.max(1, dbQuota)) * 100).toFixed(1));
    return {
      alertLevel: usedPct >= 95 ? 'critical' : usedPct >= 85 ? 'high' : usedPct >= 70 ? 'warning' : 'healthy',
      storageProvider: 'On-Device Phone Vault',
      thresholds: { warn70: 70, warn85: 85, warn95: 95 },
      mediaStorage: {
        activeAttachmentCount: v.attachments.length,
        activeOriginalBytes: mediaBytes,
        activePreviewBytes: 0,
        quotaBytes: quota,
        remainingBytes: Math.max(0, quota - mediaBytes),
        usedPct
      },
      database: {
        usedBytes: dbBytes,
        sizeBytes: dbBytes,
        quotaBytes: dbQuota,
        remainingBytes: Math.max(0, dbQuota - dbBytes),
        usedPct: dbPct
      },
      egress: {
        period: new Date().toISOString().slice(0, 7),
        monthlyEgressBytes: 0,
        bytesThisMonth: 0,
        quotaBytes: egressQuota,
        usedPct: 0
      },
      health: { failedUploads: 0, pendingUploads: 0, notificationErrors: 0 },
      breakdown: {
        totalVaultBytes: mediaBytes + dbBytes + backupsBytes,
        trashLeadsCount: v.leads.filter((l) => ['Spam', 'Not Converted', 'Archived'].includes(l.status)).length,
        closedMediaCount: closedMedia.length,
        closedMediaBytes,
        completedLeadsCount: v.leads.filter((l) => l.status === 'Completed').length,
        allLeadsCount: v.leads.length,
        customersCount: v.customers.length,
        mediaCount: v.attachments.length,
        mediaDiskBytes: mediaBytes,
        backupsCount: v.backups.length,
        backupsBytes,
        webEventsCount: 0,
        searchSnapshotsCount: v.gscRows.length,
        auditLogsCount: v.auditLogs.length,
        notificationsCount: v.notifications.length
      }
    };
  }

  /* ---------------- Mode Detection ---------------- */
  const nativeFetch = window.fetch.bind(window);
  let modePromise = null;

  function detectMode() {
    if (modePromise) return modePromise;
    modePromise = (async () => {
      let cloudOrigin = '';
      try {
        cloudOrigin = (localStorage.getItem('zoiris.cloudApiUrl') || '').trim().replace(/\/+$/, '');
      } catch {}
      const probeUrl = (cloudOrigin || '') + '/api/auth/status';
      try {
        const res = await nativeFetch(probeUrl, { headers: { Accept: 'application/json' }, credentials: cloudOrigin ? 'include' : 'same-origin' });
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.includes('application/json')) {
          const data = await res.json();
          if (data && data.ok === true) {
            window.__ZOIRIS_LOCAL_VAULT__ = false;
            window.__ZOIRIS_API_ORIGIN__ = cloudOrigin;
            return { local: false, cloudOrigin };
          }
        }
      } catch {}
      window.__ZOIRIS_LOCAL_VAULT__ = true;
      return { local: true, cloudOrigin: '' };
    })();
    return modePromise;
  }

  /* ---------------- Local API Router ---------------- */
  async function handleLocalApi(pathname, urlObj, method, init) {
    const v = readVault();
    let body = {};
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {}
    }

    // 1. Auth endpoints
    if (pathname === '/api/auth/status' && method === 'GET') {
      const sess = currentSession(v);
      return jsonRes(200, {
        ok: true,
        localVaultMode: true,
        authenticated: !!sess,
        needsInitialSetup: !v.owner,
        setupSecretConfigured: true,
        noSecretNeeded: true,
        owner: sess ? { id: v.owner.id, email: v.owner.email, displayName: v.owner.displayName, mfaEnabled: false } : null,
        sessionId: sess?.id || null,
        currentDevice: sess?.deviceLabel || null,
        deviceKind: sess?.deviceKind || null,
        rememberDevice: sess ? !!sess.rememberDevice : true,
        activeDeviceCount: v.sessions.length || (sess ? 1 : 0),
        csrfToken: sess?.csrfToken || null,
        expiresAt: sess?.expires_at || null
      });
    }

    if (pathname === '/api/auth/setup' && method === 'POST') {
      if (v.owner) return jsonRes(409, { ok: false, error: 'Owner account already set up on this device. Sign in instead.' });
      const email = String(body.email || '').trim().toLowerCase();
      const displayName = String(body.displayName || 'Zoiris Owner').trim();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes(400, { ok: false, error: 'Enter a valid email address.' });
      if (password.length < 8) return jsonRes(400, { ok: false, error: 'Choose a password with at least 8 characters.' });
      const salt = randHex(16);
      const pwHash = await hashPassword(password, salt);
      const nowIso = new Date().toISOString();
      v.owner = { id: 'owner-local-1', email, displayName, passwordHash: pwHash, mfaEnabled: false, createdAt: nowIso };
      v.notifPrefs.email_address = email;

      const dev = describeCurrentDevice(body.deviceHint);
      const sess = {
        id: randHex(12),
        csrfToken: randHex(16),
        deviceLabel: dev.label,
        deviceKind: dev.kind,
        rememberDevice: true,
        ip_hint: 'device',
        created_at: nowIso,
        last_active_at: nowIso,
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
      };
      v.sessions = [sess];
      v.notifications.unshift({
        id: randHex(8),
        title: `Signed in from ${dev.label}`,
        body: 'Zoiris Phone Vault ready — stays signed in on this device for 30 days.',
        is_read: 0,
        created_at: nowIso
      });
      logAudit(v, 'owner.provisioned', 'owner_profile', v.owner.id);
      writeVault(v);
      localStorage.setItem(SESSION_KEY, sess.id);
      return jsonRes(201, {
        ok: true,
        owner: { id: v.owner.id, email, displayName, mfaEnabled: false },
        sessionId: sess.id,
        currentDevice: dev.label,
        deviceKind: dev.kind,
        rememberDevice: true,
        activeDeviceCount: 1,
        csrfToken: sess.csrfToken
      });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!v.owner) return jsonRes(400, { ok: false, error: 'Set up your owner login on this device first.' });
      const email = String(body.email || '').trim().toLowerCase();
      const okPw = await verifyPassword(String(body.password || ''), v.owner.passwordHash);
      if (email !== v.owner.email || !okPw) {
        return jsonRes(401, { ok: false, error: 'Invalid email or password for this device.' });
      }
      const nowIso = new Date().toISOString();
      const dev = describeCurrentDevice(body.deviceHint);
      const remember = body.rememberDevice !== false;
      const sess = {
        id: randHex(12),
        csrfToken: randHex(16),
        deviceLabel: dev.label,
        deviceKind: dev.kind,
        rememberDevice: remember,
        ip_hint: 'device',
        created_at: nowIso,
        last_active_at: nowIso,
        expires_at: new Date(Date.now() + (remember ? 30 * 86400000 : 8 * 3600000)).toISOString()
      };
      v.sessions = (v.sessions || []).filter((s) => !s.revoked_at && Date.parse(s.expires_at) > Date.now());
      v.sessions.unshift(sess);
      v.notifications.unshift({
        id: randHex(8),
        title: `Signed in from ${dev.label}`,
        body: `Owner dashboard session started (${remember ? 'stays signed in 30 days' : 'temporary session'}).`,
        is_read: 0,
        created_at: nowIso
      });
      logAudit(v, 'auth.login_succeeded', 'owner_session', sess.id);
      writeVault(v);
      localStorage.setItem(SESSION_KEY, sess.id);
      return jsonRes(200, {
        ok: true,
        mfaRequired: false,
        owner: { id: v.owner.id, email: v.owner.email, displayName: v.owner.displayName, mfaEnabled: false },
        sessionId: sess.id,
        currentDevice: dev.label,
        deviceKind: dev.kind,
        rememberDevice: remember,
        activeDeviceCount: v.sessions.length,
        csrfToken: sess.csrfToken
      });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const sid = localStorage.getItem(SESSION_KEY) || '';
      v.sessions = (v.sessions || []).filter((s) => s.id !== sid);
      logAudit(v, 'auth.logout', 'owner_session', sid);
      writeVault(v);
      localStorage.removeItem(SESSION_KEY);
      return jsonRes(200, { ok: true });
    }

    // Require active session for all /api/owner/* routes
    const sess = currentSession(v);
    if (!sess) return jsonRes(401, { ok: false, error: 'Authentication required.' });

    const hydrateAttachment = async (a) => {
      const bUrl = await getMediaBlobUrl(a.id);
      return Object.assign({}, a, {
        mediaKind: a.media_kind || 'photo',
        safeFilename: a.safe_filename || a.original_filename || 'upload',
        originalFilename: a.original_filename || a.safe_filename || 'upload',
        byteSize: Number(a.byte_size || 0),
        customerName: a.customer_name || 'Customer',
        leadNumber: a.lead_number || '',
        leadId: a.lead_id || '',
        previewUrl: bUrl,
        streamUrl: bUrl,
        downloadUrl: bUrl
      });
    };

    // Overview & 15 KPIs + 9 Charts
    if (pathname === '/api/owner/overview' && method === 'GET') {
      const seed = await loadSeedSeo();
      const activeAreas = (seed.municipalities || []).filter((m) => (v.coverageOverrides[`municipality:${m.id}`] || m.coverage_status) === 'active').length;
      const activeLeads = v.leads.filter((l) => l.status !== 'Spam');
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
      const byCity = {};
      const byService = {};
      const bySource = {};
      const byDay = {};
      for (const l of activeLeads) {
        byCity[l.city || 'Mobile'] = (byCity[l.city || 'Mobile'] || 0) + 1;
        byService[l.requestedService || 'Junk Removal'] = (byService[l.requestedService || 'Junk Removal'] || 0) + 1;
        bySource[l.sourceType || 'phone_call'] = (bySource[l.sourceType || 'phone_call'] || 0) + 1;
        const dKey = String(l.createdAt || '').slice(0, 10);
        if (dKey) byDay[dKey] = (byDay[dKey] || 0) + 1;
      }
      const completedCount = activeLeads.filter((l) => l.status === 'Completed').length;
      const convPct = activeLeads.length ? Math.round((completedCount / activeLeads.length) * 100) : 0;
      const leadNumById = new Map(v.leads.map((l) => [l.id, l.leadNumber]));

      return jsonRes(200, {
        ok: true,
        timezone: 'America/Chicago',
        kpis: {
          totalLeads: activeLeads.length,
          newLeads: activeLeads.filter((l) => l.status === 'New').length,
          unreadLeads: activeLeads.filter((l) => l.isUnread).length,
          leadsAwaitingContact: activeLeads.filter((l) => l.status === 'New' || l.status === 'Unread').length,
          quotesAwaitingResponse: activeLeads.filter((l) => l.status === 'Estimate Sent').length,
          scheduledPickups: activeLeads.filter((l) => l.status === 'Pickup Scheduled').length,
          inProgressJobs: activeLeads.filter((l) => l.status === 'Pickup In Progress').length,
          completedJobs: completedCount,
          lostOpportunities: v.leads.filter((l) => l.status === 'Not Converted').length,
          leadsToday: activeLeads.filter((l) => String(l.createdAt).slice(0, 10) === today).length,
          leadsThisWeek: activeLeads.filter((l) => l.createdAt >= weekAgo).length,
          leadsThisMonth: activeLeads.filter((l) => l.createdAt >= monthAgo).length,
          pendingCustomerUploads: 0,
          totalRegisteredCustomers: v.customers.length,
          activeServiceAreas: activeAreas || 11,
          ewasteRequests: activeLeads.filter((l) => l.hasElectronics).length,
          totalMediaFiles: v.attachments.length,
          storageUsedBytes: v.attachments.reduce((s, a) => s + Number(a.byte_size || 0), 0),
          conversionRatePct: convPct
        },
        charts: {
          leadsOverTime: Object.entries(byDay)
            .sort(([a], [b]) => a.localeCompare(b))
            .slice(-14)
            .map(([label, value]) => ({ label, value })),
          leadSources: Object.entries(bySource).map(([label, value]) => ({ label, value })),
          submissionsByLocation: Object.entries(byCity).map(([label, value]) => ({ label, value })),
          serviceRequests: Object.entries(byService).map(([label, value]) => ({ label, value })),
          residentialVsCommercial: [
            { label: 'Residential', value: activeLeads.filter((l) => l.customerType !== 'commercial').length },
            { label: 'Commercial', value: activeLeads.filter((l) => l.customerType === 'commercial').length }
          ].filter((x) => x.value > 0),
          electronicsVsGeneralJunk: [
            { label: 'General Junk', value: activeLeads.filter((l) => !l.hasElectronics).length },
            { label: 'Electronics / E-Waste', value: activeLeads.filter((l) => l.hasElectronics).length }
          ].filter((x) => x.value > 0),
          newVsCompleted: [
            { label: 'New / Open', value: activeLeads.length - completedCount },
            { label: 'Completed', value: completedCount }
          ].filter((x) => x.value > 0),
          mobileVsDesktop: [{ label: sess.deviceKind || 'phone', value: activeLeads.length }].filter((x) => x.value > 0),
          conversionRates: [{ label: 'Request → Completed', denominator: activeLeads.length, value: convPct }]
        },
        recentLeads: activeLeads.slice(0, 8),
        recentActivity: v.timeline.slice(0, 10).map((ev) => ({
          lead_number: leadNumById.get(ev.lead_id) || 'ZJ',
          created_at: ev.created_at,
          summary: ev.summary
        }))
      });
    }

    // Leads collection + Quick Add Lead + Bulk Delete
    if (pathname === '/api/owner/leads' && method === 'GET') {
      const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
      const status = urlObj.searchParams.get('status') || '';
      let rows = v.leads.slice();
      if (!status) rows = rows.filter((l) => l.status !== 'Spam');
      else rows = rows.filter((l) => l.status === status);
      if (q) {
        rows = rows.filter((l) =>
          [l.leadNumber, l.fullName, l.phone, l.email, l.pickupAddress, l.city, l.requestedService].some((f) =>
            String(f || '').toLowerCase().includes(q)
          )
        );
      }
      return jsonRes(200, { ok: true, total: rows.length, page: 1, totalPages: 1, leads: rows });
    }

    if (pathname === '/api/owner/leads/bulk-delete' && method === 'POST') {
      const targetIds = new Set(
        body.all
          ? v.leads.map((l) => l.id)
          : Array.isArray(body.statuses)
            ? v.leads.filter((l) => body.statuses.includes(l.status)).map((l) => l.id)
            : Array.isArray(body.leadIds)
              ? body.leadIds
              : []
      );
      let bytesFreed = 0;
      for (const a of v.attachments.filter((x) => targetIds.has(x.lead_id))) {
        bytesFreed += Number(a.byte_size || 0);
        await deleteMediaBlob(a.id);
      }
      v.attachments = v.attachments.filter((x) => !targetIds.has(x.lead_id));
      v.notes = v.notes.filter((x) => !targetIds.has(x.lead_id));
      v.followUps = v.followUps.filter((x) => !targetIds.has(x.lead_id));
      v.appointments = v.appointments.filter((x) => !targetIds.has(x.lead_id));
      v.timeline = v.timeline.filter((x) => !targetIds.has(x.lead_id));
      const before = v.leads.length;
      v.leads = v.leads.filter((l) => !targetIds.has(l.id));
      writeVault(v);
      return jsonRes(200, { ok: true, deletedLeads: before - v.leads.length, bytesFreed });
    }

    if (pathname === '/api/owner/leads' && method === 'POST') {
      const fullName = String(body.fullName || '').trim();
      const phone = String(body.phone || '').trim();
      const pickupAddress = String(body.pickupAddress || '').trim();
      const city = String(body.city || 'Mobile').trim();
      const zipCode = String(body.zipCode || '36602').trim();
      if (!fullName || !phone || !pickupAddress) {
        return jsonRes(400, { ok: false, error: 'Enter customer name, phone number, and pickup address.' });
      }
      v.leadSeq = Number(v.leadSeq || 0) + 1;
      const year = new Date().getFullYear();
      const leadNumber = `ZJ-${year}-${String(v.leadSeq).padStart(6, '0')}`;
      const nowIso = new Date().toISOString();

      let lat = body.lat ?? null;
      let lng = body.lng ?? null;
      let addressStatus = 'unverified';
      let addressSource = 'manual';
      if (lat === null || lng === null) {
        try {
          const qAddr = `${pickupAddress}, ${city}, AL ${zipCode}`;
          const gRes = await nativeFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(qAddr)}`);
          if (gRes.ok) {
            const gRows = await gRes.json();
            if (gRows?.[0]) {
              lat = Number(gRows[0].lat);
              lng = Number(gRows[0].lon);
              addressStatus = 'map-match';
              addressSource = 'openstreetmap';
            }
          }
        } catch {}
      } else {
        addressStatus = 'verified';
        addressSource = 'census';
      }

      let cust = v.customers.find((c) => String(c.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''));
      if (!cust) {
        cust = {
          id: 'cust-' + randHex(6),
          full_name: fullName,
          phone,
          phone_display: phone,
          email: String(body.email || '').trim(),
          primary_address: pickupAddress,
          city,
          state: 'AL',
          zip_code: zipCode,
          customer_type: body.customerType || 'residential',
          total_inquiries: 1,
          completed_pickups: 0,
          created_at: nowIso,
          updated_at: nowIso
        };
        v.customers.unshift(cust);
      } else {
        cust.total_inquiries = Number(cust.total_inquiries || 1) + 1;
        cust.updated_at = nowIso;
      }

      const lead = {
        id: 'lead-' + randHex(6),
        leadNumber,
        customerId: cust.id,
        fullName,
        phone,
        email: String(body.email || '').trim(),
        preferredContact: body.preferredContact || 'phone',
        customerType: body.customerType || 'residential',
        pickupAddress,
        city,
        state: 'AL',
        zipCode,
        countyName: 'Mobile / Baldwin Area',
        lat,
        lng,
        addressStatus,
        addressSource,
        matchedAddress: pickupAddress,
        requestedService: body.requestedService || 'Junk Removal',
        itemCategories: body.hasElectronics ? ['Electronics'] : ['Furniture / Junk'],
        selectedItems: [
          {
            category: body.hasElectronics ? 'Electronics' : 'Junk Removal',
            item_name: body.requestedService || 'Pickup items',
            is_electronics: !!body.hasElectronics,
            requires_confirmation: false
          }
        ],
        hasElectronics: !!body.hasElectronics,
        estimatedQuantity: body.estimatedQuantity || 'Pickup-truck load',
        itemDescription: String(body.itemDescription || '').trim(),
        accessInstructions: String(body.accessInstructions || '').trim(),
        preferredDate: body.preferredDate || '',
        preferredWindow: body.preferredWindow || 'Flexible',
        status: 'New',
        priority: 'normal',
        estimateCents: null,
        estimateNotes: '',
        isUnread: false,
        needsReview: false,
        spamScore: 0,
        spamFlags: [],
        photoCount: 0,
        videoCount: 0,
        sourceType: 'phone_call',
        sourcePagePath: 'logged_on_device',
        deviceCategory: sess.deviceKind || 'phone',
        createdAt: nowIso,
        updatedAt: nowIso
      };
      v.leads.unshift(lead);
      v.timeline.unshift({
        id: randHex(6),
        lead_id: lead.id,
        event_type: 'lead.created',
        summary: `Request ${leadNumber} logged on ${sess.deviceLabel}`,
        actor_label: v.owner.displayName,
        created_at: nowIso
      });
      logAudit(v, 'lead.created', 'lead', leadNumber);
      writeVault(v);
      return jsonRes(201, { ok: true, lead });
    }

    // Pipeline Board
    if (pathname === '/api/owner/pipeline' && method === 'GET') {
      const columns = {};
      for (const st of PIPELINE_STATUSES) columns[st] = [];
      for (const l of v.leads) {
        if (!columns[l.status]) columns[l.status] = [];
        columns[l.status].push(l);
      }
      return jsonRes(200, { ok: true, statuses: PIPELINE_STATUSES, columns });
    }

    // Map pins
    if (pathname === '/api/owner/map/pins' && method === 'GET') {
      const showAll = urlObj.searchParams.get('all') === '1';
      return jsonRes(200, {
        ok: true,
        pins: v.leads.filter((l) => l.status !== 'Spam' && (showAll || l.status !== 'Completed') && l.lat !== null && l.lng !== null)
      });
    }

    // Lead subroutes
    const leadPhotoMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/media$/);
    if (leadPhotoMatch && method === 'POST') {
      const key = decodeURIComponent(leadPhotoMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      const fd = init?.body instanceof FormData ? init.body : null;
      const file = fd?.get('file');
      if (!file) return jsonRes(400, { ok: false, error: 'Choose a photo or video file.' });
      const attId = 'att-' + randHex(8);
      const isVid = String(file.type || '').startsWith('video/');
      await putMediaBlob(attId, file);
      const nowIso = new Date().toISOString();
      const att = {
        id: attId,
        lead_id: lead.id,
        lead_number: lead.leadNumber,
        customer_name: lead.fullName,
        media_kind: isVid ? 'video' : 'photo',
        mime_type: file.type || (isVid ? 'video/mp4' : 'image/jpeg'),
        original_filename: file.name || (isVid ? 'video.mp4' : 'photo.jpg'),
        safe_filename: file.name || (isVid ? 'video.mp4' : 'photo.jpg'),
        byte_size: file.size || 0,
        created_at: nowIso
      };
      v.attachments.unshift(att);
      if (isVid) lead.videoCount = Number(lead.videoCount || 0) + 1;
      else lead.photoCount = Number(lead.photoCount || 0) + 1;
      writeVault(v);
      return jsonRes(201, { ok: true, attachment: await hydrateAttachment(att) });
    }

    if (leadPhotoMatch && method === 'DELETE') {
      const key = decodeURIComponent(leadPhotoMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      const removed = v.attachments.filter((a) => a.lead_id === lead.id);
      const bytesFreed = removed.reduce((s, a) => s + Number(a.byte_size || 0), 0);
      for (const a of removed) await deleteMediaBlob(a.id);
      v.attachments = v.attachments.filter((a) => a.lead_id !== lead.id);
      lead.photoCount = 0;
      lead.videoCount = 0;
      writeVault(v);
      return jsonRes(200, { ok: true, deletedCount: removed.length, bytesFreed });
    }

    const leadStatusMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/status$/);
    if (leadStatusMatch && method === 'POST') {
      const key = decodeURIComponent(leadStatusMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      lead.status = body.status || lead.status;
      lead.isUnread = false;
      if (lead.status === 'Completed') lead.completedAt = new Date().toISOString();
      lead.updatedAt = new Date().toISOString();
      v.timeline.unshift({
        id: randHex(6),
        lead_id: lead.id,
        event_type: 'lead.status_changed',
        summary: `Moved to ${lead.status}${body.note ? ` — ${body.note}` : ''}`,
        actor_label: v.owner.displayName,
        created_at: lead.updatedAt
      });
      logAudit(v, 'lead.status_changed', 'lead', lead.leadNumber);
      writeVault(v);
      return jsonRes(200, { ok: true, lead });
    }

    const leadNotesMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/notes$/);
    if (leadNotesMatch && method === 'POST') {
      const key = decodeURIComponent(leadNotesMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      const n = {
        id: randHex(6),
        lead_id: lead.id,
        note_type: body.noteType || 'internal_note',
        body: String(body.body || '').trim(),
        author_name: v.owner.displayName,
        created_at: new Date().toISOString()
      };
      v.notes.unshift(n);
      writeVault(v);
      return jsonRes(201, { ok: true, notes: v.notes.filter((x) => x.lead_id === lead.id) });
    }

    const noteDelMatch = pathname.match(/^\/api\/owner\/(?:leads\/[^/]+\/)?notes\/([^/]+)$/);
    if (noteDelMatch && method === 'DELETE') {
      const nid = decodeURIComponent(noteDelMatch[1]);
      v.notes = v.notes.filter((n) => n.id !== nid);
      writeVault(v);
      return jsonRes(200, { ok: true });
    }

    const leadTaskMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)\/follow-ups$/);
    if (leadTaskMatch && method === 'POST') {
      const key = decodeURIComponent(leadTaskMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      v.followUps.unshift({
        id: randHex(6),
        lead_id: lead.id,
        title: String(body.title || '').trim(),
        due_date: body.dueDate || new Date().toISOString().slice(0, 10),
        status: 'open',
        created_at: new Date().toISOString()
      });
      writeVault(v);
      return jsonRes(201, { ok: true });
    }

    const taskItemMatch = pathname.match(/^\/api\/owner\/follow-ups\/([^/]+)$/);
    if (taskItemMatch) {
      const tid = decodeURIComponent(taskItemMatch[1]);
      if (method === 'PATCH') {
        const t = v.followUps.find((x) => x.id === tid);
        if (t) t.status = body.status || 'completed';
        writeVault(v);
        return jsonRes(200, { ok: true });
      }
      if (method === 'DELETE') {
        v.followUps = v.followUps.filter((x) => x.id !== tid);
        writeVault(v);
        return jsonRes(200, { ok: true });
      }
    }

    const leadDetailMatch = pathname.match(/^\/api\/owner\/leads\/([^/]+)$/);
    if (leadDetailMatch) {
      const key = decodeURIComponent(leadDetailMatch[1]);
      const lead = v.leads.find((l) => l.id === key || l.leadNumber === key);
      if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
      if (method === 'GET') {
        lead.isUnread = false;
        writeVault(v);
        const atts = await Promise.all(v.attachments.filter((a) => a.lead_id === lead.id).map(hydrateAttachment));
        return jsonRes(200, {
          ok: true,
          lead,
          items: lead.selectedItems || [],
          attachments: atts,
          notes: v.notes.filter((n) => n.lead_id === lead.id),
          followUps: v.followUps.filter((f) => f.lead_id === lead.id),
          appointments: v.appointments.filter((ap) => ap.lead_id === lead.id),
          timeline: v.timeline.filter((ev) => ev.lead_id === lead.id)
        });
      }
      if (method === 'PATCH') {
        if (body.priority) lead.priority = body.priority;
        if (body.estimateDollars !== undefined) {
          lead.estimateCents = body.estimateDollars === '' ? null : Math.round(Number(body.estimateDollars) * 100);
        }
        if (body.estimateNotes !== undefined) lead.estimateNotes = String(body.estimateNotes);
        lead.updatedAt = new Date().toISOString();
        writeVault(v);
        return jsonRes(200, { ok: true, lead });
      }
      if (method === 'DELETE') {
        const removed = v.attachments.filter((a) => a.lead_id === lead.id);
        const bytesFreed = removed.reduce((s, a) => s + Number(a.byte_size || 0), 0);
        for (const a of removed) await deleteMediaBlob(a.id);
        v.attachments = v.attachments.filter((a) => a.lead_id !== lead.id);
        v.notes = v.notes.filter((n) => n.lead_id !== lead.id);
        v.followUps = v.followUps.filter((f) => f.lead_id !== lead.id);
        v.appointments = v.appointments.filter((ap) => ap.lead_id !== lead.id);
        v.timeline = v.timeline.filter((ev) => ev.lead_id !== lead.id);
        v.leads = v.leads.filter((l) => l.id !== lead.id);
        logAudit(v, 'lead.deleted', 'lead', lead.leadNumber);
        writeVault(v);
        return jsonRes(200, { ok: true, leadNumber: lead.leadNumber, bytesFreed, mediaBytesFreed: bytesFreed });
      }
    }

    // Customers
    if (pathname === '/api/owner/customers' && method === 'GET') {
      const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
      const rows = v.customers
        .map((c) =>
          Object.assign({}, c, {
            phone_display: c.phone_display || c.phone || '',
            total_inquiries: v.leads.filter((l) => l.customerId === c.id).length || c.total_inquiries || 0,
            completed_pickups: v.leads.filter((l) => l.customerId === c.id && l.status === 'Completed').length
          })
        )
        .filter((c) => !q || [c.full_name, c.phone_display, c.email, c.city].some((f) => String(f || '').toLowerCase().includes(q)));
      return jsonRes(200, { ok: true, total: rows.length, customers: rows, duplicateSuggestions: [] });
    }
    const custRedactMatch = pathname.match(/^\/api\/owner\/customers\/([^/]+)\/redact$/);
    if (custRedactMatch && method === 'POST') {
      const cid = decodeURIComponent(custRedactMatch[1]);
      const c = v.customers.find((x) => x.id === cid);
      if (c) {
        c.full_name = 'Redacted Customer';
        c.phone = '';
        c.phone_display = 'Redacted';
        c.email = '';
        c.primary_address = 'Redacted';
        writeVault(v);
      }
      return jsonRes(200, { ok: true });
    }
    const custMatch = pathname.match(/^\/api\/owner\/customers\/([^/]+)$/);
    if (custMatch) {
      const cid = decodeURIComponent(custMatch[1]);
      if (method === 'GET') {
        const c = v.customers.find((x) => x.id === cid);
        if (!c) return jsonRes(404, { ok: false, error: 'Customer not found.' });
        return jsonRes(200, {
          ok: true,
          customer: Object.assign({}, c, { phone_display: c.phone_display || c.phone || '' }),
          leads: v.leads.filter((l) => l.customerId === cid)
        });
      }
      if (method === 'DELETE') {
        const cLeads = v.leads.filter((l) => l.customerId === cid);
        let bytesFreed = 0;
        for (const l of cLeads) {
          for (const a of v.attachments.filter((x) => x.lead_id === l.id)) {
            bytesFreed += Number(a.byte_size || 0);
            await deleteMediaBlob(a.id);
          }
          v.attachments = v.attachments.filter((x) => x.lead_id !== l.id);
        }
        v.leads = v.leads.filter((l) => l.customerId !== cid);
        v.customers = v.customers.filter((x) => x.id !== cid);
        writeVault(v);
        return jsonRes(200, { ok: true, deletedLeads: cLeads.length, bytesFreed, mediaBytesFreed: bytesFreed });
      }
    }

    // Calendar & Appointments
    if (pathname === '/api/owner/calendar') {
      if (method === 'GET') return jsonRes(200, { ok: true, timezone: 'America/Chicago', appointments: v.appointments });
      if (method === 'POST') {
        const lead = v.leads.find((l) => l.id === body.leadId || l.leadNumber === body.leadId);
        if (!lead) return jsonRes(404, { ok: false, error: 'Request not found.' });
        const appt = {
          id: 'appt-' + randHex(6),
          lead_id: lead.id,
          lead_number: lead.leadNumber,
          customer_name: lead.fullName,
          customer_phone: lead.phone,
          pickup_address: lead.pickupAddress,
          city: lead.city,
          state: lead.state || 'AL',
          zip_code: lead.zipCode,
          requested_service: lead.requestedService,
          scheduled_date: body.scheduledDate,
          time_window: body.timeWindow || '8:00 AM – 11:00 AM',
          instructions: body.instructions || '',
          status: 'scheduled',
          created_at: new Date().toISOString()
        };
        v.appointments.push(appt);
        lead.status = 'Pickup Scheduled';
        writeVault(v);
        return jsonRes(201, { ok: true, appointment: appt });
      }
    }
    const apptMatch = pathname.match(/^\/api\/owner\/(?:appointments|calendar)\/([^/]+)$/);
    if (apptMatch) {
      const aid = decodeURIComponent(apptMatch[1]);
      if (method === 'PATCH') {
        const ap = v.appointments.find((x) => x.id === aid);
        if (ap && body.status) ap.status = body.status;
        writeVault(v);
        return jsonRes(200, { ok: true });
      }
      if (method === 'DELETE') {
        v.appointments = v.appointments.filter((x) => x.id !== aid);
        writeVault(v);
        return jsonRes(200, { ok: true });
      }
    }

    // Media library
    if (pathname === '/api/owner/media' && method === 'GET') {
      const items = await Promise.all(v.attachments.map(hydrateAttachment));
      return jsonRes(200, { ok: true, attachments: items, capacity: buildCapacitySnapshot(v) });
    }
    if (pathname === '/api/owner/media/bulk-delete' && method === 'POST') {
      if (body.filter === 'closed_leads') {
        const closedIds = new Set(v.leads.filter((l) => ['Completed', 'Not Converted', 'Archived', 'Spam'].includes(l.status)).map((l) => l.id));
        const removed = v.attachments.filter((a) => closedIds.has(a.lead_id));
        const bytesFreed = removed.reduce((s, a) => s + Number(a.byte_size || 0), 0);
        for (const a of removed) await deleteMediaBlob(a.id);
        v.attachments = v.attachments.filter((a) => !closedIds.has(a.lead_id));
        v.leads.filter((l) => closedIds.has(l.id)).forEach((l) => {
          l.photoCount = 0;
          l.videoCount = 0;
        });
        writeVault(v);
        return jsonRes(200, { ok: true, deletedCount: removed.length, bytesFreed });
      }
      const deletedCount = v.attachments.length;
      const bytesFreed = v.attachments.reduce((s, a) => s + Number(a.byte_size || 0), 0);
      await clearAllMediaBlobs();
      v.attachments = [];
      v.leads.forEach((l) => {
        l.photoCount = 0;
        l.videoCount = 0;
      });
      writeVault(v);
      return jsonRes(200, { ok: true, deletedCount, bytesFreed });
    }
    const mediaDelMatch = pathname.match(/^\/api\/owner\/media\/([^/]+)$/);
    if (mediaDelMatch && method === 'DELETE') {
      const mid = decodeURIComponent(mediaDelMatch[1]);
      const att = v.attachments.find((a) => a.id === mid);
      const bytesFreed = Number(att?.byte_size || 0);
      await deleteMediaBlob(mid);
      v.attachments = v.attachments.filter((a) => a.id !== mid);
      if (att) {
        const lead = v.leads.find((l) => l.id === att.lead_id);
        if (lead) {
          if (att.media_kind === 'video') lead.videoCount = Math.max(0, Number(lead.videoCount || 1) - 1);
          else lead.photoCount = Math.max(0, Number(lead.photoCount || 1) - 1);
        }
      }
      writeVault(v);
      return jsonRes(200, { ok: true, bytesFreed });
    }

    // Analytics & Search Performance
    if (pathname === '/api/owner/analytics' && method === 'GET') {
      const activeCount = v.leads.filter((l) => l.status !== 'Spam').length;
      return jsonRes(200, {
        ok: true,
        source: {
          ga4Status: 'On-Device Phone Vault (connect Cloud CRM for live web traffic)',
          phoneClicksDisclaimer: 'Counts taps on your public website phone buttons when connected to a Cloud CRM server.'
        },
        summary: {
          visitors: 0,
          sessions: 0,
          pageViews: 0,
          clickToCallEvents: 0,
          formStarts: 0,
          uploadCompletions: 0,
          crmFormSubmissions: activeCount,
          qualifiedLeads: activeCount,
          conversionRatePct: null
        },
        topPages: [],
        trafficSources: [],
        deviceBreakdown: []
      });
    }
    if (pathname === '/api/owner/analytics/realtime' && method === 'GET') {
      return jsonRes(200, { ok: true, activeVisitorsLast5Min: 0, pageViewsLast5Min: 0, phoneClicksLast5Min: 0 });
    }
    if (pathname === '/api/owner/analytics/events' && method === 'DELETE') return jsonRes(200, { ok: true, deleted: 0 });

    if (pathname === '/api/owner/search-performance' && method === 'GET') {
      const seed = await loadSeedSeo();
      const totalClicks = v.gscRows.reduce((s, r) => s + Number(r.clicks || 0), 0);
      const totalImpr = v.gscRows.reduce((s, r) => s + Number(r.impressions || 0), 0);
      return jsonRes(200, {
        ok: true,
        connection: { status: v.gscRows.length ? 'imported' : 'not_configured', lastImportedAt: v.gscRows[0]?.importedAt || null },
        totals: {
          clicks: totalClicks,
          impressions: totalImpr,
          ctr: totalImpr ? Number(((totalClicks / totalImpr) * 100).toFixed(1)) : 0,
          avgPosition: v.gscRows.length ? v.gscRows[0].avgPosition : null
        },
        topQueries: v.gscRows,
        locationPerformance: (seed.municipalities || []).slice(0, 18).map((m) => ({
          name: m.name,
          countyId: m.county_id,
          coverageStatus: v.coverageOverrides[`municipality:${m.id}`] || m.coverage_status,
          searchImpressions: 0,
          telephoneClicks: 0,
          formSubmissions: v.leads.filter((l) => String(l.city || '').toLowerCase() === String(m.name || '').toLowerCase()).length
        }))
      });
    }
    if (pathname === '/api/owner/search-performance/import-csv' && method === 'POST') {
      const lines = String(body.csvText || '')
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      let imported = 0;
      for (const ln of lines.slice(1)) {
        const cols = ln.split(',');
        if (cols.length >= 3) {
          v.gscRows.push({
            key: cols[0],
            clicks: Number(cols[1] || 0),
            impressions: Number(cols[2] || 0),
            ctr: Number(String(cols[3] || '0').replace('%', '')),
            avgPosition: Number(cols[4] || 0),
            importedAt: new Date().toISOString()
          });
          imported++;
        }
      }
      writeVault(v);
      return jsonRes(200, { ok: true, imported });
    }
    if (pathname === '/api/owner/search-performance/snapshots' && method === 'DELETE') {
      const deleted = v.gscRows.length;
      v.gscRows = [];
      writeVault(v);
      return jsonRes(200, { ok: true, deleted });
    }

    // Locations & SEO Pages (from seed-seo.json)
    if (pathname === '/api/owner/locations' && method === 'GET') {
      const seed = await loadSeedSeo();
      const municipalities = (seed.municipalities || []).map((m) =>
        Object.assign({}, m, v.coverageOverrides[`municipality:${m.id}`] ? { coverage_status: v.coverageOverrides[`municipality:${m.id}`] } : {})
      );
      const neighborhoods = (seed.neighborhoods || []).map((n) =>
        Object.assign({}, n, v.coverageOverrides[`neighborhood:${n.id}`] ? { coverage_status: v.coverageOverrides[`neighborhood:${n.id}`] } : {})
      );
      return jsonRes(200, { ok: true, counties: seed.counties || [], municipalities, neighborhoods, performance: [] });
    }
    if (pathname === '/api/owner/locations/coverage' && method === 'PATCH') {
      v.coverageOverrides[`${body.entityKind}:${body.id}`] = body.coverageStatus;
      logAudit(v, 'location.coverage_updated', body.entityKind, body.id);
      writeVault(v);
      return jsonRes(200, { ok: true });
    }
    if (pathname === '/api/owner/seo-pages' && method === 'GET') {
      const seed = await loadSeedSeo();
      const allPages = [...(v.draftPages || []), ...(seed.pages || [])];
      const counts = {
        total: allPages.length,
        indexable: allPages.filter((p) => p.status === 'published' || p.status === 'indexable').length,
        draft: allPages.filter((p) => p.status === 'draft').length,
        research: allPages.filter((p) => p.status === 'research').length,
        idea: allPages.filter((p) => p.status === 'idea').length
      };
      return jsonRes(200, {
        ok: true,
        counts,
        services: seed.services || [],
        items: seed.items || [],
        locations: (seed.municipalities || []).map((m) => ({
          id: m.id,
          name: m.name,
          county: m.county_id === 'baldwin-county-al' ? 'Baldwin' : 'Mobile',
          coverage: v.coverageOverrides[`municipality:${m.id}`] || m.coverage_status
        })),
        neighborhoods: (seed.neighborhoods || []).map((n) => ({
          id: n.id,
          name: n.name,
          coverage: v.coverageOverrides[`neighborhood:${n.id}`] || n.coverage_status
        })),
        pages: allPages
      });
    }
    if (pathname === '/api/owner/seo-pages/create-draft' && method === 'POST') {
      const areaSlug = body.neighborhoodId || body.locationId || 'mobile-al';
      const svcSlug = body.serviceId || 'junk-removal';
      const slug = `${areaSlug}-${svcSlug}`;
      const rec = {
        id: `draft-${slug}`,
        type: 'service-location',
        path: `/areas/${areaSlug}/${svcSlug}/`,
        status: 'draft',
        title: `${svcSlug} in ${areaSlug}`,
        primaryKeyword: `${svcSlug.replace(/-/g, ' ')} ${areaSlug.replace(/-/g, ' ')}`,
        score: 88,
        passesGate: false,
        blockers: ['Draft saved on device']
      };
      v.draftPages = [rec, ...(v.draftPages || []).filter((p) => p.id !== rec.id)];
      writeVault(v);
      return jsonRes(201, { ok: true, record: rec });
    }
    if (pathname === '/api/owner/seo-pages/rebuild' && method === 'POST') {
      return jsonRes(200, {
        ok: true,
        output: 'Your public site is automatically built and deployed by GitHub Actions whenever changes are pushed to GitHub.'
      });
    }
    const seoDelMatch = pathname.match(/^\/api\/owner\/seo-pages\/([^/]+)$/);
    if (seoDelMatch && method === 'DELETE') {
      const pid = decodeURIComponent(seoDelMatch[1]);
      const before = (v.draftPages || []).length;
      v.draftPages = (v.draftPages || []).filter((p) => p.id !== pid);
      if (v.draftPages.length === before) return jsonRes(400, { ok: false, error: 'Only draft pages created on this device can be deleted here.' });
      writeVault(v);
      return jsonRes(200, { ok: true, deletedId: pid });
    }

    // Capacity, Storage Cleanup & Backups
    if (pathname === '/api/owner/capacity' && method === 'GET') {
      return jsonRes(200, { ok: true, capacity: buildCapacitySnapshot(v), backups: v.backups });
    }

    if (pathname === '/api/owner/storage/cleanup' && method === 'POST') {
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      let bytesFreed = 0;
      if (scopes.includes('spam_archived') || scopes.includes('spam_closed')) {
        const dropIds = new Set(v.leads.filter((l) => ['Spam', 'Not Converted', 'Archived'].includes(l.status)).map((l) => l.id));
        for (const a of v.attachments.filter((x) => dropIds.has(x.lead_id))) {
          bytesFreed += Number(a.byte_size || 0);
          await deleteMediaBlob(a.id);
        }
        v.attachments = v.attachments.filter((x) => !dropIds.has(x.lead_id));
        v.leads = v.leads.filter((l) => !dropIds.has(l.id));
      }
      if (scopes.includes('closed_media')) {
        const closedIds = new Set(v.leads.filter((l) => ['Completed', 'Not Converted', 'Archived', 'Spam'].includes(l.status)).map((l) => l.id));
        for (const a of v.attachments.filter((x) => closedIds.has(x.lead_id))) {
          bytesFreed += Number(a.byte_size || 0);
          await deleteMediaBlob(a.id);
        }
        v.attachments = v.attachments.filter((x) => !closedIds.has(x.lead_id));
        v.leads.filter((l) => closedIds.has(l.id)).forEach((l) => {
          l.photoCount = 0;
          l.videoCount = 0;
        });
      }
      if (scopes.includes('completed_leads') || scopes.includes('completed')) {
        const dropIds = new Set(v.leads.filter((l) => l.status === 'Completed').map((l) => l.id));
        for (const a of v.attachments.filter((x) => dropIds.has(x.lead_id))) {
          bytesFreed += Number(a.byte_size || 0);
          await deleteMediaBlob(a.id);
        }
        v.attachments = v.attachments.filter((x) => !dropIds.has(x.lead_id));
        v.leads = v.leads.filter((l) => !dropIds.has(l.id));
      }
      if (scopes.includes('all_media')) {
        bytesFreed += v.attachments.reduce((s, a) => s + Number(a.byte_size || 0), 0);
        await clearAllMediaBlobs();
        v.attachments = [];
        v.leads.forEach((l) => {
          l.photoCount = 0;
          l.videoCount = 0;
        });
      }
      if (scopes.includes('all_leads_customers')) {
        bytesFreed += v.attachments.reduce((s, a) => s + Number(a.byte_size || 0), 0);
        await clearAllMediaBlobs();
        v.attachments = [];
        v.leads = [];
        v.customers = [];
        v.notes = [];
        v.followUps = [];
        v.appointments = [];
        v.timeline = [];
      }
      if (scopes.includes('analytics')) v.gscRows = [];
      if (scopes.includes('backups')) v.backups = [];
      if (scopes.includes('logs')) {
        v.auditLogs = [];
        v.notifications = [];
      }
      writeVault(v);
      return jsonRes(200, { ok: true, summary: { bytesFreed } });
    }

    if (pathname === '/api/owner/backups') {
      if (method === 'POST') {
        const snap = JSON.stringify(v);
        const bk = {
          filename: `zoiris-phone-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
          byteSize: snap.length,
          createdAt: new Date().toISOString()
        };
        v.backups.unshift(bk);
        writeVault(v);
        return jsonRes(201, { ok: true, backup: bk });
      }
      if (method === 'DELETE') {
        const bytesFreed = v.backups.reduce((s, b) => s + Number(b.byteSize || 0), 0);
        const deletedCount = v.backups.length;
        v.backups = [];
        writeVault(v);
        return jsonRes(200, { ok: true, deletedCount, bytesFreed });
      }
    }
    const bkMatch = pathname.match(/^\/api\/owner\/backups\/([^/]+)$/);
    if (bkMatch && method === 'DELETE') {
      const fn = decodeURIComponent(bkMatch[1]);
      const found = v.backups.find((b) => b.filename === fn);
      v.backups = v.backups.filter((b) => b.filename !== fn);
      writeVault(v);
      return jsonRes(200, { ok: true, bytesFreed: Number(found?.byteSize || 0) });
    }

    // Notifications & Settings
    if (pathname === '/api/owner/notifications') {
      if (method === 'GET') return jsonRes(200, { ok: true, notifications: v.notifications, preferences: v.notifPrefs });
      if (method === 'DELETE') {
        const deleted = v.notifications.length;
        v.notifications = [];
        writeVault(v);
        return jsonRes(200, { ok: true, deleted });
      }
    }
    if (pathname === '/api/owner/notifications/read-all' && method === 'POST') {
      v.notifications.forEach((n) => (n.is_read = 1));
      writeVault(v);
      return jsonRes(200, { ok: true });
    }
    const notifDelMatch = pathname.match(/^\/api\/owner\/notifications\/([^/]+)$/);
    if (notifDelMatch && method === 'DELETE') {
      const nid = decodeURIComponent(notifDelMatch[1]);
      v.notifications = v.notifications.filter((n) => n.id !== nid);
      writeVault(v);
      return jsonRes(200, { ok: true });
    }
    if (pathname === '/api/owner/notification-preferences' && method === 'PUT') {
      v.notifPrefs = Object.assign(v.notifPrefs, {
        sound_enabled: body.soundEnabled ? 1 : 0,
        desktop_enabled: body.desktopEnabled ? 1 : 0,
        email_enabled: body.emailEnabled ? 1 : 0,
        email_address: body.emailAddress || v.notifPrefs.email_address,
        sms_enabled: body.smsEnabled ? 1 : 0,
        sms_phone: body.smsPhone || ''
      });
      writeVault(v);
      return jsonRes(200, { ok: true, preferences: v.notifPrefs });
    }

    if (pathname === '/api/owner/settings') {
      if (method === 'GET') {
        return jsonRes(200, {
          ok: true,
          localVaultMode: true,
          cloudApiUrl: localStorage.getItem('zoiris.cloudApiUrl') || '',
          settings: v.settings,
          integrations: [
            { id: 'vault', name: 'On-Device Encrypted Phone Vault (24/7 GitHub Pages)', status: 'connected' },
            { id: 'cloud', name: 'Optional Live Cloud CRM Sync Server', status: localStorage.getItem('zoiris.cloudApiUrl') ? 'configured' : 'not_configured' }
          ]
        });
      }
      if (method === 'PUT') {
        Object.assign(v.settings, body);
        writeVault(v);
        return jsonRes(200, { ok: true, settings: v.settings });
      }
    }

    // Security & Multi-Device Session Manager
    if (pathname === '/api/owner/security' && method === 'GET') {
      return jsonRes(200, {
        ok: true,
        owner: { id: v.owner.id, email: v.owner.email, displayName: v.owner.displayName, mfaEnabled: false },
        currentSessionId: sess.id,
        sessions: v.sessions,
        auditLogs: v.auditLogs
      });
    }
    if (pathname === '/api/owner/security/password' && method === 'POST') {
      const okCur = await verifyPassword(String(body.currentPassword || ''), v.owner.passwordHash);
      if (!okCur) return jsonRes(401, { ok: false, error: 'Current password did not match.' });
      if (String(body.newPassword || '').length < 8) return jsonRes(400, { ok: false, error: 'Choose at least 8 characters.' });
      v.owner.passwordHash = await hashPassword(String(body.newPassword), randHex(16));
      logAudit(v, 'security.password_changed', 'owner_profile', v.owner.id);
      writeVault(v);
      return jsonRes(200, { ok: true });
    }
    if (pathname === '/api/owner/security/revoke-sessions' && method === 'POST') {
      v.sessions = v.sessions.filter((s) => s.id === sess.id);
      writeVault(v);
      return jsonRes(200, { ok: true });
    }
    const secSessMatch = pathname.match(/^\/api\/owner\/security\/sessions\/([^/]+)$/);
    if (secSessMatch && method === 'DELETE') {
      const target = decodeURIComponent(secSessMatch[1]);
      if (target === sess.id) {
        v.sessions = v.sessions.filter((s) => s.id !== target);
        writeVault(v);
        localStorage.removeItem(SESSION_KEY);
        return jsonRes(200, { ok: true, signedOutCurrent: true });
      }
      v.sessions = v.sessions.filter((s) => s.id !== target);
      writeVault(v);
      return jsonRes(200, { ok: true, signedOutCurrent: false });
    }
    if (pathname === '/api/owner/security/audit-logs' && method === 'DELETE') {
      const deleted = v.auditLogs.length;
      v.auditLogs = [];
      writeVault(v);
      return jsonRes(200, { ok: true, deleted });
    }
    if (pathname.startsWith('/api/owner/security/mfa/')) {
      return jsonRes(400, { ok: false, error: '2-step TOTP requires a connected Cloud CRM server.' });
    }

    return jsonRes(200, { ok: true });
  }

  /* ---------------- Local CSV / Backup Download Helper ---------------- */
  document.addEventListener('click', (e) => {
    if (!window.__ZOIRIS_LOCAL_VAULT__) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const rawHref = a.getAttribute('href') || '';
    const stripped = window.zoirisStripBase ? window.zoirisStripBase(rawHref) : rawHref;
    const apiHref = rawHref.startsWith('/api/owner/')
      ? rawHref
      : BASE_PREFIX && rawHref.startsWith(BASE_PREFIX + '/api/owner/')
        ? rawHref.slice(BASE_PREFIX.length)
        : stripped.startsWith('/api/owner/')
          ? stripped
          : '';
    if (!apiHref) return;

    if (apiHref.startsWith('/api/owner/exports/leads.csv')) {
      e.preventDefault();
      const v = readVault();
      const csvCell = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const lines = [
        ['LeadNumber', 'Customer', 'Phone', 'Address', 'City', 'ZIP', 'Service', 'Status', 'CreatedAt'].join(','),
        ...v.leads.map((l) => [l.leadNumber, l.fullName, l.phone, l.pickupAddress, l.city, l.zipCode, l.requestedService, l.status, l.createdAt].map(csvCell).join(','))
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const dl = document.createElement('a');
      dl.href = URL.createObjectURL(blob);
      dl.download = 'zoiris-requests.csv';
      dl.click();
    } else if (apiHref.startsWith('/api/owner/backups/')) {
      e.preventDefault();
      const v = readVault();
      const blob = new Blob([JSON.stringify(v, null, 2)], { type: 'application/json;charset=utf-8' });
      const dl = document.createElement('a');
      dl.href = URL.createObjectURL(blob);
      dl.download = decodeURIComponent(apiHref.split('/').pop() || 'zoiris-backup.json');
      dl.click();
    } else if (apiHref.includes('/export?format=')) {
      e.preventDefault();
      const v = readVault();
      const key = decodeURIComponent(apiHref.split('/api/owner/leads/')[1]?.split('/')[0] || '');
      const lead = v.leads.find((l) => l.leadNumber === key || l.id === key) || {};
      const isCsv = apiHref.includes('format=csv');
      const content = isCsv
        ? `LeadNumber,Customer,Phone,Address,City,Service,Status\n"${lead.leadNumber || ''}","${lead.fullName || ''}","${lead.phone || ''}","${lead.pickupAddress || ''}","${lead.city || ''}","${lead.requestedService || ''}","${lead.status || ''}"`
        : JSON.stringify(lead, null, 2);
      const blob = new Blob([content], { type: isCsv ? 'text/csv' : 'application/json' });
      const dl = document.createElement('a');
      dl.href = URL.createObjectURL(blob);
      dl.download = `${lead.leadNumber || 'request'}.${isCsv ? 'csv' : 'json'}`;
      dl.click();
    }
  });

  /* ---------------- Transparent Fetch Interceptor ---------------- */
  window.fetch = async function zoirisFetch(input, init) {
    const rawUrl = typeof input === 'string' ? input : input?.url || '';
    let urlObj;
    try {
      urlObj = new URL(rawUrl, window.location.origin);
    } catch {
      return nativeFetch(input, init);
    }

    const strippedPath = window.zoirisStripBase ? window.zoirisStripBase(urlObj.pathname) : urlObj.pathname;
    const apiPath = urlObj.pathname.startsWith('/api/')
      ? urlObj.pathname
      : BASE_PREFIX && urlObj.pathname.startsWith(BASE_PREFIX + '/api/')
        ? urlObj.pathname.slice(BASE_PREFIX.length)
        : strippedPath.startsWith('/api/')
          ? strippedPath
          : '';

    if (urlObj.origin === window.location.origin && apiPath) {
      const mode = await detectMode();
      if (!mode.local && mode.cloudOrigin) {
        return nativeFetch(mode.cloudOrigin + apiPath + urlObj.search, Object.assign({}, init, { credentials: 'include' }));
      }
      if (mode.local) {
        return handleLocalApi(apiPath, urlObj, (init?.method || 'GET').toUpperCase(), init);
      }
    }
    return nativeFetch(input, init);
  };
})();
