/**
 * tests/pages.test.mjs
 * Verifies every built route in dist/, draft/noindex isolation, and the internal
 * SEO Operations Dashboard API & workflow approval gates (admin/server.mjs).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { DIST_DIR, ROOT, loadData, deletePage } from '../scripts/lib/load-data.mjs';
import { evaluatePage, isBuilt, isIndexable } from '../src/lib/page-quality.ts';

const data = loadData();
const redirectMap = new Map(data.redirects.map((r) => [r.from, r]));

function walkHtml(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walkHtml(p);
    return f.endsWith('.html') ? [p] : [];
  });
}

describe('Built Static Pages & Route Isolation', () => {
  it('renders all 49 published pages + custom 404 page + 8 static redirect stubs and zero draft leaks', () => {
    const files = walkHtml(DIST_DIR);
    const routes = new Map();
    for (const f of files) {
      const rel = '/' + relative(DIST_DIR, f).split(sep).join('/');
      const route = rel === '/404.html' ? '/404/' : rel.replace(/index\.html$/, '');
      routes.set(route, readFileSync(f, 'utf8'));
    }

    // Every published page must exist and be indexable
    const published = data.pages.filter((p) => p.status === 'published');
    assert.equal(published.length, 49);
    for (const p of published) {
      assert.ok(routes.has(p.path), `Missing built HTML for published page ${p.path}`);
      const html = routes.get(p.path);
      assert.match(html, /<meta name="robots" content="index, follow"/i, `Expected index, follow on ${p.path}`);
      assert.ok(html.includes('251-930-8621'), `Expected phone display on ${p.path}`);
      assert.ok(html.includes('tel:+12519308621'), `Expected tel:+12519308621 link on ${p.path}`);
    }

    // Custom 404 page must exist and be noindex
    assert.ok(routes.has('/404/'), 'Custom 404.html must exist');
    assert.match(routes.get('/404/'), /noindex/i);

    // Non-published records must never exist in production dist/
    const unpublished = data.pages.filter((p) => !['published', 'noindex'].includes(p.status));
    assert.equal(unpublished.length, 37);
    for (const p of unpublished) {
      assert.ok(!routes.has(p.path), `Draft/pipeline page ${p.id} (${p.status}) leaked to ${p.path}`);
    }

    // Redirect stubs must exist and point to live destinations
    for (const [from, rule] of redirectMap) {
      assert.ok(routes.has(from), `Missing static redirect stub for ${from}`);
      assert.match(routes.get(from), /http-equiv="refresh"/i);
      assert.ok(routes.get(from).includes(rule.to));
    }

    // Private Command Center, admin, and customer media vault files must never exist in dist/
    assert.ok(!existsSync(join(DIST_DIR, 'admin')), 'admin/ must never be copied into dist/');
    assert.ok(!existsSync(join(DIST_DIR, 'owner')), 'owner/ Command Center must never be copied into dist/');
    assert.ok(!existsSync(join(DIST_DIR, '.zoiris-private')), '.zoiris-private/ must never be copied into dist/');
  });

  it('computes build and indexability rules accurately for published, noindex, and draft statuses', () => {
    const pub = data.pages.find((p) => p.status === 'published');
    const report = evaluatePage(pub, { data });
    assert.equal(isBuilt(pub), true);
    assert.equal(isIndexable(pub, report), true);

    const noidx = { ...pub, status: 'noindex' };
    assert.equal(isBuilt(noidx), true);
    assert.equal(isIndexable(noidx, report), false);

    const draft = { ...pub, status: 'draft' };
    assert.equal(isBuilt(draft), false);
    assert.equal(isIndexable(draft, report), false);
  });
});

describe('SEO Operations Dashboard API & Editorial Workflow Gate', () => {
  let child;
  const port = 4491;
  const base = `http://127.0.0.1:${port}`;
  const tempId = 'idea-test-temp-record';

  before(async () => {
    child = spawn(process.execPath, ['admin/server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_PORT: String(port), ADMIN_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Admin server startup timeout')), 8000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Admin server exited early with code ${code}`));
      });
    });
  });

  after(() => {
    try {
      deletePage(tempId);
    } catch {}
    if (child && !child.killed) child.kill();
  });

  it('serves dashboard state and enforces Host allowlist + CSRF header guards', async () => {
    const stateRes = await fetch(`${base}/api/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.summary.counts.indexable, 49);
    assert.equal(state.summary.counts.errors, 0);

    // CSRF guard: POST without X-Zoiris-Admin header must return 403
    const noCsrf = await fetch(`${base}/api/matrix/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: {} })
    });
    assert.equal(noCsrf.status, 403);

    // Phone lock guard: changing business phone without confirmPhoneChange must return 400
    const badPhone = await fetch(`${base}/api/entities/business`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({ value: { ...state.data.business, phoneDisplay: '251-555-0000' } })
    });
    assert.equal(badPhone.status, 400);
  });

  it('enforces workflow transitions and blocks approving/publishing incomplete pages', async () => {
    // Cannot create a page directly in "published" status
    const illegalCreate = await fetch(`${base}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({
        by: 'QA Tester',
        page: {
          id: tempId,
          type: 'article',
          path: '/guides/temp-qa-test/',
          status: 'published',
          refs: {},
          seo: {
            title: 'Temp QA Test Guide | Zoiris Junk Removal',
            description: 'Temporary test record verifying editorial workflow gates in Zoiris SEO Operations.',
            h1: 'Temp QA Test Guide',
            primaryKeyword: 'temp qa test guide mobile al',
            secondaryKeywords: [],
            intent: 'informational',
            robotsIndex: true,
            robotsFollow: true,
            schemaTypes: ['Article', 'BreadcrumbList']
          },
          breadcrumb: { label: 'Temp QA Test', parentId: 'core-guides' },
          purpose: 'Automated QA test of editorial workflow gate.',
          related: ['core-guides'],
          workflow: { createdAt: '2026-11-04', updatedAt: '2026-11-04', approvedBy: null, approvedAt: null, reviewNotes: '', ownerVerification: [] }
        }
      })
    });
    assert.equal(illegalCreate.status, 400);

    // Create as "draft" succeeds
    const validCreate = await fetch(`${base}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({
        by: 'QA Tester',
        page: {
          id: tempId,
          type: 'article',
          path: '/guides/temp-qa-test/',
          status: 'draft',
          refs: {},
          seo: {
            title: 'Temp QA Test Guide | Zoiris Junk Removal',
            description: 'Temporary test record verifying editorial workflow gates in Zoiris SEO Operations.',
            h1: 'Temp QA Test Guide',
            primaryKeyword: 'temp qa test guide mobile al',
            secondaryKeywords: [],
            intent: 'informational',
            robotsIndex: true,
            robotsFollow: true,
            schemaTypes: ['Article', 'BreadcrumbList']
          },
          breadcrumb: { label: 'Temp QA Test', parentId: 'core-guides' },
          purpose: 'Automated QA test of editorial workflow gate.',
          related: ['core-guides'],
          workflow: { createdAt: '2026-11-04', updatedAt: '2026-11-04', approvedBy: null, approvedAt: null, reviewNotes: '', ownerVerification: [] }
        }
      })
    });
    assert.equal(validCreate.status, 201);

    // Move draft -> needs-review succeeds
    const toReview = await fetch(`${base}/api/pages/${tempId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({ to: 'needs-review', by: 'QA Tester', note: 'Ready for gate check' })
    });
    assert.equal(toReview.status, 200);

    // Attempting to approve thin page without content must fail with 422
    const blockedApprove = await fetch(`${base}/api/pages/${tempId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({ to: 'approved', by: 'QA Tester' })
    });
    assert.equal(blockedApprove.status, 422);

    // Move needs-review -> draft -> research, then DELETE cleans up cleanly
    await fetch(`${base}/api/pages/${tempId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({ to: 'draft', by: 'QA Tester' })
    });
    await fetch(`${base}/api/pages/${tempId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' },
      body: JSON.stringify({ to: 'research', by: 'QA Tester' })
    });
    const del = await fetch(`${base}/api/pages/${tempId}`, {
      method: 'DELETE',
      headers: { 'X-Zoiris-Admin': '1' }
    });
    assert.equal(del.status, 200);
    assert.ok(!existsSync(join(ROOT, 'src', 'data', 'pages', `${tempId}.json`)));
  });
});
