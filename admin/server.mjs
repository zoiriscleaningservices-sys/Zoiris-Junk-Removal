#!/usr/bin/env node
/**
 * Zoiris SEO Operations Dashboard — local server.
 *
 * - Runs ONLY on your machine (binds to 127.0.0.1). It is not part of the static
 *   build and must never be deployed.
 * - Reads and writes the structured content in src/data/ (JSON). The static site
 *   is regenerated from those files by `npm run build`.
 * - Shares the exact quality gate / audit / matrix logic used by the build
 *   (src/lib/*.ts, loaded via Node's built-in TypeScript type stripping).
 *
 * Security: host-header allowlist (DNS-rebinding guard), a required custom
 * header on every mutating request (CSRF guard), optional ADMIN_TOKEN.
 *
 * Usage: npm run admin   →   http://127.0.0.1:4400
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, loadData, savePage, deletePage, entityFile, writeJson, ENTITY_KEYS } from '../scripts/lib/load-data.mjs';
import { auditSite } from '../src/lib/audit.ts';
import { proposeCandidates, candidateToRecord } from '../src/lib/matrix.ts';
import { evaluatePage, buildShingleIndex, similarity } from '../src/lib/page-quality.ts';
import { CANONICAL_PATH_RE, normalizeKeyword } from '../src/lib/format.ts';
import { inboundLinks } from '../src/lib/internal-links.ts';

const PORT = Number(process.env.ADMIN_PORT || 4400);
const HOST = '127.0.0.1';
const TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = join(ROOT, 'admin', 'public');
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Workflow rules                                                      */
/* ------------------------------------------------------------------ */
const TRANSITIONS = {
  idea: ['research', 'draft', 'archived'],
  research: ['idea', 'draft', 'archived'],
  draft: ['research', 'needs-review', 'archived'],
  'needs-review': ['draft', 'approved', 'archived'],
  approved: ['needs-review', 'draft', 'published', 'noindex', 'archived'],
  published: ['noindex', 'needs-review', 'archived'],
  noindex: ['published', 'needs-review', 'archived'],
  archived: ['draft']
};

function transition(page, to, by, note, data) {
  const from = page.status;
  if (!TRANSITIONS[from]?.includes(to)) throw httpError(400, `Transition ${from} → ${to} is not allowed.`);
  if (!by || !by.trim()) throw httpError(400, 'Reviewer name is required for workflow changes.');
  const next = structuredClone(page);
  if (to === 'approved') {
    next.workflow.approvedBy = by.trim();
    next.workflow.approvedAt = today();
    const report = evaluatePage(next, { data: withPage(data, next) });
    if (!report.passesGate) {
      throw httpError(422, `Cannot approve: ${report.blockers.map((b) => `${b.label}${b.detail ? ' (' + b.detail + ')' : ''}`).join('; ')}`);
    }
  }
  if (to === 'published' || (to === 'noindex' && from === 'approved')) {
    if (!next.workflow.approvedBy) throw httpError(422, 'Page must be approved before publishing.');
  }
  if (to === 'published') {
    const report = evaluatePage({ ...next, status: 'published' }, { data: withPage(data, { ...next, status: 'published' }) });
    if (!report.passesGate) throw httpError(422, `Publishing blocked: ${report.blockers.map((b) => b.label).join('; ')}`);
  }
  if (['draft', 'research', 'idea', 'needs-review'].includes(to) && from !== 'needs-review') {
    // Content changes after approval require re-approval.
    next.workflow.approvedBy = null;
    next.workflow.approvedAt = null;
  }
  next.status = to;
  next.workflow.updatedAt = today();
  next.workflow.history = [...(next.workflow.history ?? []), { at: new Date().toISOString(), from, to, by: by.trim(), ...(note ? { note } : {}) }];
  return next;
}

