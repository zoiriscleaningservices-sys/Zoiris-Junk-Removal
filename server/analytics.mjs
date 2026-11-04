/**
 * server/analytics.mjs
 * Privacy-conscious website traffic aggregation, 5-minute live traffic window,
 * Google Analytics 4 Data API & Google Search Console API connectors, GSC CSV
 * import, location performance rollups, and CSV report exports.
 *
 * Strict measurement separation (Part 8 & Part 17):
 *  - Website visits / sessions / page views  -> `web_events` (`page_view`) or GA4 API
 *  - Google Search impressions & clicks      -> `analytics_snapshots` (`gsc` / `gsc_csv`)
 *  - Telephone click events                  -> `web_events` (`click_to_call`) — NEVER counted as completed calls or leads
 *  - Form starts / upload completions        -> `web_events` (`form_start` / `upload_complete` / `form_complete`)
 *  - Confirmed CRM leads / qualified leads   -> `leads` table
 */
import { createHash, createSign, randomBytes, randomUUID } from 'node:crypto';
import { chicagoDate } from './db.mjs';

const DAILY_SALT_MAP = new Map();

function dailySalt(dayKey) {
  if (!DAILY_SALT_MAP.has(dayKey)) {
    if (DAILY_SALT_MAP.size > 4) DAILY_SALT_MAP.clear();
    DAILY_SALT_MAP.set(dayKey, randomBytes(16).toString('hex'));
  }
  return DAILY_SALT_MAP.get(dayKey);
}

export function computePrivacySafeSessionBucket(clientSessionHint = '', userAgent = '') {
  const day = chicagoDate();
  const salt = dailySalt(day);
  const raw = clientSessionHint ? String(clientSessionHint).slice(0, 64) : String(userAgent).slice(0, 80);
  return createHash('sha256').update(`${day}:${salt}:${raw}`).digest('hex').slice(0, 20);
}

export function classifyChannel({ utmSource = '', utmMedium = '', referrerHost = '' }) {
  const med = utmMedium.toLowerCase();
  const src = utmSource.toLowerCase();
  const ref = referrerHost.toLowerCase();
  if (med.includes('cpc') || med.includes('paid') || med.includes('ppc')) return 'paid_search';
  if (src || med) return `campaign:${src || med}`;
  if (!ref) return 'direct';
  if (/(google\.|bing\.|duckduckgo\.|yahoo\.|ecosia\.)/.test(ref)) return 'organic_search';
  if (/(facebook\.|instagram\.|nextdoor\.|linkedin\.|t\.co|x\.com|youtube\.)/.test(ref)) return 'social';
  return 'referral';
}

export function detectDeviceCategory(explicitDevice = '', userAgent = '') {
  const exp = String(explicitDevice || '').toLowerCase();
  if (['mobile', 'tablet', 'desktop'].includes(exp)) return exp;
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'unknown';
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/.test(ua)) return 'mobile';
  return 'desktop';
}

export function resolveDateWindow(range = '30d', customFrom = '', customTo = '') {
  const now = new Date();
  const todayStr = chicagoDate(now);
  const dayMs = 86400000;

  if (range === 'today') {
    return { range, fromDate: todayStr, toDate: todayStr, fromIso: `${todayStr}T00:00:00.000Z`, toIso: `${todayStr}T23:59:59.999Z` };
  }
  if (range === 'yesterday') {
    const y = chicagoDate(new Date(now.getTime() - dayMs));
    return { range, fromDate: y, toDate: y, fromIso: `${y}T00:00:00.000Z`, toIso: `${y}T23:59:59.999Z` };
  }
  if (range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(customFrom) && /^\d{4}-\d{2}-\d{2}$/.test(customTo)) {
    return {
      range: 'custom',
      fromDate: customFrom,
      toDate: customTo,
      fromIso: `${customFrom}T00:00:00.000Z`,
      toIso: `${customTo}T23:59:59.999Z`
    };
  }
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  const start = chicagoDate(new Date(now.getTime() - (days - 1) * dayMs));
  return {
    range: `${days}d`,
    fromDate: start,
    toDate: todayStr,
    fromIso: `${start}T00:00:00.000Z`,
    toIso: `${todayStr}T23:59:59.999Z`
  };
}

