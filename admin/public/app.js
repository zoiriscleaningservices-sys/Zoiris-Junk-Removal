// Zoiris SEO Operations Dashboard — client application (vanilla JS, no build step).
const view = document.getElementById('view');
const drawer = document.getElementById('drawer');
const toastEl = document.getElementById('toast');
let state = null;

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pill = (v, cls = v) => `<span class="pill ${esc(cls)}">${esc(v)}</span>`;
const token = () => sessionStorage.getItem('zoiris-admin-token') || '';

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Zoiris-Admin': '1' };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const t = prompt('Admin token required:');
    if (t) {
      sessionStorage.setItem('zoiris-admin-token', t);
      return api(path, opts);
    }
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), isError ? 9000 : 3500);
}

async function refresh() {
  state = await api('/api/state');
}

function reviewer() {
  let name = localStorage.getItem('zoiris-reviewer');
  if (!name) {
    name = prompt('Your name (recorded in the workflow history):') || '';
    if (name) localStorage.setItem('zoiris-reviewer', name);
  }
  return name;
}

const pageById = (id) => state.data.pages.find((p) => p.id === id);
const summaryById = (id) => state.summary.pages.find((p) => p.id === id);

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const routes = { overview, quality, pages, matrix, keywords, services, items, locations, neighborhoods, sitemap, verification, business, build };