function withPage(data, page) {
  return { ...data, pages: data.pages.map((p) => (p.id === page.id ? page : p)) };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
function validatePageShape(p) {
  const errors = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.id ?? '')) errors.push('id must be lowercase kebab-case.');
  if (!CANONICAL_PATH_RE.test(p.path ?? '')) errors.push('path must be lowercase with leading and trailing slashes.');
  if (!['core', 'service', 'ewaste', 'item', 'location', 'neighborhood', 'combo', 'article'].includes(p.type)) errors.push('invalid type.');
  if (!TRANSITIONS[p.status]) errors.push('invalid status.');
  if (!p.seo || typeof p.seo !== 'object') errors.push('seo object required.');
  if (!p.workflow || typeof p.workflow !== 'object') errors.push('workflow object required.');
  if (!p.breadcrumb || typeof p.breadcrumb.label !== 'string') errors.push('breadcrumb.label required.');
  if (!Array.isArray(p.related)) errors.push('related must be an array.');
  if (p.content && !Array.isArray(p.content.faqs)) errors.push('content.faqs must be an array.');
  return errors;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 5_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request too large.');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'Invalid JSON body.');
  }
}

function summarize(data) {
  const audit = auditSite(data);
  const inbound = inboundLinks(data);
  const pages = data.pages.map((p) => {
    const r = audit.reports[p.id];
    return {
      id: p.id,
      path: p.path,
      type: p.type,
      status: p.status,
      title: p.seo.title,
      primaryKeyword: p.seo.primaryKeyword,
      score: r.score,
      passesGate: r.passesGate,
      blockers: r.blockers.map((b) => ({ id: b.id, label: b.label, detail: b.detail })),
      warnings: r.warnings.map((w) => ({ id: w.id, label: w.label, detail: w.detail })),
      indexable: audit.indexable.includes(p.id),
      wordCount: r.wordCount,
      maxSimilarity: r.maxSimilarity,
      inbound: inbound.get(p.id)?.size ?? 0,
      hasContent: !!p.content,
      ownerVerification: p.workflow.ownerVerification ?? [],
      updatedAt: p.workflow.updatedAt
    };
  });
  return { counts: audit.counts, issues: audit.issues, pages, generatedAt: audit.generatedAt };
}

