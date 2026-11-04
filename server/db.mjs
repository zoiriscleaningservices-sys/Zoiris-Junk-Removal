/**
 * server/db.mjs
 * Relational SQLite database manager for Zoiris Command Center.
 * Uses Node 24's built-in `node:sqlite` (DatabaseSync) in WAL mode.
 *
 * Private vault directory defaults to `<ROOT>/.zoiris-private` (outside `dist/`
 * and `public/`), overrideable via `ZOIRIS_DATA_DIR` for isolated testing.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadData, writeJson, entityFile } from '../scripts/lib/load-data.mjs';
import { auditSite } from '../src/lib/audit.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(HERE, '..');

export function resolveVaultPaths(customDataDir = process.env.ZOIRIS_DATA_DIR) {
  const baseDir = resolve(customDataDir || join(ROOT_DIR, '.zoiris-private'));
  const dbDir = join(baseDir, 'db');
  const mediaDir = join(baseDir, 'media');
  const originalsDir = join(mediaDir, 'originals');
  const previewsDir = join(mediaDir, 'previews');
  const tempDir = join(mediaDir, 'temp');
  const backupsDir = join(baseDir, 'backups');
  const secretFile = join(baseDir, 'server-secret.key');
  for (const d of [baseDir, dbDir, mediaDir, originalsDir, previewsDir, tempDir, backupsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return {
    baseDir,
    dbFile: join(dbDir, 'zoiris-crm.sqlite'),
    mediaDir,
    originalsDir,
    previewsDir,
    tempDir,
    backupsDir,
    secretFile
  };
}

export const DEFAULT_SETTINGS = {
  timezone: 'America/Chicago',
  max_photos: 12,
  max_videos: 3,
  max_photo_bytes: 15 * 1024 * 1024, // 15 MB
  max_video_bytes: 100 * 1024 * 1024, // 100 MB
  preserve_original_uploads: true,
  storage_quota_bytes: 1024 * 1024 * 1024, // 1 GB initial tier (configurable)
  db_quota_bytes: 500 * 1024 * 1024, // 500 MB initial tier (configurable)
  egress_quota_bytes: 5 * 1024 * 1024 * 1024, // 5 GB monthly egress reference
  monthly_egress_bytes: 0,
  egress_period: new Date().toISOString().slice(0, 7),
  quota_warn_70: 70,
  quota_warn_85: 85,
  quota_warn_95: 95,
  session_idle_minutes: 480,
  signed_url_ttl_seconds: 300,
  upload_session_ttl_minutes: 45,
  retention_days_abandoned_uploads: 1,
  business_phone: '251-930-8621'
};

export function chicagoYear(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(date);
}

export function chicagoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function normalizeCoverage(raw) {
  if (!raw) return 'research-only';
  if (raw === 'verified' || raw === 'active') return 'active';
  if (raw === 'candidate' || raw === 'research-only') return 'research-only';
  if (raw === 'not-served' || raw === 'not-serviced') return 'not-serviced';
  if (['available-on-confirmation', 'limited', 'temporarily-unavailable'].includes(raw)) return raw;
  return 'research-only';
}

export function openZoirisDb(customDataDir = process.env.ZOIRIS_DATA_DIR) {
  const paths = resolveVaultPaths(customDataDir);
  const db = new DatabaseSync(paths.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const migrationSql = readFileSync(join(HERE, 'migrations', '001_initial.sql'), 'utf8');
  db.exec(migrationSql);

  // 002 — verified address geodata + spam screening (idempotent column adds for existing vaults)
  const leadCols = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));
  const addLeadCol = (name, ddl) => {
    if (!leadCols.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`);
  };
  addLeadCol('address_unit', "TEXT NOT NULL DEFAULT ''");
  addLeadCol('address_status', "TEXT NOT NULL DEFAULT 'unverified'");
  addLeadCol('address_source', "TEXT NOT NULL DEFAULT ''");
  addLeadCol('matched_address', "TEXT NOT NULL DEFAULT ''");
  addLeadCol('geo_lat', 'REAL');
  addLeadCol('geo_lng', 'REAL');
  addLeadCol('county_fips', "TEXT NOT NULL DEFAULT ''");
  addLeadCol('county_name', "TEXT NOT NULL DEFAULT ''");
  addLeadCol('spam_score', 'INTEGER NOT NULL DEFAULT 0');
  addLeadCol('spam_flags_json', "TEXT NOT NULL DEFAULT '[]'");

  // 003 — multi-device persistent sessions & human-friendly device tracking
  const sessCols = new Set(db.prepare('PRAGMA table_info(owner_sessions)').all().map((c) => c.name));
  const addSessCol = (name, ddl) => {
    if (!sessCols.has(name)) db.exec(`ALTER TABLE owner_sessions ADD COLUMN ${name} ${ddl}`);
  };
  addSessCol('device_label', "TEXT NOT NULL DEFAULT ''");
  addSessCol('device_kind', "TEXT NOT NULL DEFAULT 'desktop'");
  addSessCol('remember_device', 'INTEGER NOT NULL DEFAULT 1');

  const now = new Date().toISOString();

  // Seed default business settings without overwriting owner edits
  const insSetting = db.prepare(
    'INSERT OR IGNORE INTO business_settings (key, value_json, updated_at) VALUES (?, ?, ?)'
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insSetting.run(k, JSON.stringify(v), now);
  }

  // Seed integrations status honestly from current environment variables
  seedIntegrations(db, now);

  // Sync structured geography, pages, and keywords from src/data/
  syncContentToDb(db);

  function getSettings() {
    const rows = db.prepare('SELECT key, value_json FROM business_settings').all();
    const out = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        out[r.key] = r.value_json;
      }
    }
    // Roll monthly egress period automatically when calendar month advances
    const curPeriod = new Date().toISOString().slice(0, 7);
    if (out.egress_period !== curPeriod) {
      setSetting('egress_period', curPeriod, null);
      setSetting('monthly_egress_bytes', 0, null);
      out.egress_period = curPeriod;
      out.monthly_egress_bytes = 0;
    }
    return out;
  }

  function setSetting(key, value, ownerId = null) {
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO business_settings (key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value), ownerId, ts);
  }

  function nextLeadNumber() {
    const res = db.prepare('INSERT INTO lead_seq DEFAULT VALUES').run();
    const seq = Number(res.lastInsertRowid);
    return `ZJ-${chicagoYear()}-${String(seq).padStart(6, '0')}`;
  }

  function logAudit({ actorId = null, actorEmail = null, action, entityType, entityId = null, metadata = {} }) {
    db.prepare(
      `INSERT INTO admin_audit_logs (id, actor_id, actor_email, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), actorId, actorEmail, action, entityType, entityId, JSON.stringify(metadata), new Date().toISOString());
  }

  function dbSizeBytes() {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = paths.dbFile + suffix;
      if (existsSync(f)) {
        try {
          total += statSync(f).size;
        } catch {
          // ignore transient WAL stat race
        }
      }
    }
    return total;
  }

  function checkpointDatabase() {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore if another statement is active
    }
  }

  function compactDatabase() {
    const beforeBytes = dbSizeBytes();
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.exec('VACUUM;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      checkpointDatabase();
    }
    const afterBytes = dbSizeBytes();
    return {
      beforeBytes,
      afterBytes,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes)
    };
  }

  function updateCoverage({ entityKind, id, coverageStatus, pickupNotes, owner }) {
    const valid = [
      'active',
      'available-on-confirmation',
      'limited',
      'temporarily-unavailable',
      'not-serviced',
      'research-only'
    ];
    if (!valid.includes(coverageStatus)) {
      throw new Error(`Invalid coverage status: ${coverageStatus}`);
    }
    const ts = new Date().toISOString();
    if (entityKind === 'county') {
      db.prepare('UPDATE counties SET coverage_status = ?, updated_at = ? WHERE id = ?').run(coverageStatus, ts, id);
      db.prepare('UPDATE service_areas SET coverage_status = ?, updated_by = ?, updated_at = ? WHERE entity_kind = ? AND entity_id = ?').run(
        coverageStatus,
        owner?.id || null,
        ts,
        'county',
        id
      );
      if (process.env.ZOIRIS_SYNC_JSON !== '0') {
        const data = loadData();
        if (Array.isArray(data.counties)) {
          const c = data.counties.find((x) => x.id === id);
          if (c) {
            c.coverage = coverageStatus;
            writeJson(entityFile('counties'), data.counties);
          }
        }
      }
    } else if (entityKind === 'municipality') {
      db.prepare('UPDATE municipalities SET coverage_status = ?, pickup_notes = COALESCE(?, pickup_notes), updated_at = ? WHERE id = ?').run(
        coverageStatus,
        pickupNotes ?? null,
        ts,
        id
      );
      db.prepare('UPDATE service_areas SET coverage_status = ?, updated_by = ?, updated_at = ? WHERE entity_kind = ? AND entity_id = ?').run(
        coverageStatus,
        owner?.id || null,
        ts,
        'municipality',
        id
      );
      if (process.env.ZOIRIS_SYNC_JSON !== '0') {
        const data = loadData();
        const loc = data.locations.find((x) => x.id === id);
        if (loc) {
          loc.coverage = coverageStatus;
          if (typeof pickupNotes === 'string') loc.pickupNotes = pickupNotes;
          writeJson(entityFile('locations'), data.locations);
        }
      }
    } else if (entityKind === 'neighborhood') {
      db.prepare('UPDATE neighborhoods SET coverage_status = ?, pickup_notes = COALESCE(?, pickup_notes), updated_at = ? WHERE id = ?').run(
        coverageStatus,
        pickupNotes ?? null,
        ts,
        id
      );
      db.prepare('UPDATE service_areas SET coverage_status = ?, updated_by = ?, updated_at = ? WHERE entity_kind = ? AND entity_id = ?').run(
        coverageStatus,
        owner?.id || null,
        ts,
        'neighborhood',
        id
      );
      if (process.env.ZOIRIS_SYNC_JSON !== '0') {
        const data = loadData();
        const nb = data.neighborhoods.find((x) => x.id === id);
        if (nb) {
          nb.coverage = coverageStatus;
          if (typeof pickupNotes === 'string') nb.pickupNotes = pickupNotes;
          writeJson(entityFile('neighborhoods'), data.neighborhoods);
        }
      }
    } else {
      throw new Error(`Unsupported entityKind: ${entityKind}`);
    }
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'location.coverage_updated',
      entityType: entityKind,
      entityId: id,
      metadata: { coverageStatus }
    });
  }

  return {
    db,
    paths,
    getSettings,
    setSetting,
    nextLeadNumber,
    logAudit,
    dbSizeBytes,
    checkpointDatabase,
    compactDatabase,
    syncContentToDb: () => syncContentToDb(db),
    seedIntegrations: () => seedIntegrations(db, new Date().toISOString()),
    updateCoverage,
    close: () => db.close()
  };
}

export function seedIntegrations(db, now = new Date().toISOString()) {
  const ga4Connected = !!(process.env.GOOGLE_ANALYTICS_PROPERTY_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const gscConnected = !!(process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const emailConnected = !!(process.env.EMAIL_PROVIDER_API_KEY && process.env.EMAIL_NOTIFICATION_ADDRESS);
  const smsConnected = !!(process.env.SMS_TWILIO_ACCOUNT_SID && process.env.SMS_TWILIO_AUTH_TOKEN && process.env.SMS_TWILIO_FROM && process.env.SMS_NOTIFICATION_TO);
  const storageProvider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();

  const items = [
    {
      id: 'ga4',
      name: 'Google Analytics 4 Data API',
      kind: 'analytics',
      status: ga4Connected ? 'connected' : 'unconfigured',
      summary: {
        propertyId: process.env.GOOGLE_ANALYTICS_PROPERTY_ID || null,
        publicMeasurementId: process.env.PUBLIC_GA4_ID || null,
        note: ga4Connected ? 'GA4 Data API credentials configured.' : 'Awaiting GOOGLE_ANALYTICS_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_JSON.'
      }
    },
    {
      id: 'gsc',
      name: 'Google Search Console API',
      kind: 'seo',
      status: gscConnected ? 'connected' : 'unconfigured',
      summary: {
        siteProperty: process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY || null,
        csvImportSupported: true,
        note: gscConnected ? 'Search Console API credentials configured.' : 'Awaiting GOOGLE_SEARCH_CONSOLE_PROPERTY and GOOGLE_SERVICE_ACCOUNT_JSON (CSV import available anytime).'
      }
    },
    {
      id: 'email',
      name: 'Owner Email Alerts',
      kind: 'notification',
      status: emailConnected ? 'connected' : 'unconfigured',
      summary: {
        provider: process.env.EMAIL_PROVIDER || 'resend',
        recipient: process.env.EMAIL_NOTIFICATION_ADDRESS || null,
        note: emailConnected ? 'Email provider configured.' : 'In-dashboard real-time notifications active. Set EMAIL_PROVIDER_API_KEY + EMAIL_NOTIFICATION_ADDRESS for email alerts.'
      }
    },
    {
      id: 'sms',
      name: 'Owner SMS Alerts',
      kind: 'notification',
      status: smsConnected ? 'connected' : 'unconfigured',
      summary: {
        provider: 'twilio',
        note: smsConnected ? 'SMS provider configured.' : 'Optional SMS alerts unconfigured (set SMS_TWILIO_* env vars to enable).'
      }
    },
    {
      id: 'storage',
      name: 'Private Customer Media Vault',
      kind: 'storage',
      status: 'connected',
      summary: {
        provider: storageProvider,
        bucket: process.env.STORAGE_BUCKET || 'customer-media',
        r2Ready: true,
        supabaseReady: true
      }
    }
  ];

  const stmt = db.prepare(
    `INSERT INTO integrations (id, name, kind, status, config_summary_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       status = excluded.status,
       config_summary_json = excluded.config_summary_json,
       updated_at = excluded.updated_at`
  );
  for (const it of items) {
    stmt.run(it.id, it.name, it.kind, it.status, JSON.stringify(it.summary), now);
  }
}

export function syncContentToDb(db) {
  const data = loadData();
  const audit = auditSite(data);
  const ts = new Date().toISOString();

  const defaultCounties = Array.isArray(data.counties) && data.counties.length
    ? data.counties
    : [
        {
          id: 'mobile-county-al',
          name: 'Mobile County',
          state: 'AL',
          seat: 'Mobile',
          coverage: 'limited',
          pageId: 'loc-mobile-county-al',
          geoReference: 'Southwest Alabama Gulf Coast; I-10, I-65, US-90, US-98, US-43, US-45.',
          solidWasteNotes: 'City of Mobile operates municipal bulk/drop-off rules inside city limits; unincorporated areas rely on Mobile County solid waste / private haulers.',
          source: 'https://www.mobilecountyal.gov/',
          lastVerifiedAt: '2026-11-04'
        },
        {
          id: 'baldwin-county-al',
          name: 'Baldwin County',
          state: 'AL',
          seat: 'Bay Minette',
          coverage: 'research-only',
          pageId: 'loc-baldwin-county-al',
          geoReference: 'East of Mobile Bay across I-10 Bayway & Causeway; Eastern Shore, North Baldwin, Central Baldwin, and Pleasure Island.',
          solidWasteNotes: 'Baldwin County Solid Waste operates Magnolia Landfill & county drop-off sites; incorporated municipalities run separate trash/bulk programs.',
          source: 'https://baldwincountyal.gov/municipalities',
          lastVerifiedAt: '2026-11-04'
        }
      ];

  const upCounty = db.prepare(
    `INSERT INTO counties (id, name, state, seat, coverage_status, page_id, geo_reference, solid_waste_notes, source_url, last_verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       seat = excluded.seat,
       coverage_status = excluded.coverage_status,
       page_id = excluded.page_id,
       geo_reference = excluded.geo_reference,
       solid_waste_notes = excluded.solid_waste_notes,
       source_url = excluded.source_url,
       last_verified_at = excluded.last_verified_at,
       updated_at = excluded.updated_at`
  );
  for (const c of defaultCounties) {
    upCounty.run(
      c.id,
      c.name,
      c.state || 'AL',
      c.seat || '',
      normalizeCoverage(c.coverage),
      c.pageId || null,
      c.geoReference || '',
      c.solidWasteNotes || '',
      c.source || '',
      c.lastVerifiedAt || '2026-11-04',
      ts
    );
  }

  const allServiceIds = data.services.filter((s) => s.verification === 'confirmed' || s.verification === 'category-confirmed').map((s) => s.id);
  const upArea = db.prepare(
    `INSERT INTO service_areas (id, entity_kind, entity_id, name, county_id, coverage_status, services_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       county_id = excluded.county_id,
       coverage_status = excluded.coverage_status,
       services_json = excluded.services_json,
       updated_at = excluded.updated_at`
  );
  for (const c of defaultCounties) {
    const cov = normalizeCoverage(c.coverage);
    upArea.run(`county:${c.id}`, 'county', c.id, c.name, c.id, cov, JSON.stringify(cov === 'active' ? allServiceIds : []), ts);
  }

  const upMuni = db.prepare(
    `INSERT INTO municipalities (id, name, state, county_id, classification, coverage_status, zip_codes_json, parent_area_id, geo_reference, pickup_notes, page_id, source_url, last_verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       county_id = excluded.county_id,
       classification = excluded.classification,
       coverage_status = excluded.coverage_status,
       zip_codes_json = excluded.zip_codes_json,
       parent_area_id = excluded.parent_area_id,
       geo_reference = excluded.geo_reference,
       pickup_notes = excluded.pickup_notes,
       page_id = excluded.page_id,
       source_url = excluded.source_url,
       last_verified_at = excluded.last_verified_at,
       updated_at = excluded.updated_at`
  );
  for (const l of data.locations) {
    const countyId = l.countyId || (String(l.county).toLowerCase().includes('baldwin') ? 'baldwin-county-al' : 'mobile-county-al');
    const classification = l.classification || (l.kind === 'city' ? 'incorporated-municipality' : 'unincorporated-area');
    const cov = normalizeCoverage(l.coverage);
    upMuni.run(
      l.id,
      l.name,
      l.state || 'AL',
      countyId,
      classification,
      cov,
      JSON.stringify(l.zipCodes || []),
      l.parentAreaId || countyId,
      l.geoReference || '',
      l.pickupNotes || l.notes || '',
      l.pageId || null,
      l.source || '',
      l.lastVerifiedAt || '2026-11-04',
      ts
    );
    upArea.run(
      `municipality:${l.id}`,
      'municipality',
      l.id,
      `${l.name}, ${l.state || 'AL'}`,
      countyId,
      cov,
      JSON.stringify(cov === 'active' ? allServiceIds : []),
      ts
    );
  }

  const upNb = db.prepare(
    `INSERT INTO neighborhoods (id, name, municipality_id, county_id, classification, coverage_status, zip_codes_json, geo_reference, pickup_notes, local_evidence_json, page_id, source_url, last_verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       municipality_id = excluded.municipality_id,
       county_id = excluded.county_id,
       classification = excluded.classification,
       coverage_status = excluded.coverage_status,
       zip_codes_json = excluded.zip_codes_json,
       geo_reference = excluded.geo_reference,
       pickup_notes = excluded.pickup_notes,
       local_evidence_json = excluded.local_evidence_json,
       page_id = excluded.page_id,
       source_url = excluded.source_url,
       last_verified_at = excluded.last_verified_at,
       updated_at = excluded.updated_at`
  );
  for (const n of data.neighborhoods) {
    const countyId = n.countyId || 'mobile-county-al';
    const classification = n.classification || 'recognized-community';
    const cov = normalizeCoverage(n.coverage);
    upNb.run(
      n.id,
      n.name,
      n.cityId || 'mobile-al',
      countyId,
      classification,
      cov,
      JSON.stringify(n.zipCodes || []),
      n.geoReference || n.description || '',
      n.pickupNotes || n.notes || '',
      JSON.stringify(n.localEvidence || []),
      n.pageId || null,
      n.source || '',
      n.lastVerifiedAt || '2026-11-04',
      ts
    );
    upArea.run(
      `neighborhood:${n.id}`,
      'neighborhood',
      n.id,
      n.name,
      countyId,
      cov,
      JSON.stringify(cov === 'active' ? allServiceIds : []),
      ts
    );
  }

  const upPage = db.prepare(
    `INSERT INTO page_registry (id, page_type, path, status, title, primary_keyword, service_id, location_id, neighborhood_id, county_id, robots_index, quality_score, passes_gate, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       page_type = excluded.page_type,
       path = excluded.path,
       status = excluded.status,
       title = excluded.title,
       primary_keyword = excluded.primary_keyword,
       service_id = excluded.service_id,
       location_id = excluded.location_id,
       neighborhood_id = excluded.neighborhood_id,
       county_id = excluded.county_id,
       robots_index = excluded.robots_index,
       quality_score = excluded.quality_score,
       passes_gate = excluded.passes_gate,
       updated_at = excluded.updated_at`
  );
  const indexableSet = new Set(audit.indexable);
  for (const p of data.pages) {
    const r = audit.reports[p.id];
    upPage.run(
      p.id,
      p.type,
      p.path,
      p.status,
      p.seo.title,
      p.seo.primaryKeyword || '',
      p.refs.serviceId || null,
      p.refs.locationId || null,
      p.refs.neighborhoodId || null,
      p.refs.countyId || null,
      indexableSet.has(p.id) ? 1 : 0,
      r?.score ?? 0,
      r?.passesGate ? 1 : 0,
      ts
    );
  }

  const upKw = db.prepare(
    `INSERT INTO keyword_records (id, keyword, intent, role, target_page_id, location_relevance, priority, impressions, clicks, ctr, avg_position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       keyword = excluded.keyword,
       intent = excluded.intent,
       role = excluded.role,
       target_page_id = excluded.target_page_id,
       location_relevance = excluded.location_relevance,
       priority = excluded.priority,
       impressions = COALESCE(excluded.impressions, keyword_records.impressions),
       clicks = COALESCE(excluded.clicks, keyword_records.clicks),
       ctr = COALESCE(excluded.ctr, keyword_records.ctr),
       avg_position = COALESCE(excluded.avg_position, keyword_records.avg_position),
       updated_at = excluded.updated_at`
  );
  for (const k of data.keywords) {
    upKw.run(
      k.id,
      k.keyword,
      k.intent,
      k.role,
      k.targetPageId || null,
      k.locationRelevance || '',
      k.priority || 'medium',
      k.performance?.impressions ?? null,
      k.performance?.clicks ?? null,
      k.performance?.ctr ?? null,
      k.performance?.position ?? null,
      ts
    );
  }
}

export function getOrCreateServerSecret(secretFile) {
  if (process.env.ZOIRIS_SERVER_SECRET && process.env.ZOIRIS_SERVER_SECRET.length >= 32) {
    return Buffer.from(process.env.ZOIRIS_SERVER_SECRET, 'utf8').subarray(0, 32);
  }
  if (existsSync(secretFile)) {
    const raw = readFileSync(secretFile, 'utf8').trim();
    if (raw.length >= 64) return Buffer.from(raw, 'hex').subarray(0, 32);
  }
  const key = randomBytes(32);
  writeJsonKey(secretFile, key.toString('hex'));
  return key;
}

function writeJsonKey(file, hex) {
  mkdirSync(dirname(file), { recursive: true });
  import('node:fs').then(({ writeFileSync }) => {
    try {
      writeFileSync(file, hex + '\n', { mode: 0o600 });
    } catch {
      // ignore if written synchronously below
    }
  });
}