async function route() {
  const name = (location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  try {
    if (!state) await refresh();
    await (routes[name] ?? overview)();
  } catch (e) {
    view.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
function overview() {
  const c = state.summary.counts;
  const p = state.summary.pages;
  const issues = state.summary.issues;
  const missingMeta = p.filter((x) => x.blockers.concat(x.warnings).some((b) => b.id === 'metadata') && x.status !== 'idea' && x.status !== 'research').length;
  const dupKw = issues.filter((i) => i.code === 'keyword-cannibalization' || i.code === 'gate:cannibalization').length;
  const missingLinks = p.filter((x) => ['published', 'noindex'].includes(x.status) && x.inbound === 0).length + p.filter((x) => x.blockers.some((b) => b.id === 'internal-links')).length;
  const schemaIncomplete = p.filter((x) => x.warnings.some((w) => w.id === 'schema') || x.blockers.some((b) => b.id === 'schema-service')).length;
  const needsReview = p.filter((x) => x.status === 'needs-review' || (x.status === 'draft' && x.hasContent)).length;
  const kpi = (label, value, cls = '') => `<div class="kpi ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const byType = (t) => p.filter((x) => x.type === t);
  const typeLive = (t) => byType(t).filter((x) => x.indexable).length;
  const statuses = ['idea', 'research', 'draft', 'needs-review', 'approved', 'published', 'noindex', 'archived'];
  const max = Math.max(...statuses.map((s) => p.filter((x) => x.status === s).length), 1);

  view.innerHTML = `
    <div class="page-head"><div><h1>SEO Operations Dashboard</h1><p class="muted">Generated ${new Date(state.summary.generatedAt).toLocaleString()} · Mobile, Alabama</p></div>
      <div class="toolbar"><button class="secondary" id="reload">Refresh data</button><a class="btn" href="#/build">Build &amp; audit</a></div></div>
    <div class="kpis">
      ${kpi('Total page records', c.total)}
      ${kpi('Published', c.published, 'good')}
      ${kpi('Indexable (in sitemap)', c.indexable, 'good')}
      ${kpi('Draft', c.draft, 'warn')}
      ${kpi('Awaiting approval', c.needsReview + c.approved, 'warn')}
      ${kpi('Noindex', c.noindexStatus)}
      ${kpi('Idea / research', c.idea + c.research)}
      ${kpi('Errors', c.errors, c.errors ? 'bad' : 'good')}
    </div>
    <div class="kpis">
      ${kpi(`Service pages (${typeLive('service')} live)`, byType('service').length)}
      ${kpi(`E-waste pages (${typeLive('ewaste')} live)`, byType('ewaste').length)}
      ${kpi(`Item pages (${typeLive('item')} live)`, byType('item').length)}
      ${kpi(`Location pages (${typeLive('location')} live)`, byType('location').length)}
      ${kpi(`Neighborhood pages (${typeLive('neighborhood')} live)`, byType('neighborhood').length)}
      ${kpi(`Service + location (${typeLive('combo')} live)`, byType('combo').length)}
      ${kpi(`Guides (${typeLive('article')} live)`, byType('article').length)}
    </div>
    <div class="kpis">
      ${kpi('Missing / invalid metadata', missingMeta, missingMeta ? 'bad' : 'good')}
      ${kpi('Duplicate keyword targets', dupKw, dupKw ? 'bad' : 'good')}
      ${kpi('Pages missing internal links', missingLinks, missingLinks ? 'bad' : 'good')}
      ${kpi('Incomplete structured data', schemaIncomplete, schemaIncomplete ? 'warn' : 'good')}
      ${kpi('Needing content review', needsReview, needsReview ? 'warn' : 'good')}
      ${kpi('Warnings', c.warnings, c.warnings ? 'warn' : 'good')}
    </div>
    <div class="grid2">
      <div class="panel"><h2>Pipeline by status</h2><div class="bars">
        ${statuses.map((s) => { const n = p.filter((x) => x.status === s).length; return `<div class="bar"><span>${pill(s)}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`; }).join('')}
      </div></div>
      <div class="panel"><h2>Needs attention</h2>
        ${issues.filter((i) => i.level !== 'info').slice(0, 12).map(issueRow).join('') || '<p class="muted">No errors or warnings. 🎉</p>'}
        <p><a href="#/quality">Open quality control →</a></p>
      </div>
    </div>
    <div class="panel"><h2>Next pages in the pipeline</h2>${pageTable(p.filter((x) => !['published', 'archived'].includes(x.status)).slice(0, 12))}</div>`;
  document.getElementById('reload').onclick = async () => { await refresh(); route(); toast('Data reloaded'); };
  bindPageLinks();
}

function issueRow(i) {
  return `<div class="issue"><span>${pill(i.level)}</span><code>${esc(i.code)}</code><span>${i.pageId ? `<button class="link-btn" data-open="${esc(i.pageId)}">${esc(i.pageId)}</button> — ` : ''}${esc(i.message)}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */
function pageTable(rows) {
  if (!rows.length) return '<p class="muted">No pages match.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Page</th><th>Type</th><th>Status</th><th>Score</th><th>Gate</th><th>Indexable</th><th>Words</th><th>Inbound</th><th>Primary keyword</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><button class="link-btn" data-open="${esc(r.id)}">${esc(r.path)}</button><br><small class="muted">${esc(r.id)}</small></td>
      <td>${esc(r.type)}</td><td>${pill(r.status)}</td><td><b>${r.score}</b></td>
      <td>${r.passesGate ? pill('pass') : `${pill('fail')} <small class="muted">${r.blockers.length} blocker${r.blockers.length === 1 ? '' : 's'}</small>`}</td>
      <td>${r.indexable ? pill('yes') : pill('no')}</td><td>${r.wordCount || '—'}</td><td>${r.inbound}</td><td>${esc(r.primaryKeyword)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function bindPageLinks(root = document) {
  root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openPage(b.dataset.open)));
}

function pages() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  view.innerHTML = `
    <div class="page-head"><div><h1>Pages</h1><p class="muted">Every page record. Only "published" pages that pass the quality gate are indexable.</p></div>
      <div class="toolbar"><button id="new-page">New page record</button></div></div>
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search path, id, keyword…" value="${esc(params.get('q') || '')}" aria-label="Search pages" />
      <select id="ft" aria-label="Type"><option value="">All types</option>${['core', 'service', 'ewaste', 'item', 'location', 'neighborhood', 'combo', 'article'].map((t) => `<option ${params.get('type') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="fs" aria-label="Status"><option value="">All statuses</option>${Object.keys(state.transitions).map((s) => `<option ${params.get('status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fg" aria-label="Gate"><option value="">Gate: any</option><option value="fail">Failing gate</option><option value="pass">Passing gate</option></select>
      <span class="muted" id="n"></span>
    </div>
    <div id="tbl"></div>`;
  const draw = () => {
    const q = document.getElementById('q').value.toLowerCase();
    const t = document.getElementById('ft').value;
    const s = document.getElementById('fs').value;
    const g = document.getElementById('fg').value;
    const rows = state.summary.pages.filter((r) => (!q || `${r.path} ${r.id} ${r.primaryKeyword} ${r.title}`.toLowerCase().includes(q)) && (!t || r.type === t) && (!s || r.status === s) && (!g || (g === 'pass') === r.passesGate));
    document.getElementById('tbl').innerHTML = pageTable(rows);
    document.getElementById('n').textContent = `${rows.length} of ${state.summary.pages.length}`;
    bindPageLinks();
  };
  ['q', 'ft', 'fs', 'fg'].forEach((id) => (document.getElementById(id).oninput = draw));
  document.getElementById('new-page').onclick = newPage;
  draw();
}

function newPage() {
  const id = prompt('New page id (kebab-case, e.g. svc-piano-removal):');
  if (!id) return;
  const path = prompt('URL path (leading and trailing slash):', `/services/${id.replace(/^(svc|ew|item|loc|nb|combo|guide)-/, '')}/`);
  if (!path) return;
  const type = prompt('Type (service, ewaste, item, location, neighborhood, combo, article):', 'service');
  const page = {
    id, type, path, status: 'idea', refs: {},
    seo: { title: '', description: '', h1: '', primaryKeyword: '', secondaryKeywords: [], intent: 'transactional', robotsIndex: true, robotsFollow: true, schemaTypes: ['BreadcrumbList'] },
    breadcrumb: { label: id, parentId: 'core-services' }, purpose: '', related: [],
    workflow: { createdAt: '', updatedAt: '', approvedBy: null, approvedAt: null, reviewNotes: '', ownerVerification: [] }
  };
  api('/api/pages', { method: 'POST', body: { page, by: reviewer() } })
    .then(async () => { await refresh(); toast('Page record created'); openPage(id); })
    .catch((e) => toast(e.message, true));
}

async function openPage(id) {
  const page = structuredClone(pageById(id));
  if (!page) return toast('Page not found', true);
  const report = await api(`/api/pages/${id}/quality`);
  const allowed = state.transitions[page.status] || [];
  const svcOpts = state.data.services.map((s) => `<option value="${esc(s.id)}" ${page.refs.serviceId === s.id ? 'selected' : ''}>${esc(s.name)} (${esc(s.verification)})</option>`).join('');
  const locOpts = state.data.locations.map((l) => `<option value="${esc(l.id)}" ${page.refs.locationId === l.id ? 'selected' : ''}>${esc(l.name)} (${esc(l.coverage)})</option>`).join('');
  const nbOpts = state.data.neighborhoods.map((n) => `<option value="${esc(n.id)}" ${page.refs.neighborhoodId === n.id ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
  const parentOpts = state.data.pages.filter((p) => p.id !== id).map((p) => `<option value="${esc(p.id)}" ${page.breadcrumb.parentId === p.id ? 'selected' : ''}>${esc(p.path)}</option>`).join('');
  const f = (name, label, value, hint = '', type = 'text') => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" data-f="${name}" type="${type}" value="${esc(value)}" />${hint ? `<small>${hint}</small>` : ''}</div>`;

  drawer.innerHTML = `
    <div class="drawer-head"><div><h2 style="margin:0">${esc(page.path)}</h2><small class="muted">${esc(page.id)} · ${esc(page.type)} · ${pill(page.status)} · score <b>${report.score}</b> ${report.passesGate ? pill('gate pass', 'pass') : pill('gate fail', 'fail')}</small></div>
      <div class="toolbar" style="margin:0"><button class="teal" id="save">Save changes</button><button class="secondary" id="close">Close</button></div></div>
    <div class="drawer-body">
      <section class="panel"><h3>Workflow</h3>
        <div class="workflow">${allowed.map((s) => `<button class="small ${s === 'published' ? 'teal' : s === 'archived' ? 'danger' : 'secondary'}" data-to="${s}">→ ${s}</button>`).join('')}
        ${['idea', 'research'].includes(page.status) ? '<button class="small danger" id="del">Delete record</button>' : ''}</div>
        <p class="muted" style="margin:.5rem 0 0">Approved by: <b>${esc(page.workflow.approvedBy || '—')}</b> ${page.workflow.approvedAt ? 'on ' + esc(page.workflow.approvedAt) : ''}. Approval requires a passing quality gate; publishing requires approval.</p>
        <div class="history">${(page.workflow.history || []).slice().reverse().map((h) => `<div>${esc(h.at.slice(0, 16).replace('T', ' '))} — ${esc(h.by)}: ${esc(h.from)} → ${esc(h.to)} ${h.note ? '· ' + esc(h.note) : ''}</div>`).join('')}</div>
      </section>
      <section class="panel"><h3>Quality gate <small class="muted">(internal editorial tool — not a Google metric)</small></h3><div class="checks">
        ${report.checks.map((c) => `<div class="check ${c.pass ? 'pass' : 'fail'} ${c.severity}"><span class="mark">${c.pass ? '✓' : c.severity === 'blocker' ? '✖' : '!'}</span><span>${esc(c.label)}${c.detail ? `<br><small class="muted">${esc(c.detail)}</small>` : ''}</span><span class="pill ${c.pass ? 'pass' : c.severity === 'blocker' ? 'fail' : 'warning'}">${c.severity}</span></div>`).join('')}
      </div></section>
      <section class="panel"><h3>Search appearance preview</h3>
        <div class="serp"><div class="u">${esc((state.data.business.website || '') + page.path)}</div><div class="t" id="serp-t">${esc(page.seo.title)}</div><div class="d" id="serp-d">${esc(page.seo.description)}</div></div>
      </section>
      <section class="panel"><h3>SEO</h3><div class="fields">
        ${f('seo.title', 'SEO title', page.seo.title, '<span class="count" data-count="seo.title" data-max="60"></span>')}
        ${f('seo.h1', 'H1', page.seo.h1)}
        ${f('path', 'Canonical path', page.path, 'Changing a live URL creates a 301 redirect.')}
        ${f('seo.primaryKeyword', 'Primary keyword', page.seo.primaryKeyword, 'One unique primary keyword per page.')}
        <div class="field"><label for="f-seo.intent">Search intent</label><select id="f-seo.intent" data-f="seo.intent">${['transactional', 'commercial', 'informational', 'navigational', 'local'].map((i) => `<option ${page.seo.intent === i ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
        ${f('seo.secondaryKeywords', 'Secondary keywords (comma-separated)', page.seo.secondaryKeywords.join(', '))}
        ${f('seo.ogTitle', 'Open Graph title', page.seo.ogTitle || '')}
        ${f('seo.ogImage', 'Social image path', page.seo.ogImage || '', 'Defaults to /brand/og-default.jpg')}
        ${f('seo.schemaTypes', 'Schema types (comma-separated)', page.seo.schemaTypes.join(', '), 'Service, BreadcrumbList, Article…')}
        <div class="field"><label>Robots</label><div class="chips"><label><input type="checkbox" data-f="seo.robotsIndex" ${page.seo.robotsIndex ? 'checked' : ''}/> index</label><label><input type="checkbox" data-f="seo.robotsFollow" ${page.seo.robotsFollow ? 'checked' : ''}/> follow</label></div></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="f-seo.description">Meta description</label><textarea id="f-seo.description" data-f="seo.description" style="font-family:inherit;min-height:60px">${esc(page.seo.description)}</textarea><span class="count" data-count="seo.description" data-max="160"></span></div>
      <div class="field" style="margin-top:12px"><label for="f-seo.ogDescription">Open Graph description</label><textarea id="f-seo.ogDescription" data-f="seo.ogDescription" style="font-family:inherit;min-height:50px">${esc(page.seo.ogDescription || '')}</textarea></div>
      </section>
      <section class="panel"><h3>Entities &amp; hierarchy</h3><div class="fields">
        <div class="field"><label for="f-refs.serviceId">Service</label><select id="f-refs.serviceId" data-f="refs.serviceId"><option value="">—</option>${svcOpts}</select></div>
        <div class="field"><label for="f-refs.locationId">Location</label><select id="f-refs.locationId" data-f="refs.locationId"><option value="">—</option>${locOpts}</select></div>
        <div class="field"><label for="f-refs.neighborhoodId">Neighborhood</label><select id="f-refs.neighborhoodId" data-f="refs.neighborhoodId"><option value="">—</option>${nbOpts}</select></div>
        ${f('refs.itemIds', 'Item ids (comma-separated)', (page.refs.itemIds || []).join(', '))}
        ${f('breadcrumb.label', 'Breadcrumb label', page.breadcrumb.label)}
        <div class="field"><label for="f-breadcrumb.parentId">Breadcrumb parent</label><select id="f-breadcrumb.parentId" data-f="breadcrumb.parentId"><option value="">—</option>${parentOpts}</select></div>
        ${f('related', 'Related page ids (comma-separated)', page.related.join(', '), 'Published pages may only link to built pages.')}
      </div></section>
      <section class="panel"><h3>Editorial</h3>
        <div class="field"><label for="f-purpose">Purpose (distinct visitor need this page serves)</label><textarea id="f-purpose" data-f="purpose" style="font-family:inherit">${esc(page.purpose)}</textarea></div>
        <div class="field" style="margin-top:10px"><label for="f-workflow.reviewNotes">Review notes</label><textarea id="f-workflow.reviewNotes" data-f="workflow.reviewNotes" style="font-family:inherit">${esc(page.workflow.reviewNotes)}</textarea></div>
        <div class="field" style="margin-top:10px"><label for="f-workflow.ownerVerification">Facts awaiting owner verification (one per line)</label><textarea id="f-workflow.ownerVerification" data-f="workflow.ownerVerification" style="font-family:inherit">${esc((page.workflow.ownerVerification || []).join('\n'))}</textarea></div>
      </section>
      <section class="panel"><h3>Structured content (JSON)</h3>
        <p class="muted">Fields: lead, quickAnswer, includes, items, audience, process, pricingFactors, prepare, restrictions, sections, faqs, areaNote, illustration, article. Inline syntax: <code>[text](/path/)</code> and <code>**bold**</code>.</p>
        <textarea id="content-json" style="min-height:360px">${esc(page.content ? JSON.stringify(page.content, null, 2) : '')}</textarea>
        <small class="muted" id="json-status"></small>
      </section>
    </div>`;
  drawer.showModal();
  const get = (path) => path.split('.').reduce((o, k) => o?.[k], page);
  drawer.querySelectorAll('[data-count]').forEach((el) => {
    const input = drawer.querySelector(`[data-f="${el.dataset.count}"]`);
    const upd = () => { el.textContent = `${input.value.length} / ${el.dataset.max} characters`; el.classList.toggle('over', input.value.length > Number(el.dataset.max)); };
    input.addEventListener('input', upd);
    upd();
  });
  drawer.querySelector('[data-f="seo.title"]').addEventListener('input', (e) => (document.getElementById('serp-t').textContent = e.target.value));
  drawer.querySelector('[data-f="seo.description"]').addEventListener('input', (e) => (document.getElementById('serp-d').textContent = e.target.value));
  const jsonEl = document.getElementById('content-json');
  jsonEl.addEventListener('input', () => {
    try { if (jsonEl.value.trim()) JSON.parse(jsonEl.value); document.getElementById('json-status').textContent = '✓ valid JSON'; } catch (e) { document.getElementById('json-status').textContent = '✖ ' + e.message; }
  });
  document.getElementById('close').onclick = () => drawer.close();

  document.getElementById('save').onclick = async () => {
    const next = structuredClone(page);
    const setPath = (obj, path, value) => { const ks = path.split('.'); let o = obj; ks.slice(0, -1).forEach((k) => (o = o[k] ??= {})); o[ks.at(-1)] = value; };
    drawer.querySelectorAll('[data-f]').forEach((el) => {
      const key = el.dataset.f;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (['seo.secondaryKeywords', 'seo.schemaTypes', 'related', 'refs.itemIds'].includes(key)) v = String(v).split(',').map((s) => s.trim()).filter(Boolean);
      if (key === 'workflow.ownerVerification') v = String(v).split('\n').map((s) => s.trim()).filter(Boolean);
      if (['refs.serviceId', 'refs.locationId', 'refs.neighborhoodId'].includes(key) && !v) { const k = key.split('.')[1]; delete next.refs[k]; return; }
      if (key === 'refs.itemIds' && !v.length) { delete next.refs.itemIds; return; }
      if (key === 'breadcrumb.parentId' && !v) v = null;
      if (['seo.ogTitle', 'seo.ogImage', 'seo.ogDescription'].includes(key) && !v) { delete next.seo[key.split('.')[1]]; return; }
      setPath(next, key, v);
    });
    if (jsonEl.value.trim()) {
      try { next.content = JSON.parse(jsonEl.value); } catch (e) { return toast('Content JSON is invalid: ' + e.message, true); }
    } else delete next.content;
    let redirectOldPath = false;
    if (next.path !== page.path && ['published', 'noindex'].includes(page.status)) {
      redirectOldPath = confirm(`This page is live. Create a 301 redirect from ${page.path} to ${next.path}?`);
      if (!redirectOldPath) return;
    }
    try {
      const res = await api(`/api/pages/${id}`, { method: 'PUT', body: { page: next, by: reviewer(), redirectOldPath } });
      await refresh();
      toast(`Saved. Score ${res.report.score}${res.report.passesGate ? '' : ` — ${res.report.blockers.length} blocker(s)`}`);
      openPage(id);
      route();
    } catch (e) { toast(e.message, true); }
  };

  drawer.querySelectorAll('[data-to]').forEach((b) => (b.onclick = async () => {
    const to = b.dataset.to;
    const by = reviewer();
    if (!by) return;
    const note = prompt(`Note for ${page.status} → ${to} (optional):`) ?? '';
    let redirectTo;
    if (to === 'archived' && ['published', 'noindex'].includes(page.status)) {
      redirectTo = prompt('This page is live. Redirect its URL to which live path? (leave blank for none — a 404 will result)') || undefined;
    }
    try {
      await api(`/api/pages/${id}/transition`, { method: 'POST', body: { to, by, note, redirectTo } });
      await refresh();
      toast(`Status changed to ${to}. Rebuild the site to apply.`);
      openPage(id);
      route();
    } catch (e) { toast(e.message, true); }
  }));
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${id}? This cannot be undone.`)) return;
    try { await api(`/api/pages/${id}`, { method: 'DELETE' }); await refresh(); drawer.close(); route(); toast('Deleted'); } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ */
/* Quality control                                                     */
/* ------------------------------------------------------------------ */
async function quality() {
  const issues = state.summary.issues;
  const sim = await api('/api/similarity');
  const groups = {};
  issues.forEach((i) => (groups[i.code] ??= []).push(i));
  const live = state.summary.pages.filter((p) => ['published', 'noindex'].includes(p.status));
  const titles = {}, descs = {};
  live.forEach((p) => { const pg = pageById(p.id); (titles[pg.seo.title] ??= []).push(p.id); (descs[pg.seo.description] ??= []).push(p.id); });
  const dups = (m) => Object.entries(m).filter(([, ids]) => ids.length > 1);
  view.innerHTML = `
    <div class="page-head"><div><h1>Quality control</h1><p class="muted">Automated checks from the same gate used by the build. Errors block deployment.</p></div></div>
    <div class="kpis">
      <div class="kpi ${state.summary.counts.errors ? 'bad' : 'good'}"><b>${state.summary.counts.errors}</b><span>Errors</span></div>
      <div class="kpi warn"><b>${state.summary.counts.warnings}</b><span>Warnings</span></div>
      <div class="kpi ${dups(titles).length ? 'bad' : 'good'}"><b>${dups(titles).length}</b><span>Duplicate titles (live)</span></div>
      <div class="kpi ${dups(descs).length ? 'bad' : 'good'}"><b>${dups(descs).length}</b><span>Duplicate descriptions (live)</span></div>
      <div class="kpi ${live.filter((p) => p.inbound === 0 && p.id !== 'core-home').length ? 'bad' : 'good'}"><b>${live.filter((p) => p.inbound === 0 && p.id !== 'core-home').length}</b><span>Orphan pages</span></div>
      <div class="kpi"><b>${live.length ? Math.round(live.reduce((s, p) => s + p.score, 0) / live.length) : 0}</b><span>Avg editorial score (live)</span></div>
    </div>
    <div class="panel"><h2>Issues by check</h2>${Object.entries(groups).sort((a, b) => (a[1][0].level === 'error' ? -1 : 1)).map(([code, list]) => `<details ${list[0].level === 'error' ? 'open' : ''}><summary><code>${esc(code)}</code> ${pill(list[0].level)} <b>${list.length}</b></summary>${list.map(issueRow).join('')}</details>`).join('') || '<p class="muted">No issues.</p>'}</div>
    <div class="grid2">
      <div class="panel"><h2>Live pages failing or warning</h2>${pageTable(live.filter((p) => !p.passesGate || p.warnings.length))}</div>
      <div class="panel"><h2>Most similar page pairs</h2><p class="muted">5-word shingle overlap. Above 20% warns; above 40% blocks indexing.</p>
        <table><thead><tr><th>Page A</th><th>Page B</th><th>Overlap</th></tr></thead><tbody>${sim.pairs.slice(0, 15).map((p) => `<tr><td><button class="link-btn" data-open="${esc(p.a)}">${esc(p.a)}</button></td><td><button class="link-btn" data-open="${esc(p.b)}">${esc(p.b)}</button></td><td>${pill((p.value * 100).toFixed(1) + '%', p.value >= 0.4 ? 'fail' : p.value >= 0.2 ? 'warning' : 'pass')}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;
  bindPageLinks();
}

/* ------------------------------------------------------------------ */
/* Page matrix                                                         */
/* ------------------------------------------------------------------ */
function matrix() {
  const d = state.data;
  const box = (name, list, label, sub) => `<div class="panel"><h3>${label}</h3><div class="chips">${list.map((x) => `<label><input type="checkbox" name="${name}" value="${esc(x.id)}"/> ${esc(x.name)} <small class="muted">${esc(sub(x))}</small></label>`).join('')}</div></div>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Page matrix generator</h1><p class="muted">Propose service × location, service × neighborhood, item × city, and customer-type opportunities. Candidates are checked against existing intent and created only as "idea" records — never published automatically.</p></div></div>
    <div class="notice">Doorway-page safeguard: a candidate can only reach "published" after it has genuinely local, page-specific content, verified coverage, and editorial approval.</div><br>
    <div class="grid2">
      ${box('serviceIds', d.services.filter((s) => s.pageId), 'Services', (s) => s.verification)}
      ${box('locationIds', d.locations, 'Cities', (l) => l.coverage)}
      ${box('neighborhoodIds', d.neighborhoods, 'Neighborhoods', (n) => `${n.coverage} · ${n.localEvidence.length} evidence`)}
      ${box('itemIds', d.items.filter((i) => i.acceptance !== 'not-accepted'), 'Items', (i) => i.acceptance)}
      <div class="panel"><h3>Customer type</h3><div class="chips"><label><input type="checkbox" name="customerTypes" value="residential"/> Residential</label><label><input type="checkbox" name="customerTypes" value="commercial"/> Commercial</label></div></div>
    </div>
    <div class="toolbar"><button id="propose" class="teal">Propose opportunities</button></div>
    <div id="cands"></div>`;
  document.getElementById('propose').onclick = async () => {
    const sel = {};
    ['serviceIds', 'locationIds', 'neighborhoodIds', 'itemIds', 'customerTypes'].forEach((n) => (sel[n] = [...view.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => i.value)));
    const { candidates } = await api('/api/matrix/propose', { method: 'POST', body: { selection: sel } });
    const el = document.getElementById('cands');
    if (!candidates.length) return (el.innerHTML = '<p class="muted">Select at least one service or item plus a location, neighborhood, or customer type.</p>');
    el.innerHTML = `<div class="panel"><h2>${candidates.length} candidates</h2>
      <div class="table-wrap"><table><thead><tr><th></th><th>Candidate</th><th>Kind</th><th>Recommendation</th><th>Existing</th><th>Reasons</th></tr></thead><tbody>
      ${candidates.map((c, i) => `<tr><td><input type="checkbox" data-i="${i}" ${c.recommendation === 'create-draft' ? '' : 'disabled'} aria-label="Select ${esc(c.h1)}"/></td><td><b>${esc(c.h1)}</b><br><small class="muted">${esc(c.path)}</small></td><td>${esc(c.kind)}</td>
        <td>${pill(c.recommendation, c.recommendation === 'create-draft' ? 'approved' : c.recommendation === 'blocked' ? 'fail' : 'idea')}</td>
        <td>${c.existingPageId ? `<button class="link-btn" data-open="${esc(c.existingPageId)}">${esc(c.existingPageId)}</button>` : '—'}</td><td><small>${c.reasons.map(esc).join('<br>')}</small></td></tr>`).join('')}
      </tbody></table></div><br><button id="create" class="teal">Create selected as idea records</button></div>`;
    bindPageLinks(el);
    document.getElementById('create').onclick = async () => {
      const picked = [...el.querySelectorAll('input[data-i]:checked')].map((x) => candidates[Number(x.dataset.i)]);
      if (!picked.length) return toast('Select at least one candidate', true);
      const res = await api('/api/matrix/create', { method: 'POST', body: { candidates: picked } });
      await refresh();
      toast(`Created ${res.created.length} idea record(s)${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}.`);
    };
  };
}

/* ------------------------------------------------------------------ */
/* Keywords                                                            */
/* ------------------------------------------------------------------ */
function keywords() {
  const kws = state.data.keywords;
  const pageOpts = (sel) => `<option value="">— unassigned —</option>` + state.data.pages.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.path)}</option>`).join('');
  const counts = {};
  kws.forEach((k) => { const n = k.keyword.toLowerCase(); (counts[n] ??= new Set()).add(k.targetPageId); });
  view.innerHTML = `
    <div class="page-head"><div><h1>Keyword map</h1><p class="muted">${kws.length} keywords · ${kws.filter((k) => k.role === 'primary').length} primary. Volume, CPC and competition stay empty until real data is imported — nothing is estimated.</p></div>
      <div class="toolbar"><button class="secondary" id="sync">Sync from page records</button><button id="save-kw" class="teal">Save changes</button></div></div>
    <div class="panel"><h3>Import Google Search Console performance</h3><p class="muted">Export Performance → Queries as CSV and paste it below. Matching keywords get clicks, impressions, CTR and position.</p>
      <textarea id="gsc" placeholder="Top queries,Clicks,Impressions,CTR,Position"></textarea><div class="toolbar" style="margin-top:8px"><input id="period" placeholder="Period, e.g. 2026-10-01 → 2026-10-31"/><button id="import">Import</button></div><div id="import-out"></div></div>
    <div class="toolbar"><input id="kq" type="search" placeholder="Filter keywords…" aria-label="Filter keywords"/><select id="kr" aria-label="Role"><option value="">All roles</option><option>primary</option><option>secondary</option></select><label class="chips"><label><input type="checkbox" id="kc"/> Only conflicts</label></label></div>
    <div class="table-wrap"><table><thead><tr><th>Keyword</th><th>Role</th><th>Intent</th><th>Target page</th><th>Priority</th><th>Location</th><th>Conversion</th><th>Performance</th><th>Source</th></tr></thead><tbody id="kbody"></tbody></table></div>`;
  const draw = () => {
    const q = document.getElementById('kq').value.toLowerCase();
    const r = document.getElementById('kr').value;
    const onlyC = document.getElementById('kc').checked;
    document.getElementById('kbody').innerHTML = kws.map((k, i) => ({ k, i })).filter(({ k }) => (!q || k.keyword.toLowerCase().includes(q)) && (!r || k.role === r) && (!onlyC || counts[k.keyword.toLowerCase()].size > 1)).map(({ k, i }) => `<tr>
      <td><b>${esc(k.keyword)}</b>${counts[k.keyword.toLowerCase()].size > 1 ? ' ' + pill('conflict', 'fail') : ''}</td><td>${pill(k.role, k.role === 'primary' ? 'approved' : 'idea')}</td>
      <td><select data-k="${i}" data-field="intent">${['transactional', 'commercial', 'informational', 'navigational', 'local'].map((x) => `<option ${k.intent === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td><select data-k="${i}" data-field="targetPageId">${pageOpts(k.targetPageId)}</select></td>
      <td><select data-k="${i}" data-field="priority">${['high', 'medium', 'low'].map((x) => `<option ${k.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${esc(k.locationRelevance)}</td><td>${esc(k.conversionPotential)}</td>
      <td>${k.performance ? `${k.performance.clicks} clicks · ${k.performance.impressions} impr · pos ${k.performance.position}` : '<span class="muted">—</span>'}</td>
      <td><small class="muted">${esc(k.researchedAt)}</small></td></tr>`).join('');
    view.querySelectorAll('[data-k]').forEach((s) => (s.onchange = () => (kws[Number(s.dataset.k)][s.dataset.field] = s.value || null)));
  };
  ['kq', 'kr', 'kc'].forEach((id) => (document.getElementById(id).oninput = draw));
  draw();
  document.getElementById('save-kw').onclick = async () => { try { await api('/api/entities/keywords', { method: 'PUT', body: { value: kws } }); await refresh(); toast('Keyword map saved'); } catch (e) { toast(e.message, true); } };
  document.getElementById('sync').onclick = async () => { const r = await api('/api/run', { method: 'POST', body: { task: 'sync-keywords' } }); await refresh(); keywords(); toast(r.output.split('\n')[0]); };
  document.getElementById('import').onclick = async () => {
    try {
      const r = await api('/api/keywords/import-gsc', { method: 'POST', body: { csv: document.getElementById('gsc').value, period: document.getElementById('period').value } });
      await refresh();
      document.getElementById('import-out').innerHTML = `<p>Matched ${r.matched} queries. ${r.unmatched.length} unmatched queries (top by impressions) — potential new targets:</p><ul>${r.unmatched.slice(0, 25).map((u) => `<li>${esc(u.query)} — ${u.impressions} impressions</li>`).join('')}</ul>`;
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ */
/* Generic entity editor                                               */
/* ------------------------------------------------------------------ */
function entityEditor(key, title, intro, columns, blank) {
  const rows = structuredClone(state.data[key]);
  const cell = (row, i, c) => {
    const v = row[c.key];
    if (c.options) return `<select data-r="${i}" data-c="${c.key}">${c.options.map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    if (c.type === 'bool') return `<input type="checkbox" data-r="${i}" data-c="${c.key}" ${v ? 'checked' : ''}/>`;
    if (c.type === 'list') return `<input data-r="${i}" data-c="${c.key}" data-list="1" value="${esc((v || []).join(' | '))}"/>`;
    if (c.readonly) return esc(v);
    return `<input data-r="${i}" data-c="${c.key}" value="${esc(v ?? '')}"/>`;
  };
  view.innerHTML = `
    <div class="page-head"><div><h1>${title}</h1><p class="muted">${intro}</p></div>
      <div class="toolbar"><button class="secondary" id="add">Add record</button><button class="teal" id="save">Save ${title.toLowerCase()}</button></div></div>
    <div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join('')}<th>Page</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr>${columns.map((c) => `<td>${cell(r, i, c)}</td>`).join('')}<td>${r.pageId && pageById(r.pageId) ? `<button class="link-btn" data-open="${esc(r.pageId)}">${esc(pageById(r.pageId).status)}</button>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
  view.querySelectorAll('[data-r]').forEach((el) => (el.onchange = () => {
    const row = rows[Number(el.dataset.r)];
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.list) v = v.split('|').map((s) => s.trim()).filter(Boolean);
    if (el.dataset.c === 'pageId' && !v) v = null;
    row[el.dataset.c] = v;
  }));
  bindPageLinks();
  document.getElementById('add').onclick = () => {
    const id = prompt('New record id (kebab-case):');
    if (!id) return;
    state.data[key] = [...rows, { ...blank, id }];
    entityEditor(key, title, intro, columns, blank);
  };
  document.getElementById('save').onclick = async () => {
    try { await api(`/api/entities/${key}`, { method: 'PUT', body: { value: rows } }); await refresh(); toast(`${title} saved. Rebuild the site to apply.`); route(); } catch (e) { toast(e.message, true); }
  };
}

function services() {
  entityEditor('services', 'Services', 'Only "confirmed" or "category-confirmed" services can have published pages. "unverified" services stay in research until the owner confirms them.', [
    { key: 'id', label: 'ID', readonly: true }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Category', options: ['junk', 'ewaste'] },
    { key: 'group', label: 'Group', options: ['core', 'removal', 'cleanout', 'debris', 'ewaste'] },
    { key: 'verification', label: 'Verification', options: ['confirmed', 'category-confirmed', 'unverified', 'not-offered'] },
    { key: 'customerTypes', label: 'Customers', type: 'list' }, { key: 'showInNav', label: 'In nav', type: 'bool' }, { key: 'pageId', label: 'Page id' }, { key: 'summary', label: 'Summary' }, { key: 'notes', label: 'Notes' }
  ], { name: '', category: 'junk', group: 'removal', customerTypes: ['residential'], verification: 'unverified', pageId: null, summary: '', icon: 'box', showInNav: false, notes: '' });
}
function items() {
  entityEditor('items', 'Items', 'Drives the public accepted-items directory. Use "unknown" until the owner confirms an item; "accepted-after-confirmation" for items that need case-by-case checks.', [
    { key: 'id', label: 'ID', readonly: true }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Category', options: state.data.itemCategories.map((c) => c.id) },
    { key: 'acceptance', label: 'Acceptance', options: ['accepted', 'accepted-after-confirmation', 'quantity-limited', 'special-handling', 'not-accepted', 'unknown'] },
    { key: 'isEwaste', label: 'E-waste', type: 'bool' }, { key: 'containsBattery', label: 'Battery', type: 'bool' }, { key: 'dataBearing', label: 'Data', type: 'bool' },
    { key: 'publicNote', label: 'Public note' }, { key: 'serviceId', label: 'Service' }, { key: 'pageId', label: 'Page id' }, { key: 'notes', label: 'Internal notes' }
  ], { name: '', category: 'household', isEwaste: false, acceptance: 'unknown', publicNote: '', serviceId: null, pageId: null, containsBattery: false, dataBearing: false, notes: '' });
}
function locations() {
  entityEditor('locations', 'Locations', 'Only "active" locations may be advertised as active service areas or receive published indexable pages. Research-only records remain excluded from indexing until owner activation.', [
    { key: 'id', label: 'ID', readonly: true }, { key: 'name', label: 'Name' }, { key: 'county', label: 'County' }, { key: 'kind', label: 'Kind', options: ['city', 'town', 'community'] },
    { key: 'classification', label: 'Classification', options: ['incorporated-municipality', 'official-neighborhood', 'recognized-community', 'local-area-name', 'unincorporated-area'] },
    { key: 'coverage', label: 'Coverage', options: ['active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'] },
    { key: 'pageId', label: 'Page id' }, { key: 'source', label: 'Source' }, { key: 'notes', label: 'Notes' }
  ], { name: '', officialName: '', state: 'AL', county: 'Mobile County', countyId: 'mobile-county-al', kind: 'city', classification: 'incorporated-municipality', parentAreaId: 'mobile-county-al', subRegion: '', zipCodes: [], geoReference: '', pickupNotes: '', coverage: 'research-only', pageId: null, notes: '', source: '', lastVerifiedAt: '2026-11-04' });
}
function neighborhoods() {
  entityEditor('neighborhoods', 'Neighborhoods', 'A neighborhood page needs "active" coverage AND at least two pieces of first-party local evidence (real jobs, permitted photos, access notes). Separate evidence entries with |.', [
    { key: 'id', label: 'ID', readonly: true }, { key: 'name', label: 'Name' },
    { key: 'classification', label: 'Classification', options: ['official-neighborhood', 'recognized-community', 'local-area-name', 'unincorporated-area'] },
    { key: 'coverage', label: 'Coverage', options: ['active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'] },
    { key: 'localEvidence', label: 'Local evidence', type: 'list' }, { key: 'description', label: 'Sourced description' }, { key: 'source', label: 'Source' }, { key: 'pageId', label: 'Page id' }, { key: 'notes', label: 'Notes' }
  ], { name: '', cityId: 'mobile-al', countyId: 'mobile-county-al', classification: 'official-neighborhood', zipCodes: [], geoReference: '', pickupNotes: '', coverage: 'research-only', pageId: null, localEvidence: [], description: '', source: '', lastVerifiedAt: '2026-11-04', notes: '' });
}

/* ------------------------------------------------------------------ */
/* Sitemap & indexing                                                  */
/* ------------------------------------------------------------------ */
function sitemap() {
  const p = state.summary.pages;
  const site = state.data.business.website;
  const included = p.filter((x) => x.indexable);
  const excluded = p.filter((x) => !x.indexable);
  const reason = (x) => x.status !== 'published' ? `status: ${x.status}` : !pageById(x.id).seo.robotsIndex ? 'robots noindex' : x.blockers.map((b) => b.label).join('; ');
  view.innerHTML = `
    <div class="page-head"><div><h1>Sitemap &amp; indexing</h1><p class="muted">The XML sitemap is generated from approved, canonical, indexable records only. Redirects: ${state.data.redirects.length}.</p></div></div>
    <div class="grid2">
      <div class="panel"><h2>In sitemap (${included.length})</h2><div class="table-wrap" style="max-height:60vh"><table><tbody>${included.map((x) => `<tr><td><button class="link-btn" data-open="${esc(x.id)}">${esc(site + x.path)}</button></td><td>${esc(x.updatedAt)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="panel"><h2>Excluded (${excluded.length})</h2><div class="table-wrap" style="max-height:60vh"><table><tbody>${excluded.map((x) => `<tr><td><button class="link-btn" data-open="${esc(x.id)}">${esc(x.path)}</button></td><td>${pill(x.status)}</td><td><small>${esc(reason(x))}</small></td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="panel"><h2>Redirects</h2>${state.data.redirects.length ? `<table><thead><tr><th>From</th><th>To</th><th>Status</th><th>Note</th></tr></thead><tbody>${state.data.redirects.map((r) => `<tr><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${r.status}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No redirects. They are created automatically when a live URL changes or a live page is archived.</p>'}</div>`;
  bindPageLinks();
}

/* ------------------------------------------------------------------ */
/* Owner verification                                                  */
/* ------------------------------------------------------------------ */
function verification() {
  const d = state.data;
  const pageFacts = d.pages.filter((p) => (p.workflow.ownerVerification || []).length && p.status !== 'archived');
  view.innerHTML = `
    <div class="page-head"><div><h1>Owner verification</h1><p class="muted">Business facts that must be confirmed by the owner before claims can be strengthened or pages published.</p></div></div>
    <div class="panel"><h2>Business-level</h2><ul>${d.business.ownerVerification.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
    <div class="grid2">
      <div class="panel"><h2>Unverified services</h2><ul>${d.services.filter((s) => s.verification === 'unverified').map((s) => `<li><b>${esc(s.name)}</b> — ${esc(s.notes)}</li>`).join('')}</ul></div>
      <div class="panel"><h2>Items with unknown acceptance</h2><ul>${d.items.filter((i) => i.acceptance === 'unknown').map((i) => `<li><b>${esc(i.name)}</b> — ${esc(i.notes || i.publicNote)}</li>`).join('')}</ul></div>
      <div class="panel"><h2>Non-active service areas</h2><ul>${d.locations.filter((l) => l.coverage !== 'active').map((l) => `<li>${esc(l.name)}, ${esc(l.county)} — ${pill(l.coverage)}</li>`).join('')}</ul></div>
      <div class="panel"><h2>Neighborhoods without local evidence</h2><ul>${d.neighborhoods.filter((n) => n.localEvidence.length < 2).map((n) => `<li>${esc(n.name)} — ${n.localEvidence.length} evidence item(s)</li>`).join('')}</ul></div>
    </div>
    <div class="panel"><h2>Page-level facts (${pageFacts.reduce((s, p) => s + p.workflow.ownerVerification.length, 0)})</h2>
      ${pageFacts.map((p) => `<details><summary><button class="link-btn" data-open="${esc(p.id)}">${esc(p.path)}</button> ${pill(p.status)} <b>${p.workflow.ownerVerification.length}</b></summary><ul>${p.workflow.ownerVerification.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>`).join('')}
    </div>`;
  bindPageLinks();
}

/* ------------------------------------------------------------------ */
/* Business settings                                                   */
/* ------------------------------------------------------------------ */
function business() {
  const b = state.data.business;
  view.innerHTML = `
    <div class="page-head"><div><h1>Business settings</h1><p class="muted">Central business facts used across every page and in structured data. Leave unknown values empty — never invent them.</p></div>
      <div class="toolbar"><button class="teal" id="save">Save settings</button></div></div>
    <div class="notice">The phone number is locked to <b>251-930-8621</b> (tel:+12519308621). Claims below may only be enabled once they are true and documented.</div><br>
    <div class="panel"><textarea id="biz" style="min-height:520px">${esc(JSON.stringify(b, null, 2))}</textarea></div>`;
  document.getElementById('save').onclick = async () => {
    let value;
    try { value = JSON.parse(document.getElementById('biz').value); } catch (e) { return toast('Invalid JSON: ' + e.message, true); }
    try { await api('/api/entities/business', { method: 'PUT', body: { value } }); await refresh(); toast('Business settings saved. Rebuild to apply.'); } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ */
/* Build & audits                                                      */
/* ------------------------------------------------------------------ */
function build() {
  view.innerHTML = `
    <div class="page-head"><div><h1>Build &amp; audits</h1><p class="muted">Runs the same commands as CI. A failing content gate stops the build.</p></div></div>
    <div class="toolbar">
      <button data-task="validate-content">Validate content</button>
      <button data-task="build" class="teal">Production build</button>
      <button data-task="validate-dist" class="secondary">Audit built site</button>
      <button data-task="report" class="secondary">Generate report</button>
    </div>
    <pre class="log" id="log">Choose a task.</pre>`;
  view.querySelectorAll('[data-task]').forEach((b) => (b.onclick = async () => {
    const log = document.getElementById('log');
    view.querySelectorAll('[data-task]').forEach((x) => (x.disabled = true));
    log.textContent = `Running ${b.dataset.task}…`;
    try { const r = await api('/api/run', { method: 'POST', body: { task: b.dataset.task } }); log.textContent = `${r.output}\n\nExit code: ${r.code}`; await refresh(); } catch (e) { log.textContent = e.message; }
    view.querySelectorAll('[data-task]').forEach((x) => (x.disabled = false));
  }));
}

route();