function runScript(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, output: out.slice(-60000) }));
  });
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
async function handle(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'Forbidden host.' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    const file = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '');
    if (file === 'favicon.svg') return send(res, 200, readFileSync(join(ROOT, 'public', 'favicon.svg')), MIME['.svg']);
    const full = join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, readFileSync(full), MIME[extname(full)] ?? 'application/octet-stream');
  }

  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Admin token required.' });
  const mutating = req.method !== 'GET';
  if (mutating && req.headers['x-zoiris-admin'] !== '1') return send(res, 403, { error: 'Missing admin header.' });

  const data = loadData();
  const m = (re) => path.match(re);

  // State
  if (req.method === 'GET' && path === '/api/state') {
    return send(res, 200, { data, summary: summarize(data), transitions: TRANSITIONS, entityKeys: ENTITY_KEYS });
  }
  if (req.method === 'GET' && (m(/^\/api\/pages\/([a-z0-9-]+)\/quality$/))) {
    const id = m(/^\/api\/pages\/([a-z0-9-]+)\/quality$/)[1];
    const page = data.pages.find((p) => p.id === id);
    if (!page) throw httpError(404, 'Page not found.');
    return send(res, 200, evaluatePage(page, { data }));
  }

  // Create page
  if (req.method === 'POST' && path === '/api/pages') {
    const body = await readBody(req);
    const page = body.page;
    const errors = validatePageShape(page ?? {});
    if (errors.length) throw httpError(400, errors.join(' '));
    if (data.pages.some((p) => p.id === page.id)) throw httpError(409, `Page id ${page.id} already exists.`);
    if (data.pages.some((p) => p.path === page.path)) throw httpError(409, `Path ${page.path} is already used.`);
    if (!['idea', 'research', 'draft'].includes(page.status)) throw httpError(400, 'New pages must start as idea, research, or draft.');
    page.workflow = { ...page.workflow, createdAt: today(), updatedAt: today(), approvedBy: null, approvedAt: null, history: [{ at: new Date().toISOString(), from: page.status, to: page.status, by: body.by || 'dashboard', note: 'Created' }] };
    savePage(page);
    return send(res, 201, { ok: true, page });
  }

  // Update page
  let match = m(/^\/api\/pages\/([a-z0-9-]+)$/);
  if (match && req.method === 'PUT') {
    const body = await readBody(req);
    const existing = data.pages.find((p) => p.id === match[1]);
    if (!existing) throw httpError(404, 'Page not found.');
    const page = body.page;
    const errors = validatePageShape(page ?? {});
    if (errors.length) throw httpError(400, errors.join(' '));
    if (page.id !== existing.id) throw httpError(400, 'Page id cannot be changed. Create a new page and archive this one with a redirect.');
    if (page.status !== existing.status) throw httpError(400, 'Use the workflow controls to change status.');
    if (data.pages.some((p) => p.id !== page.id && p.path === page.path)) throw httpError(409, `Path ${page.path} is already used.`);
    const live = ['published', 'noindex'].includes(existing.status);
    if (page.path !== existing.path && live && !body.redirectOldPath) throw httpError(400, 'Changing the URL of a live page requires a redirect from the old path.');
    page.workflow.updatedAt = today();
    // Substantive edits to an approved/live page are recorded in history.
    page.workflow.history = [...(existing.workflow.history ?? []), { at: new Date().toISOString(), from: existing.status, to: existing.status, by: body.by || 'dashboard', note: body.note || 'Edited' }];
    savePage(page);
    if (page.path !== existing.path && body.redirectOldPath) {
      const redirects = data.redirects.filter((r) => r.from !== existing.path);
      redirects.push({ from: existing.path, to: page.path, status: 301, note: `URL changed ${today()}` });
      writeJson(entityFile('redirects'), redirects);
    }
    const report = evaluatePage(page, { data: withPage(loadData(), page) });
    return send(res, 200, { ok: true, report });
  }
  if (match && req.method === 'DELETE') {
    const existing = data.pages.find((p) => p.id === match[1]);
    if (!existing) throw httpError(404, 'Page not found.');
    if (!['idea', 'research'].includes(existing.status)) throw httpError(400, 'Only idea/research records can be deleted. Archive other pages instead.');
    deletePage(existing.id);
    return send(res, 200, { ok: true });
  }

  // Workflow transition
  match = m(/^\/api\/pages\/([a-z0-9-]+)\/transition$/);
  if (match && req.method === 'POST') {
    const body = await readBody(req);
    const existing = data.pages.find((p) => p.id === match[1]);
    if (!existing) throw httpError(404, 'Page not found.');
    const next = transition(existing, body.to, body.by, body.note, data);
    savePage(next);
    if (body.to === 'archived' && body.redirectTo) {
      const target = data.pages.find((p) => p.path === body.redirectTo);
      if (!target || !['published', 'noindex'].includes(target.status)) throw httpError(400, 'Redirect target must be a live page path.');
      const redirects = data.redirects.filter((r) => r.from !== existing.path);
      redirects.push({ from: existing.path, to: body.redirectTo, status: 301, note: `Archived ${existing.id} on ${today()}` });
      writeJson(entityFile('redirects'), redirects);
    }
    return send(res, 200, { ok: true, page: next });
  }

  // Entities
  match = m(/^\/api\/entities\/([a-zA-Z]+)$/);
  if (match && req.method === 'PUT') {
    const key = match[1];
    if (!ENTITY_KEYS.includes(key)) throw httpError(404, 'Unknown entity.');
    const body = await readBody(req);
    const value = body.value;
    if (key === 'business') {
      if (typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'Business must be an object.');
      if (value.phoneDisplay !== '251-930-8621' || value.phoneE164 !== '+12519308621' || value.phoneHref !== 'tel:+12519308621') {
        if (!body.confirmPhoneChange) throw httpError(400, 'The business phone is locked to 251-930-8621. Pass confirmPhoneChange to override.');
      }
    } else {
      if (!Array.isArray(value)) throw httpError(400, `${key} must be an array.`);
      const ids = new Set();
      for (const row of value) {
        const id = row.id ?? row.from;
        if (!id) throw httpError(400, `Every ${key} record needs an id.`);
        if (ids.has(id)) throw httpError(400, `Duplicate id ${id}.`);
        ids.add(id);
      }
    }
    writeJson(entityFile(key), value);
    return send(res, 200, { ok: true });
  }

  // Matrix
  if (req.method === 'POST' && path === '/api/matrix/propose') {
    const body = await readBody(req);
    const sel = { serviceIds: [], itemIds: [], locationIds: [], neighborhoodIds: [], customerTypes: [], ...body.selection };
    return send(res, 200, { candidates: proposeCandidates(data, sel) });
  }
  if (req.method === 'POST' && path === '/api/matrix/create') {
    const body = await readBody(req);
    const created = [];
    const skipped = [];
    for (const c of body.candidates ?? []) {
      if (c.recommendation !== 'create-draft' && !body.force) {
        skipped.push({ id: c.id, reason: c.recommendation });
        continue;
      }
      const fresh = loadData();
      if (fresh.pages.some((p) => p.id === c.id || p.path === c.path)) {
        skipped.push({ id: c.id, reason: 'exists' });
        continue;
      }
      const rec = candidateToRecord(c, today());
      savePage(rec);
      created.push(rec.id);
    }
    return send(res, 200, { created, skipped });
  }

  // Search Console CSV import (Queries export: Query,Clicks,Impressions,CTR,Position)
  if (req.method === 'POST' && path === '/api/keywords/import-gsc') {
    const body = await readBody(req);
    const rows = parseCsv(body.csv || '');
    if (rows.length < 2) throw httpError(400, 'CSV has no data rows.');
    const header = rows[0].map((h) => h.toLowerCase());
    const col = (name) => header.findIndex((h) => h.includes(name));
    const qi = col('quer'), ci = col('click'), ii = col('impression'), ti = col('ctr'), pi = col('position');
    if (qi < 0 || ci < 0 || ii < 0) throw httpError(400, 'Expected columns: Query, Clicks, Impressions, CTR, Position.');
    const period = body.period || `imported ${today()}`;
    const keywords = data.keywords;
    let matched = 0;
    const unmatched = [];
    for (const r of rows.slice(1)) {
      const q = normalizeKeyword(r[qi] || '');
      const perf = { clicks: Number(r[ci]) || 0, impressions: Number(r[ii]) || 0, ctr: parseFloat(String(r[ti] ?? '0').replace('%', '')) || 0, position: parseFloat(r[pi]) || 0, period, source: 'Google Search Console CSV' };
      const hits = keywords.filter((k) => normalizeKeyword(k.keyword) === q);
      if (hits.length) {
        hits.forEach((k) => (k.performance = perf));
        matched++;
      } else unmatched.push({ query: r[qi], ...perf });
    }
    writeJson(entityFile('keywords'), keywords);
    return send(res, 200, { matched, unmatched: unmatched.sort((a, b) => b.impressions - a.impressions).slice(0, 200) });
  }

  // Similarity report
  if (req.method === 'GET' && path === '/api/similarity') {
    const idx = buildShingleIndex(data.pages);
    const ids = [...idx.keys()];
    const pairs = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push({ a: ids[i], b: ids[j], value: similarity(idx.get(ids[i]), idx.get(ids[j])) });
    pairs.sort((x, y) => y.value - x.value);
    return send(res, 200, { pairs: pairs.slice(0, 40) });
  }

  // Build & audits
  if (req.method === 'POST' && path === '/api/run') {
    const body = await readBody(req);
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const tasks = {
      'validate-content': ['node', ['scripts/validate-content.mjs']],
      build: [npmCmd, ['run', 'build']],
      'validate-dist': ['node', ['scripts/validate-dist.mjs']],
      'sync-keywords': ['node', ['scripts/sync-keywords.mjs']],
      report: ['node', ['scripts/report.mjs']]
    };
    const t = tasks[body.task];
    if (!t) throw httpError(400, 'Unknown task.');
    return send(res, 200, await runScript(t[0], t[1]));
  }

  throw httpError(404, 'Unknown endpoint.');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Zoiris SEO Operations Dashboard\n  → http://${HOST}:${PORT}\n\n  Local only. Never deploy this server.${TOKEN ? '\n  ADMIN_TOKEN required for API calls.' : ''}\n`);
});