export function createAnalyticsService({ ctx }) {
  const { db } = ctx;

  function recordWebEvent(payload = {}, userAgent = '') {
    const allowed = new Set([
      'page_view',
      'form_start',
      'form_step',
      'upload_complete',
      'form_complete',
      'click_to_call',
      'cta_click'
    ]);
    const eventType = String(payload.eventType || '').trim();
    if (!allowed.has(eventType)) {
      const err = new Error('Unsupported analytics event type.');
      err.status = 400;
      throw err;
    }

    const pagePath = sanitizePath(payload.pagePath || '/');
    if (pagePath.startsWith('/owner') || pagePath.startsWith('/admin')) {
      return { ignored: true };
    }

    let referrerHost = '';
    if (payload.referrer) {
      try {
        const u = new URL(String(payload.referrer));
        referrerHost = u.hostname.slice(0, 120);
      } catch {
        referrerHost = '';
      }
    }

    const utmSource = cleanStr(payload.utmSource, 80);
    const utmMedium = cleanStr(payload.utmMedium, 80);
    const utmCampaign = cleanStr(payload.utmCampaign, 100);
    const channel = classifyChannel({ utmSource, utmMedium, referrerHost });
    const deviceCategory = detectDeviceCategory(payload.deviceCategory, userAgent);
    const sessionBucket = computePrivacySafeSessionBucket(payload.sessionHint || '', userAgent);
    const serviceSlug = cleanStr(payload.serviceSlug || inferServiceSlug(pagePath), 80);
    const locationSlug = cleanStr(payload.locationSlug || inferLocationSlug(pagePath), 80);

    db.prepare(
      `INSERT INTO web_events (
        id, event_type, session_bucket, page_path, landing_path, service_slug, location_slug,
        referrer_host, channel, utm_source, utm_medium, utm_campaign, device_category, is_test_data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      eventType,
      sessionBucket,
      pagePath,
      sanitizePath(payload.landingPath || pagePath),
      serviceSlug,
      locationSlug,
      referrerHost,
      channel,
      utmSource,
      utmMedium,
      utmCampaign,
      deviceCategory,
      payload.isTestData ? 1 : 0,
      new Date().toISOString()
    );

    return { ok: true };
  }

  function getRealtimeTraffic() {
    const windowMinutes = 5;
    const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();

    const activeVisitors = Number(
      db.prepare('SELECT COUNT(DISTINCT session_bucket) AS n FROM web_events WHERE created_at >= ? AND is_test_data = 0').get(cutoff).n
    );
    const activePages = db
      .prepare(
        `SELECT page_path AS pagePath, COUNT(*) AS views, COUNT(DISTINCT session_bucket) AS sessions
         FROM web_events
         WHERE event_type = 'page_view' AND created_at >= ? AND is_test_data = 0
         GROUP BY page_path
         ORDER BY sessions DESC, views DESC
         LIMIT 10`
      )
      .all(cutoff);
    const devices = db
      .prepare(
        `SELECT device_category AS deviceCategory, COUNT(DISTINCT session_bucket) AS sessions
         FROM web_events
         WHERE created_at >= ? AND is_test_data = 0
         GROUP BY device_category`
      )
      .all(cutoff);
    const recentEvents = db
      .prepare(
        `SELECT event_type AS eventType, page_path AS pagePath, device_category AS deviceCategory, channel, created_at AS createdAt
         FROM web_events
         WHERE created_at >= ? AND is_test_data = 0
         ORDER BY created_at DESC
         LIMIT 15`
      )
      .all(cutoff);
    const incomingLeads = db
      .prepare(
        `SELECT id, lead_number AS leadNumber, city, requested_service AS requestedService, source_page_path AS sourcePagePath, created_at AS createdAt
         FROM leads
         WHERE created_at >= ?
         ORDER BY created_at DESC
         LIMIT 10`
      )
      .all(cutoff);

    return {
      reportingWindowMinutes: windowMinutes,
      sourceLabel: 'First-party privacy-safe aggregated events (rolling 5-minute window; no IP addresses or individual visitor tracking)',
      ga4Connected: !!(process.env.GOOGLE_ANALYTICS_PROPERTY_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      activeVisitors,
      activePages,
      devices,
      recentEvents,
      incomingLeads
    };
  }

  function getAnalyticsReport({ range = '30d', from = '', to = '', includeTestData = false } = {}) {
    const win = resolveDateWindow(range, from, to);
    const testClause = includeTestData ? '' : 'AND is_test_data = 0';

    const visitors = Number(
      db
        .prepare(`SELECT COUNT(DISTINCT session_bucket) AS n FROM web_events WHERE event_type = 'page_view' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const sessions = Number(
      db
        .prepare(`SELECT COUNT(DISTINCT session_bucket) AS n FROM web_events WHERE created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const pageViews = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM web_events WHERE event_type = 'page_view' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const formStarts = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM web_events WHERE event_type = 'form_start' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const uploadCompletions = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM web_events WHERE event_type = 'upload_complete' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const formCompletionsEvent = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM web_events WHERE event_type = 'form_complete' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );
    const clickToCallEvents = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM web_events WHERE event_type = 'click_to_call' AND created_at BETWEEN ? AND ? ${testClause}`)
        .get(win.fromIso, win.toIso).n
    );

    // Separate confirmed CRM leads from raw web events!
    const crmFormSubmissions = Number(
      db.prepare('SELECT COUNT(*) AS n FROM leads WHERE created_at BETWEEN ? AND ?').get(win.fromIso, win.toIso).n
    );
    const qualifiedLeads = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at BETWEEN ? AND ? AND status NOT IN ('Spam', 'Not Converted')")
        .get(win.fromIso, win.toIso).n
    );

    const topPages = db
      .prepare(
        `SELECT page_path AS pagePath,
                SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
                COUNT(DISTINCT session_bucket) AS sessions,
                SUM(CASE WHEN event_type = 'click_to_call' THEN 1 ELSE 0 END) AS phoneClicks,
                SUM(CASE WHEN event_type = 'form_start' THEN 1 ELSE 0 END) AS formStarts
         FROM web_events
         WHERE created_at BETWEEN ? AND ? ${testClause}
         GROUP BY page_path
         ORDER BY pageViews DESC, phoneClicks DESC
         LIMIT 25`
      )
      .all(win.fromIso, win.toIso);

    const landingPagesWithLeads = db
      .prepare(
        `SELECT source_page_path AS pagePath,
                COUNT(*) AS formSubmissions,
                SUM(CASE WHEN status NOT IN ('Spam', 'Not Converted') THEN 1 ELSE 0 END) AS qualifiedInquiries
         FROM leads
         WHERE created_at BETWEEN ? AND ? AND source_page_path != ''
         GROUP BY source_page_path
         ORDER BY formSubmissions DESC`
      )
      .all(win.fromIso, win.toIso);

    const landingMap = new Map(landingPagesWithLeads.map((r) => [r.pagePath, r]));
    const enrichedPages = topPages.map((p) => {
      const l = landingMap.get(p.pagePath);
      return {
        ...p,
        crmLeads: l?.formSubmissions || 0,
        qualifiedLeads: l?.qualifiedInquiries || 0
      };
    });

    const trafficSources = db
      .prepare(
        `SELECT channel, COUNT(DISTINCT session_bucket) AS sessions, COUNT(*) AS events
         FROM web_events
         WHERE created_at BETWEEN ? AND ? ${testClause}
         GROUP BY channel
         ORDER BY sessions DESC`
      )
      .all(win.fromIso, win.toIso);

    const referralSources = db
      .prepare(
        `SELECT referrer_host AS referrerHost, COUNT(DISTINCT session_bucket) AS sessions
         FROM web_events
         WHERE referrer_host != '' AND created_at BETWEEN ? AND ? ${testClause}
         GROUP BY referrer_host
         ORDER BY sessions DESC
         LIMIT 15`
      )
      .all(win.fromIso, win.toIso);

    const deviceBreakdown = db
      .prepare(
        `SELECT device_category AS deviceCategory,
                COUNT(DISTINCT session_bucket) AS sessions,
                SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
                SUM(CASE WHEN event_type = 'click_to_call' THEN 1 ELSE 0 END) AS phoneClicks
         FROM web_events
         WHERE created_at BETWEEN ? AND ? ${testClause}
         GROUP BY device_category`
      )
      .all(win.fromIso, win.toIso);

    const dailySeries = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date,
                SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
                COUNT(DISTINCT session_bucket) AS sessions,
                SUM(CASE WHEN event_type = 'click_to_call' THEN 1 ELSE 0 END) AS phoneClicks
         FROM web_events
         WHERE created_at BETWEEN ? AND ? ${testClause}
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date ASC`
      )
      .all(win.fromIso, win.toIso);

    const leadChannels = db
      .prepare(
        `SELECT
           CASE
             WHEN utm_source != '' THEN 'utm:' || utm_source
             WHEN referrer_url != '' THEN 'referral'
             WHEN source_page_path != '' THEN 'direct_or_unattributed_visit'
             ELSE 'unattributed'
           END AS channel,
           COUNT(*) AS leads
         FROM leads
         WHERE created_at BETWEEN ? AND ?
         GROUP BY channel
         ORDER BY leads DESC`
      )
      .all(win.fromIso, win.toIso);

    const conversionRatePct = sessions > 0 ? Number(((crmFormSubmissions / sessions) * 100).toFixed(2)) : null;

    // Pages with traffic (20+ views) and 0 leads/phone clicks -> optimization candidates
    const optimizationCandidates = enrichedPages.filter((p) => p.pageViews >= 10 && p.crmLeads === 0 && p.phoneClicks === 0);

    return {
      window: win,
      source: {
        traffic: 'First-party privacy-safe event telemetry (`web_events`)',
        ga4Status: process.env.GOOGLE_ANALYTICS_PROPERTY_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'connected' : 'unconfigured',
        leads: 'Zoiris CRM (`leads` table — verified persisted submissions)',
        phoneClicksDisclaimer: 'Click-to-call counts measure taps on `tel:+12519308621` links, not completed phone conversations.'
      },
      summary: {
        visitors,
        sessions,
        pageViews,
        formStarts,
        uploadCompletions,
        formCompletionsEvent,
        clickToCallEvents,
        crmFormSubmissions,
        qualifiedLeads,
        conversionRatePct
      },
      topPages: enrichedPages,
      landingPagesWithLeads,
      trafficSources,
      referralSources,
      deviceBreakdown,
      dailySeries,
      leadChannels,
      optimizationCandidates
    };
  }

  function getSearchPerformance({ range = '30d', from = '', to = '', includeTestData = false } = {}) {
    const win = resolveDateWindow(range, from, to);
    const gscConnected = !!(process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const testClause = includeTestData ? '' : 'AND is_test_data = 0';

    const rows = db
      .prepare(
        `SELECT source, snapshot_date AS date, dimension_kind AS kind, dimension_key AS key, secondary_key AS secondaryKey, metrics_json AS metricsJson, is_test_data AS isTestData
         FROM analytics_snapshots
         WHERE source IN ('gsc', 'gsc_csv') AND snapshot_date BETWEEN ? AND ? ${testClause}
         ORDER BY snapshot_date DESC`
      )
      .all(win.fromDate, win.toDate)
      .map((r) => ({ ...r, metrics: JSON.parse(r.metricsJson || '{}') }));

    const queryAgg = new Map();
    const pageAgg = new Map();
    const deviceAgg = new Map();
    const dateAgg = new Map();

    for (const r of rows) {
      const m = r.metrics;
      const imp = Number(m.impressions || 0);
      const clk = Number(m.clicks || 0);
      const pos = Number(m.position || 0);

      const targetMap =
        r.kind === 'query' ? queryAgg : r.kind === 'page' ? pageAgg : r.kind === 'device' ? deviceAgg : r.kind === 'date' ? dateAgg : null;
      if (!targetMap) continue;
      const cur = targetMap.get(r.key) || { key: r.key, impressions: 0, clicks: 0, weightedPos: 0 };
      cur.impressions += imp;
      cur.clicks += clk;
      cur.weightedPos += pos * Math.max(1, imp);
      targetMap.set(r.key, cur);
    }

    const finalize = (map) =>
      [...map.values()]
        .map((x) => ({
          key: x.key,
          impressions: x.impressions,
          clicks: x.clicks,
          ctr: x.impressions > 0 ? Number(((x.clicks / x.impressions) * 100).toFixed(2)) : 0,
          avgPosition: x.impressions > 0 ? Number((x.weightedPos / x.impressions).toFixed(1)) : 0
        }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    const topQueries = finalize(queryAgg);
    const topPages = finalize(pageAgg);
    const byDevice = finalize(deviceAgg);
    const byDate = finalize(dateAgg).sort((a, b) => a.key.localeCompare(b.key));

    const totalImpressions = (topPages.length ? topPages : topQueries).reduce((s, r) => s + r.impressions, 0);
    const totalClicks = (topPages.length ? topPages : topQueries).reduce((s, r) => s + r.clicks, 0);
    const weightedPos = (topPages.length ? topPages : topQueries).reduce((s, r) => s + r.avgPosition * Math.max(1, r.impressions), 0);
    const avgPosition = totalImpressions > 0 ? Number((weightedPos / totalImpressions).toFixed(1)) : null;
    const ctr = totalImpressions > 0 ? Number(((totalClicks / totalImpressions) * 100).toFixed(2)) : null;

    const locationQueries = topQueries.filter((q) =>
      /\b(mobile|baldwin|daphne|fairhope|spanish fort|foley|gulf shores|bay minette|orange beach|spring hill|midtown|prichard|saraland)\b/i.test(
        q.key
      )
    );

    // Search opportunities: queries with impressions >= 20 and position between 5 and 20 or CTR < 3%
    const opportunities = topQueries.filter((q) => q.impressions >= 20 && (q.avgPosition >= 5 || q.ctr < 3)).slice(0, 15);

    const lastSyncRow = db.prepare("SELECT MAX(created_at) AS lastAt FROM analytics_snapshots WHERE source IN ('gsc', 'gsc_csv')").get();

    return {
      window: win,
      connection: {
        status: gscConnected ? 'connected' : 'unconfigured',
        siteProperty: process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY || null,
        lastImportedAt: lastSyncRow?.lastAt || null,
        accuracyNotice:
          'Google Search Console provides aggregated search-performance metrics with a typical 2-to-3 day reporting delay. It never exposes individual visitor search histories. Search impressions and clicks are strictly separate from website visits and CRM form submissions.'
      },
      totals: {
        impressions: totalImpressions,
        clicks: totalClicks,
        ctr,
        avgPosition
      },
      topQueries: topQueries.slice(0, 40),
      topPages: topPages.slice(0, 40),
      locationQueries: locationQueries.slice(0, 25),
      byDevice,
      byDate,
      opportunities
    };
  }

  function importGscCsv({ csvText, snapshotDate = chicagoDate(), dimensionKind = 'query', isTestData = false }) {
    const lines = String(csvText || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      const err = new Error('CSV must include a header row and at least one data row.');
      err.status = 400;
      throw err;
    }
    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const keyIdx = 0;
    const clicksIdx = headers.findIndex((h) => h.includes('click'));
    const impIdx = headers.findIndex((h) => h.includes('impression'));
    const posIdx = headers.findIndex((h) => h.includes('position'));
    if (clicksIdx < 0 || impIdx < 0) {
      const err = new Error('CSV header must contain Clicks and Impressions columns.');
      err.status = 400;
      throw err;
    }

    const ins = db.prepare(
      `INSERT INTO analytics_snapshots (id, source, snapshot_date, dimension_kind, dimension_key, metrics_json, is_test_data, created_at)
       VALUES (?, 'gsc_csv', ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    let imported = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const key = (cols[keyIdx] || '').trim();
      if (!key) continue;
      const clicks = Number(String(cols[clicksIdx] || '0').replace(/[,%]/g, '')) || 0;
      const impressions = Number(String(cols[impIdx] || '0').replace(/[,%]/g, '')) || 0;
      const position = posIdx >= 0 ? Number(String(cols[posIdx] || '0').replace(/[,%]/g, '')) || 0 : 0;
      ins.run(randomUUID(), snapshotDate, dimensionKind, key, JSON.stringify({ clicks, impressions, position }), isTestData ? 1 : 0, now);
      imported++;
    }
    return { imported, snapshotDate, dimensionKind };
  }

  async function syncSearchConsoleApi({ fromDate, toDate }) {
    const siteProp = process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY;
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!siteProp || !saJson) {
      const err = new Error('GOOGLE_SEARCH_CONSOLE_PROPERTY and GOOGLE_SERVICE_ACCOUNT_JSON are required for live API sync.');
      err.status = 400;
      throw err;
    }
    const token = await mintGoogleAccessToken(JSON.parse(saJson), 'https://www.googleapis.com/auth/webmasters.readonly');
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteProp)}/searchAnalytics/query`;

    const ins = db.prepare(
      `INSERT INTO analytics_snapshots (id, source, snapshot_date, dimension_kind, dimension_key, metrics_json, is_test_data, created_at)
       VALUES (?, 'gsc', ?, ?, ?, ?, 0, ?)`
    );
    const now = new Date().toISOString();
    let count = 0;
    for (const [kind, dim] of [
      ['query', 'query'],
      ['page', 'page'],
      ['device', 'device'],
      ['date', 'date']
    ]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: fromDate, endDate: toDate, dimensions: [dim], rowLimit: 250 })
      });
      if (!res.ok) throw new Error(`Search Console API HTTP ${res.status}`);
      const data = await res.json();
      for (const row of data.rows || []) {
        ins.run(
          randomUUID(),
          toDate,
          kind,
          row.keys?.[0] || '',
          JSON.stringify({ clicks: row.clicks || 0, impressions: row.impressions || 0, position: row.position || 0 }),
          now
        );
        count++;
      }
    }
    db.prepare("UPDATE integrations SET status = 'connected', last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = 'gsc'").run(now, now);
    return { syncedRows: count };
  }

  function getLocationPerformance({ includeTestData = false } = {}) {
    const municipalities = db.prepare('SELECT * FROM municipalities ORDER BY county_id, name').all();
    const neighborhoods = db.prepare('SELECT * FROM neighborhoods ORDER BY name').all();
    const pages = db.prepare('SELECT * FROM page_registry').all();
    const leads = db.prepare('SELECT id, city, location_slug, neighborhood_slug, requested_service, status FROM leads').all();
    const phoneClicks = db
      .prepare(
        `SELECT location_slug, page_path, COUNT(*) AS clicks
         FROM web_events
         WHERE event_type = 'click_to_call' ${includeTestData ? '' : 'AND is_test_data = 0'}
         GROUP BY location_slug, page_path`
      )
      .all();
    const gscPageRows = db
      .prepare(
        `SELECT dimension_key AS url, metrics_json
         FROM analytics_snapshots
         WHERE source IN ('gsc', 'gsc_csv') AND dimension_kind = 'page' ${includeTestData ? '' : 'AND is_test_data = 0'}`
      )
      .all();

    return municipalities.map((m) => {
      const areaPages = pages.filter((p) => p.location_id === m.id || (m.id === 'mobile-al' && p.status === 'published' && !p.location_id));
      const publishedPages = areaPages.filter((p) => p.status === 'published').length;
      const draftPages = areaPages.filter((p) => p.status !== 'published' && p.status !== 'archived').length;
      const seoIssues = areaPages.filter((p) => p.status === 'published' && !p.passes_gate).length;

      const areaLeads = leads.filter(
        (l) => l.location_slug === m.id || String(l.city || '').toLowerCase() === String(m.name || '').toLowerCase()
      );
      const completedJobs = areaLeads.filter((l) => l.status === 'Completed').length;

      const svcCounts = new Map();
      for (const l of areaLeads) {
        svcCounts.set(l.requested_service, (svcCounts.get(l.requested_service) || 0) + 1);
      }
      const topServices = [...svcCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([service, count]) => ({ service, count }));

      const areaPaths = new Set(areaPages.map((p) => p.path));
      let telClicks = 0;
      for (const pc of phoneClicks) {
        if (pc.location_slug === m.id || areaPaths.has(pc.page_path)) telClicks += Number(pc.clicks || 0);
      }

      let searchImpressions = 0;
      let searchClicks = 0;
      for (const g of gscPageRows) {
        try {
          const parsedPath = g.url.startsWith('http') ? new URL(g.url).pathname : g.url;
          if (areaPaths.has(parsedPath) || parsedPath.includes(`/areas/${m.id}/`)) {
            const met = JSON.parse(g.metricsJson || '{}');
            searchImpressions += Number(met.impressions || 0);
            searchClicks += Number(met.clicks || 0);
          }
        } catch {
          // ignore malformed URL
        }
      }

      return {
        id: m.id,
        name: m.name,
        countyId: m.county_id,
        classification: m.classification,
        coverageStatus: m.coverage_status,
        publishedPages,
        draftPages,
        searchImpressions,
        searchClicks,
        telephoneClicks: telClicks,
        formSubmissions: areaLeads.length,
        completedJobs,
        topServices,
        seoIssues,
        childNeighborhoodCount: neighborhoods.filter((n) => n.municipality_id === m.id).length
      };
    });
  }

  return {
    recordWebEvent,
    getRealtimeTraffic,
    getAnalyticsReport,
    getSearchPerformance,
    importGscCsv,
    syncSearchConsoleApi,
    getLocationPerformance
  };
}

function sanitizePath(raw = '/') {
  const s = String(raw || '/').split('?')[0].split('#')[0].trim();
  if (!s.startsWith('/')) return '/' + s.slice(0, 160);
  return s.slice(0, 160);
}

function cleanStr(v, max = 100) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function inferServiceSlug(path) {
  const m = path.match(/^\/(services|e-waste|items)\/([^/]+)\//);
  if (m) return m[2];
  if (path === '/junk-removal-mobile-al/') return 'junk-removal-mobile-al';
  return '';
}

function inferLocationSlug(path) {
  const m = path.match(/^\/areas\/([^/]+)\//);
  return m ? m[1] : '';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function mintGoogleAccessToken(serviceAccount, scope) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp
    })
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(serviceAccount.private_key, 'base64url');
  const assertion = `${header}.${claim}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });
  if (!res.ok) throw new Error(`Google OAuth token exchange failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.access_token;
}
