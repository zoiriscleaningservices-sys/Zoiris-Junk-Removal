/* command-center/assets/app.js
 * Zoiris Command Center — private owner app (mobile-first SPA)
 *
 * Daily:          Today · Requests · Map · Schedule
 * Business tools: Business stats · Pipeline · Customers · Photos & videos · Website visits ·
 *                 Google search · Service areas · Website pages · Backups & storage · Settings · Security
 */
(function () {
  'use strict';

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

  const COVERAGE_OPTIONS = [
    'active',
    'available-on-confirmation',
    'limited',
    'temporarily-unavailable',
    'not-serviced',
    'research-only'
  ];

  /* Friendly 5-step path the owner walks every request through. */
  const GUIDED_PATH = [
    { status: 'New', label: 'New' },
    { status: 'Contacted', label: 'Contacted' },
    { status: 'Estimate Sent', label: 'Estimate' },
    { status: 'Pickup Scheduled', label: 'Booked' },
    { status: 'Completed', label: 'Done' }
  ];
  const STATUS_STEP = {
    New: 0,
    Unread: 0,
    Contacted: 1,
    'Awaiting Customer Information': 1,
    'Estimate Being Prepared': 1,
    'Estimate Sent': 2,
    'Pickup Scheduled': 3,
    'Pickup In Progress': 3,
    Completed: 4
  };
  const STATUS_TONE = {
    New: 'new',
    Unread: 'new',
    Contacted: 'follow',
    'Awaiting Customer Information': 'follow',
    'Estimate Being Prepared': 'follow',
    'Estimate Sent': 'quote',
    'Pickup Scheduled': 'booked',
    'Pickup In Progress': 'booked',
    Completed: 'done',
    'Not Converted': 'closed',
    Archived: 'closed',
    Spam: 'closed'
  };
  const TONE_COLOR = {
    new: '#f26b1d',
    follow: '#e3a008',
    quote: '#5b6ee1',
    booked: '#0f766e',
    done: '#2f9e44',
    closed: '#8a94a3'
  };
  const TONE_LABEL = {
    new: 'New',
    follow: 'Following up',
    quote: 'Estimate sent',
    booked: 'Pickup booked',
    done: 'Done',
    closed: 'Closed'
  };

  const LEAD_VIEWS = [
    { id: 'all', label: 'All', statuses: null },
    { id: 'new', label: 'New', statuses: ['New', 'Unread'] },
    { id: 'follow', label: 'Follow up', statuses: ['Contacted', 'Awaiting Customer Information', 'Estimate Being Prepared', 'Estimate Sent'] },
    { id: 'scheduled', label: 'Scheduled', statuses: ['Pickup Scheduled', 'Pickup In Progress'] },
    { id: 'done', label: 'Done', statuses: ['Completed'] },
    { id: 'closed', label: 'Closed / Spam', statuses: ['Not Converted', 'Archived', 'Spam'] },
    { id: 'review', label: 'Needs review', statuses: null, filter: (l) => l.needsReview }
  ];

  const TOOLS = [
    { href: '/owner/stats/', label: 'Business stats', desc: 'All numbers & charts', icon: 'stats' },
    { href: '/owner/pipeline/', label: 'Pipeline board', desc: 'Every stage at a glance', icon: 'pipeline' },
    { href: '/owner/customers/', label: 'Customers', desc: 'History & duplicates', icon: 'customers' },
    { href: '/owner/media/', label: 'Photos & videos', desc: 'All customer uploads', icon: 'media' },
    { href: '/owner/analytics/', label: 'Website visits', desc: 'Traffic & calls', icon: 'eye' },
    { href: '/owner/search-performance/', label: 'Google search', desc: 'Search Console', icon: 'search' },
    { href: '/owner/locations/', label: 'Service areas', desc: 'Where you work', icon: 'areas' },
    { href: '/owner/seo-pages/', label: 'Website pages', desc: 'SEO page drafts', icon: 'pages' },
    { href: '/owner/reports/', label: 'Backups & storage', desc: 'Space & backups', icon: 'backups' },
    { href: '/owner/settings/', label: 'Settings', desc: 'Uploads & alerts', icon: 'settings' },
    { href: '/owner/security/', label: 'Security', desc: 'Devices & password', icon: 'security' }
  ];

  const PAGE_TITLES = {
    '/owner/command-center/': 'Today',
    '/owner/stats/': 'Business stats',
    '/owner/leads/': 'Requests',
    '/owner/map/': 'Map',
    '/owner/calendar/': 'Schedule',
    '/owner/pipeline/': 'Pipeline board',
    '/owner/customers/': 'Customers',
    '/owner/media/': 'Photos & videos',
    '/owner/analytics/': 'Website visits',
    '/owner/search-performance/': 'Google search',
    '/owner/locations/': 'Service areas',
    '/owner/seo-pages/': 'Website pages',
    '/owner/reports/': 'Backups & storage',
    '/owner/settings/': 'Settings',
    '/owner/security/': 'Security'
  };

  const state = {
    owner: null,
    csrfToken: null,
    sessionId: null,
    currentDevice: '',
    deviceKind: 'desktop',
    activeDeviceCount: 1,
    notifications: [],
    prefs: { sound_enabled: 0, desktop_enabled: 0 },
    analyticsRange: '30d',
    searchRange: '30d',
    calYear: null,
    calMonth: null,
    navSeq: 0,
    maps: [],
    toolOpen: {},
    fresh: new Set(),
    detail: null,
    mapLayer: readPref('zoiris.mapLayer', 'street')
  };

  const workspace = document.getElementById('cc-workspace');
  const modal = document.getElementById('cc-modal');
  const modalTitle = document.getElementById('cc-modal-title');
  const modalBody = document.getElementById('cc-modal-body');
  const toastEl = document.getElementById('cc-toast');
  const notifPanel = document.getElementById('cc-notif-panel');
  const notifBtn = document.getElementById('cc-notif-btn');
  const notifCountEl = document.getElementById('cc-notif-count');
  const notifListEl = document.getElementById('cc-notif-list');
  const ssePill = document.getElementById('cc-sse-pill');
  const moreSheet = document.getElementById('cc-more-sheet');
  const moreBtn = document.getElementById('cc-more-btn');
  const sheetScrim = document.getElementById('cc-sheet-scrim');
  const ownerUrl = (p) => (window.zoirisOwnerUrl ? window.zoirisOwnerUrl(p) : p);
  const stripBase = (p) => (window.zoirisStripBase ? window.zoirisStripBase(p) : p);
  const publicUrl = (p) => (window.zoirisPublicUrl ? window.zoirisPublicUrl(p) : p);

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */
  function readPref(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }
  function writePref(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch {}
  }

  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const ICON_PATHS = {
    phone: '<path d="M6.6 3.5h2.6l1.6 4.2-2 1.4a10.6 10.6 0 0 0 6.1 6.1l1.4-2 4.2 1.6v2.6a2 2 0 0 1-2.2 2A16.3 16.3 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
    sms: '<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M8 10.5h8M8 13.5h5"/>',
    directions: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M9.5 14.5v-2.5a1.5 1.5 0 0 1 1.5-1.5h4m-2-2 2 2-2 2"/>',
    streetview: '<circle cx="12" cy="5.8" r="2.3"/><path d="M9.5 21v-5.5H8v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4h-1.5V21"/><path d="M5 18.5c-1.3.5-2 1-2 1.6C3 21.2 7 22 12 22s9-.8 9-1.9c0-.6-.7-1.1-2-1.6"/>',
    pin: '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>',
    camera: '<path d="M4.5 7.5h3l1.5-2h6l1.5 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4"/>',
    video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="m15.5 10.5 5-3v9l-5-3"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    shield: '<path d="M12 3.5 5 6v5.5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17v.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    chevRight: '<path d="m9 5 7 7-7 7"/>',
    chevLeft: '<path d="m15 5-7 7 7 7"/>',
    chevDown: '<path d="m5 9 7 7 7-7"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M10 6H5.5a1 1 0 0 0-1 1v11.5a1 1 0 0 0 1 1H17a1 1 0 0 0 1-1V14"/>',
    stats: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V4"/>',
    pipeline: '<rect x="3.5" y="4.5" width="5" height="15" rx="1.5"/><rect x="9.5" y="4.5" width="5" height="10" rx="1.5"/><rect x="15.5" y="4.5" width="5" height="6.5" rx="1.5"/>',
    customers: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14.8c1.6.6 2.7 2.1 3 4.7"/>',
    media: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4.5 17.5 5-5 3.5 3.5 2.5-2.5 4 4"/>',
    eye: '<path d="M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="12" cy="12" r="2.6"/>',
    areas: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
    pages: '<path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/>',
    backups: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
    security: '<path d="M12 3.5 5 6v5.5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    note: '<path d="M5.5 4.5h13v15h-13z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
    task: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    money: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
    stage: '<path d="M4 6h16M4 12h11M4 18h6"/>',
    history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7"/><path d="M12 8v4l2.5 2"/>',
    exportIco: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5"/>',
    truck: '<path d="M3.5 6.5h10v9h-10zM13.5 9.5h4l3 3.2v2.8h-7"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="17" cy="17" r="1.8"/>',
    sparkle: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5 9 15M15 9l2.5-2.5"/>',
    user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.8 3.7-5.8 7.5-5.8s6.7 2 7.5 5.8"/>',
    list: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
    home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>',
    layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
    smartphone: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2.3"/><path d="M10.5 18h3"/>',
    tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.3"/><path d="M11 18h2"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15 18 9z"/><path d="M10.2 20a2 2 0 0 0 3.6 0"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  };
  function deviceIconName(kind) {
    if (kind === 'phone') return 'smartphone';
    if (kind === 'tablet') return 'tablet';
    return 'monitor';
  }
  function updateDeviceIndicators() {
    const label = state.currentDevice || '';
    const iconName = deviceIconName(state.deviceKind);
    const pill = document.getElementById('cc-device-pill');
    if (pill) {
      if (label) {
        pill.innerHTML = `${ico(iconName)}<span>Logged in from ${esc(label)}</span>`;
        pill.title = `Logged in from ${label}${state.activeDeviceCount > 1 ? ` · ${state.activeDeviceCount} devices signed in` : ''}`;
        pill.hidden = false;
      } else {
        pill.hidden = true;
      }
    }
    const moreDev = document.getElementById('cc-more-device');
    if (moreDev) {
      if (label) {
        moreDev.innerHTML = `${ico(iconName)}<span>Logged in from <strong>${esc(label)}</strong>${state.activeDeviceCount > 1 ? ` · ${esc(state.activeDeviceCount)} devices` : ''}</span>`;
        moreDev.hidden = false;
      } else {
        moreDev.hidden = true;
      }
    }
  }
  function ico(name, cls = '') {
    return `<svg class="cc-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function fmtChicago(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(iso));
    } catch {
      return String(iso).slice(0, 16).replace('T', ' ');
    }
  }

  function todayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  }
  function addDaysIso(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function dayParts(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y) return { wd: '', day: '', mon: '', label: iso || '' };
    const dt = new Date(Date.UTC(y, m - 1, d));
    const f = (o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, o)).format(dt);
    return { wd: f({ weekday: 'short' }), day: String(d), mon: f({ month: 'short' }), label: f({ weekday: 'short', month: 'short', day: 'numeric' }) };
  }
  function chicagoHour() {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date())) % 24;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    const d = Math.floor(s / 86400);
    if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(new Date(iso));
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const a = (parts[0] || '?')[0] || '?';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase().replace(/[^A-Z0-9?]/g, '') || '?';
  }
  function avatar(name, cls = '') {
    const h = [...String(name || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) % 5;
    return `<span class="cc-avatar cc-avatar--${h} ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;
  }
  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'customer';
  }

  function phoneDigits(phone) {
    const d = String(phone || '').replace(/[^\d]/g, '');
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith('1')) return `+${d}`;
    return d;
  }
  const telHref = (p) => `tel:${phoneDigits(p)}`;
  const smsHref = (p) => `sms:${phoneDigits(p)}`;

  function fullAddress(l) {
    const street = [l.pickupAddress, l.addressUnit].filter(Boolean).join(', ');
    return `${street}, ${l.city}, ${l.state} ${l.zipCode}`.replace(/^,\s*/, '').trim();
  }
  function hasGeo(l) {
    return l && l.lat !== null && l.lng !== null && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng));
  }
  function mapLinks(l) {
    const addr = fullAddress(l);
    const geo = hasGeo(l);
    const dest = geo ? `${l.lat},${l.lng}` : addr;
    return {
      directions: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`,
      streetView: geo ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(`${l.lat},${l.lng}`)}` : '',
      apple: `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}`,
      search: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
    };
  }
  function apptLinks(a) {
    const addr = `${a.pickup_address || ''}, ${a.city || ''}, ${a.state || 'AL'} ${a.zip_code || ''}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
  }

  const toneOf = (st) => STATUS_TONE[st] || 'follow';
  const toneColor = (st) => TONE_COLOR[toneOf(st)];

  function statusPill(st, attrs = '') {
    const generic = {
      active: 'done',
      connected: 'done',
      configured: 'done',
      healthy: 'done'
    };
    const tone = STATUS_TONE[st] || generic[st] || (st === 'not-configured' || st === 'not_configured' ? 'closed' : 'neutral');
    return `<span class="cc-pill cc-pill--${tone}" ${attrs}>${esc(st)}</span>`;
  }

  function trustBadges(l, { compact = false } = {}) {
    const out = [];
    if (l.addressStatus === 'verified') {
      out.push(`<span class="cc-badge cc-badge--ok" title="Matched by the U.S. Census Bureau address database">${ico('check')}Address verified</span>`);
    } else if (l.addressStatus === 'map-match') {
      out.push(`<span class="cc-badge cc-badge--info" title="Matched an OpenStreetMap house number">${ico('pin')}Found on map</span>`);
    }
    if (l.needsReview) {
      const flags = (l.spamFlags || []).join(' · ') || 'Address could not be auto-checked';
      out.push(`<span class="cc-badge cc-badge--warn" title="${esc(flags)}">${ico('alert')}Needs review</span>`);
      if (!compact && (l.spamFlags || []).length) {
        out.push(`<span class="cc-badge cc-badge--soft">${esc(l.spamFlags[0])}${l.spamFlags.length > 1 ? ` +${l.spamFlags.length - 1}` : ''}</span>`);
      }
    }
    return out.join('');
  }

  function mediaSummary(l) {
    const p = Number(l.photoCount || 0);
    const v = Number(l.videoCount || 0);
    if (!p && !v) return '<span class="cc-meta">No photos</span>';
    const bits = [];
    if (p) bits.push(`${ico('camera')}${p} photo${p === 1 ? '' : 's'}`);
    if (v) bits.push(`${ico('video')}${v} video${v === 1 ? '' : 's'}`);
    return `<span class="cc-meta cc-meta--media">${bits.join('<span class="cc-dot" aria-hidden="true"></span>')}</span>`;
  }

  function isWide() {
    return window.matchMedia('(min-width: 900px)').matches;
  }

  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.className = isError ? 'cc-toast is-error' : 'cc-toast';
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.hidden = true;
    }, 3600);
  }

  function openModal(title, html) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    if (!modal.open) modal.showModal();
  }
  document.getElementById('cc-modal-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  async function api(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && state.csrfToken) {
      headers['X-Zoiris-CSRF'] = state.csrfToken;
    }
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401) {
      window.location.replace(ownerUrl('/owner/login/') + '?next=' + encodeURIComponent(stripBase(window.location.pathname)));
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  /** Bind a form submit with busy state + friendly error toast. */
  function bindForm(id, handler) {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        await handler(form);
      } catch (err) {
        toast(err.message || 'Something went wrong', true);
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
    });
  }
  function bindClick(el, handler) {
    if (!el) return;
    el.addEventListener('click', async (e) => {
      if (el.disabled) return;
      el.disabled = true;
      try {
        await handler(e);
      } catch (err) {
        toast(err.message || 'Something went wrong', true);
      } finally {
        if (el.isConnected) el.disabled = false;
      }
    });
  }

  /** Responsive table: stacks into labelled cards on phones. */
  function table(headers, rowsHtml, { tbodyId = '', cls = '' } = {}) {
    return `<div class="cc-table-wrap"><table class="cc-table cc-table--stack ${cls}">
      <thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody ${tbodyId ? `id="${tbodyId}"` : ''}>${rowsHtml}</tbody>
    </table></div>`;
  }
  function tr(headers, cells, cls = '') {
    return `<tr class="${cls}">${cells.map((c, i) => `<td data-label="${esc(headers[i] || '')}">${c}</td>`).join('')}</tr>`;
  }

  function pageHead(title, sub = '', actions = '') {
    return `<header class="cc-page-head">
      <div class="cc-page-head__text"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>
      ${actions ? `<div class="cc-page-head__actions">${actions}</div>` : ''}
    </header>`;
  }

  function emptyState(title, body = '', action = '') {
    return `<div class="cc-empty">
      <img class="cc-empty__mark" src="${esc(ownerUrl('/owner/assets/logo-mark.svg'))}" alt="" width="44" height="44" />
      <strong>${title}</strong>${body ? `<span>${body}</span>` : ''}${action}
    </div>`;
  }

  function renderBarList(items, suffix = '') {
    if (!items || !items.length) {
      return '<div class="cc-empty cc-empty--sm">No data yet — this fills in automatically from real activity.</div>';
    }
    const max = Math.max(1, ...items.map((x) => Number(x.value || 0)));
    return `<div class="cc-bar-list">${items
      .map((x) => {
        const val = Number(x.value || 0);
        const pct = Math.max(3, Math.round((val / max) * 100));
        return `<div class="cc-bar-row">
          <div class="cc-bar-row__top"><span>${esc(x.label)}</span><strong>${esc(val)}${esc(suffix)}</strong></div>
          <div class="cc-bar-track"><div class="cc-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
      })
      .join('')}</div>`;
  }

  function renderSvgColumns(series) {
    if (!series || !series.length) {
      return '<div class="cc-empty cc-empty--sm">No requests in the past 30 days yet.</div>';
    }
    const max = Math.max(1, ...series.map((s) => Number(s.value || 0)));
    const w = 520;
    const h = 150;
    const bw = Math.max(10, Math.min(36, Math.floor((w - 20) / series.length) - 4));
    const bars = series
      .map((s, idx) => {
        const bh = Math.max(4, Math.round((Number(s.value || 0) / max) * (h - 34)));
        const x = 14 + idx * (bw + 4);
        const y = h - 22 - bh;
        return `<g>
          <rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="5" fill="#0f766e"></rect>
          <text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" font-size="10" fill="#0b1522">${esc(s.value)}</text>
          <text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="9" fill="#5b6675">${esc(String(s.label).slice(5))}</text>
        </g>`;
      })
      .join('');
    return `<svg viewBox="0 0 ${w} ${h}" class="cc-chart" role="img" aria-label="Requests over time">${bars}</svg>`;
  }

  function renderDonut(items) {
    const total = (items || []).reduce((s, x) => s + Number(x.value || 0), 0);
    if (!total) return '<div class="cc-empty cc-empty--sm">No breakdown recorded yet.</div>';
    const palette = ['#0f766e', '#f26b1d', '#16273d', '#5ec4b6', '#94a3b8'];
    let acc = 0;
    const r = 42;
    const c = 2 * Math.PI * r;
    const segs = items
      .map((item, idx) => {
        const frac = Number(item.value || 0) / total;
        const dash = `${(frac * c).toFixed(2)} ${c.toFixed(2)}`;
        const offset = (-acc * c).toFixed(2);
        acc += frac;
        return `<circle r="${r}" cx="55" cy="55" fill="transparent" stroke="${palette[idx % palette.length]}" stroke-width="18" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" transform="rotate(-90 55 55)"></circle>`;
      })
      .join('');
    const legend = items
      .map(
        (item, idx) => `<div class="cc-legend__row"><span class="cc-legend__sw" style="background:${palette[idx % palette.length]}"></span>
          <span>${esc(item.label)}: <strong>${esc(item.value)}</strong> (${Math.round((Number(item.value || 0) / total) * 100)}%)</span></div>`
      )
      .join('');
    return `<div class="cc-donut"><svg width="110" height="110" viewBox="0 0 110 110" aria-hidden="true">${segs}</svg><div class="cc-legend">${legend}</div></div>`;
  }

  /* ---------------------------------------------------------------------- */
  /* Maps                                                                   */
  /* ---------------------------------------------------------------------- */
  function destroyMaps() {
    state.maps.forEach((m) => {
      try {
        m.destroy();
      } catch {}
    });
    state.maps = [];
  }
  function mountMap(el, opts) {
    if (!el || !window.ZMap) return null;
    const m = window.ZMap.create(
      el,
      Object.assign({ layer: state.mapLayer }, opts, {
        onLayerChange: (layer) => {
          state.mapLayer = layer;
          writePref('zoiris.mapLayer', layer);
        }
      })
    );
    state.maps.push(m);
    return m;
  }
  function leadMarker(l) {
    return {
      id: l.leadNumber,
      lat: Number(l.lat),
      lng: Number(l.lng),
      color: toneColor(l.status),
      glyph: initials(l.fullName),
      title: `${l.fullName} — ${fullAddress(l)} (${l.status})`,
      lead: l
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Alerts, badges & realtime                                              */
  /* ---------------------------------------------------------------------- */
  function playChime() {
    if (!state.prefs.sound_enabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.36);
    } catch {}
  }

  function desktopNotify(title, body) {
    if (!state.prefs.desktop_enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, icon: ownerUrl('/owner/assets/icon-192.png') });
    } catch {}
  }

  async function refreshNotifications() {
    try {
      const res = await api('/api/owner/notifications');
      state.notifications = res.notifications || [];
      state.prefs = res.preferences || state.prefs;
      document.getElementById('cc-sound-toggle').checked = !!state.prefs.sound_enabled;
      document.getElementById('cc-desktop-toggle').checked = !!state.prefs.desktop_enabled;

      const unread = state.notifications.filter((n) => !n.is_read).length;
      notifCountEl.textContent = String(unread > 99 ? '99+' : unread);
      notifCountEl.hidden = unread === 0;

      notifListEl.innerHTML = state.notifications.length
        ? state.notifications
            .slice(0, 25)
            .map(
              (n) => `<div class="cc-notif ${n.is_read ? '' : 'is-unread'}">
                <div class="cc-notif__top">
                  <strong>${esc(n.title)}</strong>
                  <span class="cc-notif__right">
                    <span class="cc-notif__time">${esc(timeAgo(n.created_at))}</span>
                    <button type="button" class="cc-notif__del" data-del-notif="${esc(n.id)}" aria-label="Delete alert">${ico('trash')}</button>
                  </span>
                </div>
                <div class="cc-notif__body">${esc(n.body)}</div>
              </div>`
            )
            .join('')
        : '<div class="cc-empty cc-empty--sm">No alerts yet. New requests show up here.</div>';
    } catch {}
  }

  function setUnreadBadges(u) {
    const n = Number(u || 0);
    ['nav-unread-badge', 'tab-unread-badge'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = String(n > 99 ? '99+' : n);
      el.hidden = n === 0;
    });
  }

  async function refreshUnreadLeadBadge() {
    try {
      const ov = await api('/api/owner/overview');
      setUnreadBadges(ov.kpis?.unreadLeads);
    } catch {}
  }

  function currentPath() {
    return stripBase(window.location.pathname).replace(/\/+$/, '') + '/';
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function sameUint8Bytes(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a.buffer || a, a.byteOffset || 0, a.byteLength);
    const vb = new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength);
    for (let i = 0; i < va.length; i++) {
      if (va[i] !== vb[i]) return false;
    }
    return true;
  }

  async function sha256Prefix24(text) {
    if (!crypto?.subtle || !text) return '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24);
    } catch {
      return '';
    }
  }

  async function ensureOwnerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      let reg = await navigator.serviceWorker.getRegistration(ownerUrl('/owner/'));
      if (!reg) {
        reg = await navigator.serviceWorker.register(ownerUrl('/owner/sw.js'), { scope: ownerUrl('/owner/') });
      }
      return (await navigator.serviceWorker.ready) || reg;
    } catch {
      return null;
    }
  }

  async function getBrowserPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration(ownerUrl('/owner/'));
      if (!reg || !reg.pushManager) return null;
      return await reg.pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  async function getDetailedPushStatus() {
    const fallback = {
      localVaultMode: Boolean(window.__ZOIRIS_LOCAL_VAULT__),
      cloudConnected: !window.__ZOIRIS_LOCAL_VAULT__,
      supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
      vapidPublicKey: '',
      subscriptionCount: 0,
      subscriptions: [],
      relay: {}
    };
    const [ps, browserSub] = await Promise.all([
      api('/api/owner/push/status').catch(() => fallback),
      getBrowserPushSubscription()
    ]);
    const merged = Object.assign({}, fallback, ps || {});
    if (!merged.localVaultMode) merged.cloudConnected = true;

    const permGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    let thisDeviceSubscribed = false;
    if (permGranted && browserSub?.endpoint) {
      if (merged.localVaultMode) {
        const subId = await sha256Prefix24(browserSub.endpoint);
        thisDeviceSubscribed = Boolean(
          merged.cloudConnected &&
            subId &&
            Array.isArray(merged.subscriptions) &&
            merged.subscriptions.some((s) => s.id === subId)
        );
      } else {
        thisDeviceSubscribed = Number(merged.subscriptionCount || 0) > 0;
      }
    }
    merged.thisDeviceSubscribed = thisDeviceSubscribed;
    merged.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    return merged;
  }

  async function subscribeDeviceWebPush(vapidPublicKey, { connectPassword = '', sendWelcome = true } = {}) {
    const pushSupported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!pushSupported) {
      if (window.ZOIRIS_PWA?.isIos() && !window.ZOIRIS_PWA?.isStandalone()) {
        throw new Error(
          'Open the Zoiris app icon directly from your iPhone/iPad Home Screen and tap Turn On Mobile App Notifications there (Apple iOS delivers background push to Home Screen apps).'
        );
      }
      throw new Error('Background push requires an installed mobile app or modern browser with Push notifications enabled.');
    }

    // Critical for iOS 16.4+ Home Screen PWAs: request OS notification permission synchronously inside the user tap gesture before any network await.
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        throw new Error('Allow notifications in your phone or browser settings so alerts can reach your lock screen.');
      }
    }

    let activeVapidKey = String(vapidPublicKey || '').trim();
    if (connectPassword) {
      const conn = await api('/api/owner/push/connect-cloud', {
        method: 'POST',
        body: { password: connectPassword }
      });
      if (conn?.vapidPublicKey) activeVapidKey = conn.vapidPublicKey;
    }

    if (!activeVapidKey) {
      const st = await api('/api/owner/push/status');
      activeVapidKey = String(st?.vapidPublicKey || '').trim();
    }
    if (!activeVapidKey) {
      throw new Error('Push encryption key is not available yet. Please sign in again.');
    }

    const reg = await ensureOwnerServiceWorker();
    if (!reg || !reg.pushManager) {
      throw new Error('App service worker is still starting — tap the button once more in 2 seconds.');
    }

    const desiredServerKey = urlBase64ToUint8Array(activeVapidKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey && !sameUint8Bytes(sub.options.applicationServerKey, desiredServerKey)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: desiredServerKey
        });
      } catch {
        const stale = await reg.pushManager.getSubscription().catch(() => null);
        if (stale) await stale.unsubscribe().catch(() => {});
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: desiredServerKey
        });
      }
    }

    return api('/api/owner/push/subscribe', {
      method: 'POST',
      body: {
        subscription: sub.toJSON(),
        deviceLabel: state.currentDevice || 'Owner Mobile App',
        deviceKind: state.deviceKind || 'phone',
        sendWelcome
      }
    });
  }

  async function copyTextSafe(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      prompt('Copy this:', text);
    }
  }

  function renderPushControlCard(ps, { inModal = false } = {}) {
    const isLocal = Boolean(ps?.localVaultMode ?? window.__ZOIRIS_LOCAL_VAULT__);
    const cloudConnected = Boolean(ps?.cloudConnected || !isLocal);
    const thisDeviceOn = Boolean(ps?.thisDeviceSubscribed);
    const subCount = Number(ps?.subscriptionCount || 0);
    const vapidKey = String(ps?.vapidPublicKey || '');
    const iosNeedsInstall = Boolean(window.ZOIRIS_PWA?.isIos() && !window.ZOIRIS_PWA?.isStandalone());
    const lastSyncText = ps?.lastCloudSyncAt ? ` · Last synced ${esc(timeAgo(ps.lastCloudSyncAt))}` : '';
    const devicesList = Array.isArray(ps?.subscriptions) ? ps.subscriptions : [];

    return `
      <div class="cc-push-box ${inModal ? 'cc-push-box--modal' : ''}">
        <div class="cc-push-step">
          <div class="cc-push-step__head">
            <span class="cc-push-step__num">1</span>
            <div>
              <strong>
                Installed Mobile App Notifications
                ${thisDeviceOn ? '<span class="cc-pill cc-pill--done">Active on this device</span>' : '<span class="cc-pill cc-pill--new">Turn on below</span>'}
              </strong>
              <p class="cc-fine">
                Delivers real lock-screen notifications directly through your installed Zoiris app — even when you are not using the app or your screen is locked (no third-party app needed).
              </p>
            </div>
          </div>

          ${
            iosNeedsInstall
              ? `<div class="cc-alert cc-alert--warn">
                   On iPhone / iPad: tap <strong>Share (⬆) → Add to Home Screen</strong>, then open the <strong>Zoiris</strong> icon from your Home Screen and tap <strong>Turn On Mobile App Notifications</strong> inside the app.
                 </div>`
              : ''
          }

          ${
            isLocal && !cloudConnected
              ? `<form class="cc-form cc-push-pair-form" data-connect-cloud-form data-vapid-key="${esc(vapidKey)}">
                   <div class="cc-field">
                     <label for="connect-cloud-pw-${inModal ? 'm' : 's'}">Confirm owner password once to activate live sync &amp; app notifications</label>
                     <input id="connect-cloud-pw-${inModal ? 'm' : 's'}" class="cc-input" type="password" autocomplete="current-password" placeholder="Enter your owner password" required />
                   </div>
                   <div class="cc-push-actions">
                     <button class="cc-btn cc-btn--primary cc-btn--sm" type="submit" data-connect-mode="push">${ico('bell')}Connect &amp; Turn On Mobile App Notifications</button>
                     <button class="cc-btn cc-btn--ghost cc-btn--sm" type="button" data-connect-sync-only>${ico('shield')}Connect Live Browser Sync Only</button>
                   </div>
                 </form>`
              : `<div class="cc-push-actions">
                   <button type="button" class="cc-btn ${thisDeviceOn ? 'cc-btn--navy' : 'cc-btn--primary'} cc-btn--sm" data-enable-webpush="${esc(vapidKey)}">
                     ${ico('bell')}${thisDeviceOn ? `App notifications active (${Math.max(1, subCount)} device${Math.max(1, subCount) === 1 ? '' : 's'})` : 'Turn On Mobile App Notifications'}
                   </button>
                   <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm" data-send-test-push>${ico('sparkle')}Send test notification</button>
                 </div>`
          }

          ${
            devicesList.length
              ? `<p class="cc-fine cc-push-stores">Receiving background alerts on: ${devicesList
                  .map((d) => `<strong>${esc(d.deviceLabel || 'Owner Device')}</strong>`)
                  .join(', ')}.</p>`
              : ''
          }
        </div>

        <div class="cc-push-step">
          <div class="cc-push-step__head">
            <span class="cc-push-step__num">2</span>
            <div>
              <strong>
                Live Real-Time Browser &amp; App Sync
                ${cloudConnected ? '<span class="cc-pill cc-pill--done">Live 24/7</span>' : '<span class="cc-pill cc-pill--new">Connect above</span>'}
              </strong>
              <p class="cc-fine">${
                cloudConnected
                  ? `Every pickup request submitted on your website appears live in real time on your open browser and mobile app — with customer photos, verified map pin, and chime${lastSyncText}.`
                  : 'Enter your owner password once above to connect real-time website lead sync on this device.'
              }</p>
            </div>
          </div>
          ${
            cloudConnected
              ? `<div class="cc-push-actions">
                   <button type="button" class="cc-btn cc-btn--navy cc-btn--sm" data-sync-relay-now>${ico('history')}Check for new website requests now</button>
                 </div>`
              : ''
          }
        </div>
      </div>`;
  }

  function wirePushControls(container, onRefresh) {
    if (!container) return;
    container.querySelectorAll('[data-enable-webpush]').forEach((btn) =>
      bindClick(btn, async () => {
        const out = await subscribeDeviceWebPush(btn.dataset.enableWebpush);
        toast(`Mobile app notifications enabled (${out.subscriptionCount || 1} device${out.subscriptionCount === 1 ? '' : 's'})!`);
        if (onRefresh) await onRefresh();
      })
    );
    container.querySelectorAll('[data-copy-topic]').forEach((btn) =>
      btn.addEventListener('click', () => copyTextSafe(btn.dataset.copyTopic, 'Topic ID copied!'))
    );
    container.querySelectorAll('[data-copy-pair]').forEach((btn) =>
      btn.addEventListener('click', () => copyTextSafe(btn.dataset.copyPair, 'Link copied!'))
    );
    container.querySelectorAll('[data-send-test-push]').forEach((btn) =>
      bindClick(btn, async () => {
        const out = await api('/api/owner/push/test', {
          method: 'POST',
          body: {
            includeRelay: true,
            clickUrl: window.location.origin + ownerUrl('/owner/command-center/')
          }
        });
        const sentWeb = Number(out.webPush?.sent || 0);
        const sentRelay = Boolean(out.relay?.ok);
        if (sentWeb || sentRelay) {
          toast('Test notification sent! Lock your phone or check your notifications.');
        } else {
          toast('Tap “Turn On Mobile App Notifications” first so this device can receive background alerts.', true);
        }
      })
    );
    container.querySelectorAll('[data-sync-relay-now]').forEach((btn) =>
      bindClick(btn, async () => {
        const out = await api('/api/owner/push/sync-relay', { method: 'POST' });
        if (out.imported > 0) {
          toast(`Synced ${out.imported} new customer request${out.imported === 1 ? '' : 's'}!`);
          refreshNotifications();
          refreshUnreadLeadBadge();
        } else {
          toast('Live & up to date — no missed website requests.');
        }
        if (onRefresh) await onRefresh();
      })
    );
    container.querySelectorAll('[data-dismiss-push-hint]').forEach((btn) =>
      btn.addEventListener('click', () => {
        writePref('zoiris.hidePushHint', '1');
        if (onRefresh) onRefresh();
      })
    );

    const connectForm = container.querySelector('[data-connect-cloud-form]');
    if (connectForm) {
      const pwInput = connectForm.querySelector('input[type="password"]');
      const vapidKey = connectForm.dataset.vapidKey || '';

      connectForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = pwInput?.value || '';
        if (!pw) {
          toast('Enter your owner password first.', true);
          return;
        }
        const submit = connectForm.querySelector('[type="submit"]');
        if (submit) submit.disabled = true;
        try {
          const out = await subscribeDeviceWebPush(vapidKey, { connectPassword: pw });
          toast(`Connected! Mobile app notifications & live sync active (${out.subscriptionCount || 1} device${out.subscriptionCount === 1 ? '' : 's'}).`);
          refreshNotifications();
          refreshUnreadLeadBadge();
          if (onRefresh) await onRefresh();
        } catch (err) {
          toast(err.message || 'Could not enable mobile app notifications', true);
        } finally {
          if (submit && submit.isConnected) submit.disabled = false;
        }
      });

      const syncOnlyBtn = connectForm.querySelector('[data-connect-sync-only]');
      if (syncOnlyBtn) {
        bindClick(syncOnlyBtn, async () => {
          const pw = pwInput?.value || '';
          if (!pw) throw new Error('Enter your owner password first.');
          const out = await api('/api/owner/push/connect-cloud', {
            method: 'POST',
            body: { password: pw }
          });
          toast(`Live real-time browser sync connected!${out.imported ? ` Synced ${out.imported} request(s).` : ''}`);
          refreshNotifications();
          refreshUnreadLeadBadge();
          if (onRefresh) await onRefresh();
        });
      }
    }
  }

  async function openPhoneAlertsModal() {
    const ps = await getDetailedPushStatus();
    openModal('Mobile app notifications & live real-time sync', renderPushControlCard(ps, { inModal: true }));
    wirePushControls(modalBody, async () => {
      await openPhoneAlertsModal();
      const p = currentPath();
      if (p === '/owner/command-center/' || p === '/owner/settings/' || p === '/owner/leads/') softRefresh();
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'zoiris:push-navigate' && ev.data.url) {
        navigate(ev.data.url);
      }
    });
  }

  window.addEventListener('zoiris:vault-lead-synced', (ev) => {
    const { imported, latestLead } = ev.detail || {};
    if (latestLead?.leadNumber) state.fresh.add(latestLead.leadNumber);
    toast(
      latestLead
        ? `New request from ${latestLead.fullName || 'customer'} (${latestLead.leadNumber})`
        : `${imported || 1} new pickup request(s) synced!`
    );
    playChime();
    desktopNotify(
      `New request ${latestLead?.leadNumber || ''}`,
      `${latestLead?.fullName || 'Customer'} — ${latestLead?.requestedService || 'Pickup request'}`
    );
    refreshNotifications();
    refreshUnreadLeadBadge();
    const p = currentPath();
    if (p === '/owner/command-center/' || p === '/owner/leads/' || p === '/owner/map/') softRefresh();
  });

  window.addEventListener('zoiris:vault-lead-deleted', () => {
    refreshNotifications();
    refreshUnreadLeadBadge();
    const p = currentPath();
    if (p === '/owner/command-center/' || p === '/owner/leads/' || p === '/owner/map/') softRefresh();
  });

  function connectRealtime() {
    if (window.__ZOIRIS_LOCAL_VAULT__) {
      const updateLivePill = () => {
        ssePill.textContent = 'Live 24/7';
        ssePill.className = 'cc-live is-live';
        ssePill.title = window.__ZOIRIS_LIVE_CONNECTED__
          ? 'Live real-time stream connected — new website requests appear automatically'
          : 'Live 24/7 sync active — new website requests appear automatically';
      };
      updateLivePill();
      window.addEventListener('zoiris:live-status', updateLivePill);
      return;
    }
    const es = new EventSource('/api/owner/realtime');
    es.addEventListener('connected', () => {
      ssePill.textContent = 'Live';
      ssePill.className = 'cc-live is-live';
      ssePill.title = 'Connected — new requests appear instantly';
    });
    es.addEventListener('lead.created', (ev) => {
      let d = {};
      try {
        d = JSON.parse(ev.data || '{}');
      } catch {}
      if (d.leadNumber) state.fresh.add(d.leadNumber);
      toast(`New request from ${d.fullName || 'a customer'}${d.leadNumber ? ` (${d.leadNumber})` : ''}`);
      playChime();
      desktopNotify(`New request ${d.leadNumber || ''}`, `${d.fullName || ''} — ${d.requestedService || 'Pickup request'}`);
      refreshNotifications();
      refreshUnreadLeadBadge();
      const p = currentPath();
      if (p === '/owner/command-center/' || p === '/owner/leads/' || p === '/owner/map/') softRefresh();
    });
    es.addEventListener('media.uploaded', (ev) => {
      let d = {};
      try {
        d = JSON.parse(ev.data || '{}');
      } catch {}
      toast(`Customer uploaded a ${d.mediaKind || 'file'} for ${d.leadNumber || 'a request'}`);
      playChime();
      refreshNotifications();
      const p = currentPath();
      if (p.startsWith('/owner/leads/') && p !== '/owner/leads/' && !window.ZViewer?.isOpen()) softRefresh();
    });
    es.addEventListener('lead.updated', () => refreshUnreadLeadBadge());
    es.addEventListener('lead.status_changed', () => refreshUnreadLeadBadge());
    es.addEventListener('lead.deleted', () => {
      refreshUnreadLeadBadge();
      const p = currentPath();
      if (p === '/owner/command-center/' || p === '/owner/leads/' || p === '/owner/map/') softRefresh();
    });
    es.onerror = () => {
      ssePill.textContent = 'Reconnecting…';
      ssePill.className = 'cc-live is-retry';
    };
  }

  /** Re-render the current view without losing the user's place (skips while typing). */
  function softRefresh() {
    const a = document.activeElement;
    if (a && workspace.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (modal.open) return;
    route({ keepScroll: true });
  }

  /* ---------------------------------------------------------------------- */
  /* Navigation, sheet & shell wiring                                       */
  /* ---------------------------------------------------------------------- */
  function navigate(path) {
    const clean = stripBase(path);
    const full = ownerUrl(clean);
    if (window.location.pathname + window.location.search !== full) {
      history.pushState(null, '', full);
    }
    closeSheet();
    closeNotif();
    route();
  }

  function openSheet() {
    moreSheet.hidden = false;
    sheetScrim.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('cc-sheet-open');
    const first = moreSheet.querySelector('a, button');
    if (first) first.focus();
  }
  function closeSheet() {
    if (moreSheet.hidden) return;
    moreSheet.hidden = true;
    sheetScrim.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('cc-sheet-open');
  }
  function closeNotif() {
    notifPanel.hidden = true;
    notifBtn.setAttribute('aria-expanded', 'false');
  }

  document.getElementById('cc-more-grid').innerHTML = TOOLS.map(
    (t) => `<a class="cc-tile" href="${ownerUrl(t.href)}" data-spa>
      <span class="cc-tile__ico">${ico(t.icon)}</span>
      <span class="cc-tile__label">${esc(t.label)}</span>
      <span class="cc-tile__desc">${esc(t.desc)}</span>
    </a>`
  ).join('');

  moreBtn.addEventListener('click', () => (moreSheet.hidden ? openSheet() : closeSheet()));
  sheetScrim.addEventListener('click', closeSheet);
  moreSheet.querySelectorAll('[data-close-sheet]').forEach((b) => b.addEventListener('click', closeSheet));

  // swipe-down to close the sheet
  (() => {
    let y0 = null;
    moreSheet.addEventListener('touchstart', (e) => (y0 = e.touches[0].clientY), { passive: true });
    moreSheet.addEventListener(
      'touchend',
      (e) => {
        if (y0 !== null && e.changedTouches[0].clientY - y0 > 70 && moreSheet.scrollTop <= 0) closeSheet();
        y0 = null;
      },
      { passive: true }
    );
  })();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!moreSheet.hidden) closeSheet();
      if (!notifPanel.hidden) closeNotif();
    }
  });

  document.addEventListener('click', (e) => {
    const pushTrigger = e.target.closest('[data-setup-push]');
    if (pushTrigger) {
      e.preventDefault();
      openPhoneAlertsModal();
      return;
    }
    const installTrigger = e.target.closest('[data-install-app]');
    if (installTrigger) {
      e.preventDefault();
      openInstallPhoneGuide();
      return;
    }
    const logTrigger = e.target.closest('[data-log-lead]');
    if (logTrigger) {
      e.preventDefault();
      openNewLeadModal();
      return;
    }
    const a = e.target.closest('a[data-route], a[data-spa]');
    const rawHref = a?.getAttribute('href') || '';
    const cleanHref = stripBase(rawHref);
    if (a && cleanHref.startsWith('/owner/') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      if (modal.open && modal.contains(a)) modal.close();
      navigate(cleanHref);
      return;
    }
    if (!notifPanel.hidden && !notifPanel.contains(e.target) && !notifBtn.contains(e.target)) closeNotif();
  });

  window.addEventListener('popstate', () => {
    closeSheet();
    route();
  });

  notifBtn.addEventListener('click', () => {
    const show = notifPanel.hidden;
    notifPanel.hidden = !show;
    notifBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) refreshNotifications();
  });
  document.getElementById('cc-close-notif-btn').addEventListener('click', closeNotif);
  document.getElementById('cc-mark-read-btn').addEventListener('click', async () => {
    try {
      await api('/api/owner/notifications/read-all', { method: 'POST' });
      await refreshNotifications();
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.getElementById('cc-clear-notif-btn')?.addEventListener('click', async () => {
    if (!state.notifications.length) return;
    if (!confirm('Delete all alerts?')) return;
    try {
      await api('/api/owner/notifications', { method: 'DELETE' });
      toast('All alerts deleted');
      await refreshNotifications();
    } catch (err) {
      toast(err.message, true);
    }
  });
  notifListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-notif]');
    if (!btn) return;
    try {
      await api(`/api/owner/notifications/${encodeURIComponent(btn.dataset.delNotif)}`, { method: 'DELETE' });
      await refreshNotifications();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const saveQuickNotifToggles = async () => {
    const soundEnabled = document.getElementById('cc-sound-toggle').checked;
    let desktopEnabled = document.getElementById('cc-desktop-toggle').checked;
    if (desktopEnabled && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      desktopEnabled = p === 'granted';
      document.getElementById('cc-desktop-toggle').checked = desktopEnabled;
    }
    try {
      await api('/api/owner/notification-preferences', {
        method: 'PUT',
        body: {
          inAppEnabled: true,
          soundEnabled,
          desktopEnabled,
          emailEnabled: !!state.prefs.email_enabled,
          emailAddress: state.prefs.email_address || state.owner?.email || '',
          smsEnabled: !!state.prefs.sms_enabled,
          smsPhone: state.prefs.sms_phone || ''
        }
      });
      state.prefs.sound_enabled = soundEnabled ? 1 : 0;
      state.prefs.desktop_enabled = desktopEnabled ? 1 : 0;
      if (soundEnabled) playChime();
    } catch (err) {
      toast(err.message, true);
    }
  };
  document.getElementById('cc-sound-toggle').addEventListener('change', saveQuickNotifToggles);
  document.getElementById('cc-desktop-toggle').addEventListener('change', saveQuickNotifToggles);

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {}
    window.location.replace(ownerUrl('/owner/login/'));
  }
  document.getElementById('cc-logout-btn').addEventListener('click', logout);
  document.getElementById('cc-logout-btn-m').addEventListener('click', logout);

  const installBtnMobile = document.getElementById('cc-install-btn-m');
  function syncInstallButtons() {
    if (!installBtnMobile) return;
    installBtnMobile.hidden = Boolean(window.ZOIRIS_PWA?.isStandalone());
  }
  syncInstallButtons();
  window.addEventListener('zoiris:pwa-ready', syncInstallButtons);
  window.addEventListener('zoiris:pwa-installed', () => {
    syncInstallButtons();
    toast('Zoiris App installed on your device!');
  });
  installBtnMobile?.addEventListener('click', () => {
    closeSheet();
    openInstallPhoneGuide();
  });

  async function openInstallPhoneGuide() {
    if (window.ZOIRIS_PWA?.canPrompt()) {
      const outcome = await window.ZOIRIS_PWA.triggerInstall();
      if (outcome === 'accepted') return;
    }
    const isIos = Boolean(window.ZOIRIS_PWA?.isIos());
    openModal(
      'Download Zoiris App on your phone',
      isIos
        ? `<div class="cc-alert cc-alert--ok"><strong>iPhone / iPad (Safari):</strong><br/>1. Tap the <strong>Share</strong> button (square with arrow at the bottom of Safari).<br/>2. Scroll down and tap <strong>Add to Home Screen</strong> → <strong>Add</strong>.</div>
           <p class="cc-fine">Once added, Zoiris opens full-screen from your Home Screen with its own icon and stays ready 24/7.</p>`
        : `<div class="cc-alert cc-alert--ok"><strong>Android / Chrome / Edge:</strong><br/>1. Tap the browser menu (<strong>⋮</strong> in the top-right corner).<br/>2. Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</div>
           <p class="cc-fine">Once installed, Zoiris opens full-screen from your Home Screen with its own icon and stays ready 24/7.</p>`
    );
  }

  function openNewLeadModal() {
    openModal(
      'Log a pickup request',
      `<form id="quick-lead-form" class="cc-form">
        <div class="cc-form-row">
          <div class="cc-field"><label for="ql-name">Customer name</label><input id="ql-name" class="cc-input" type="text" placeholder="Jane Smith" required /></div>
          <div class="cc-field"><label for="ql-phone">Phone number</label><input id="ql-phone" class="cc-input" type="tel" inputmode="tel" placeholder="251-555-0199" required /></div>
        </div>
        <div class="cc-field"><label for="ql-addr">Pickup street address</label><input id="ql-addr" class="cc-input" type="text" placeholder="104 Dauphin St" required /></div>
        <div class="cc-form-row">
          <div class="cc-field"><label for="ql-city">City</label><input id="ql-city" class="cc-input" type="text" value="Mobile" required /></div>
          <div class="cc-field"><label for="ql-zip">ZIP code</label><input id="ql-zip" class="cc-input" type="text" inputmode="numeric" value="36602" required /></div>
        </div>
        <div class="cc-form-row">
          <div class="cc-field"><label for="ql-svc">Service</label>
            <select id="ql-svc" class="cc-select">
              <option value="Junk Removal">Junk Removal</option>
              <option value="Furniture Removal">Furniture Removal</option>
              <option value="Appliance Removal">Appliance Removal</option>
              <option value="Garage &amp; Property Cleanouts">Garage &amp; Property Cleanout</option>
              <option value="Electronics &amp; E-Waste Pickup">Electronics &amp; E-Waste Pickup</option>
              <option value="Commercial Junk Removal">Commercial Junk Removal</option>
            </select>
          </div>
          <div class="cc-field"><label for="ql-date">Preferred date (optional)</label><input id="ql-date" class="cc-input" type="date" /></div>
        </div>
        <div class="cc-field"><label for="ql-desc">What needs to be picked up?</label><textarea id="ql-desc" class="cc-textarea" rows="2" placeholder="Sectional sofa, old fridge in garage…"></textarea></div>
        <div class="cc-field"><label for="ql-files">Photos or videos (camera or gallery)</label><input id="ql-files" class="cc-input" type="file" accept="image/*,video/*" multiple /></div>
        <button class="cc-btn cc-btn--primary cc-btn--lg cc-btn--block" type="submit">${ico('plus')}Save request</button>
      </form>`
    );
    bindForm('quick-lead-form', async () => {
      const files = Array.from(document.getElementById('ql-files')?.files || []);
      const svc = document.getElementById('ql-svc').value;
      const created = await api('/api/owner/leads', {
        method: 'POST',
        body: {
          fullName: document.getElementById('ql-name').value.trim(),
          phone: document.getElementById('ql-phone').value.trim(),
          pickupAddress: document.getElementById('ql-addr').value.trim(),
          city: document.getElementById('ql-city').value.trim(),
          zipCode: document.getElementById('ql-zip').value.trim(),
          requestedService: svc,
          hasElectronics: /electronic|e-waste/i.test(svc),
          preferredDate: document.getElementById('ql-date').value,
          itemDescription: document.getElementById('ql-desc').value.trim() || svc,
          expectedFiles: files.length
        }
      });
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        if (created.uploadToken) {
          fd.append('uploadToken', created.uploadToken);
          await fetch('/api/public/uploads', { method: 'POST', body: fd });
        } else {
          await api(`/api/owner/leads/${encodeURIComponent(created.lead.id)}/media`, { method: 'POST', body: fd });
        }
      }
      if (created.uploadToken && files.length) {
        await fetch('/api/public/uploads/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadToken: created.uploadToken })
        }).catch(() => {});
      }
      modal.close();
      toast(`Saved ${created.lead.leadNumber}`);
      refreshUnreadLeadBadge();
      navigate(`/owner/leads/${encodeURIComponent(created.lead.leadNumber)}`);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Shared lead card                                                       */
  /* ---------------------------------------------------------------------- */
  function leadNeeds(l) {
    const chips = [];
    if (l.requestedService) chips.push(`<span class="cc-chip cc-chip--service">${esc(l.requestedService)}</span>`);
    (l.itemCategories || []).slice(0, 3).forEach((c) => chips.push(`<span class="cc-chip">${esc(c)}</span>`));
    if (l.hasElectronics) chips.push('<span class="cc-chip cc-chip--teal">E-Waste</span>');
    return chips.join('');
  }

  function leadCard(l) {
    const href = `/owner/leads/${encodeURIComponent(l.leadNumber)}`;
    const links = mapLinks(l);
    const fresh = state.fresh.has(l.leadNumber) ? 'is-fresh' : '';
    return `<article class="cc-req ${l.isUnread ? 'is-unread' : ''} ${fresh}" data-lead-card="${esc(l.leadNumber)}" style="--tone:${toneColor(l.status)}">
      <a class="cc-req__main" href="${href}" data-spa>
        ${avatar(l.fullName)}
        <span class="cc-req__body">
          <span class="cc-req__top">
            <strong class="cc-req__name">${esc(l.fullName)}</strong>
            <span class="cc-req__time">${esc(timeAgo(l.createdAt))}</span>
          </span>
          <span class="cc-req__where">${ico('pin')}<span>${esc(l.pickupAddress || '')}${l.pickupAddress ? ' · ' : ''}${esc(l.city)}</span></span>
          <span class="cc-req__chips">${leadNeeds(l)}</span>
          <span class="cc-req__meta">
            ${statusPill(l.status)}
            ${mediaSummary(l)}
            <span class="cc-meta cc-meta--ref">${esc(l.leadNumber)}</span>
          </span>
          <span class="cc-req__trust">${trustBadges(l, { compact: true })}</span>
        </span>
      </a>
      <div class="cc-req__actions">
        <a class="cc-qa cc-qa--call" href="${telHref(l.phone)}" aria-label="Call ${esc(l.fullName)}">${ico('phone')}<span>Call</span></a>
        <a class="cc-qa" href="${smsHref(l.phone)}" aria-label="Text ${esc(l.fullName)}">${ico('sms')}<span>Text</span></a>
        <a class="cc-qa" href="${links.directions}" target="_blank" rel="noopener" aria-label="Directions to ${esc(l.fullName)}">${ico('directions')}<span>Go</span></a>
        <button type="button" class="cc-qa cc-qa--del" data-del-lead="${esc(l.id)}" data-del-label="${esc(l.leadNumber)} (${esc(l.fullName)})" aria-label="Delete request ${esc(l.leadNumber)}">${ico('trash')}</button>
      </div>
    </article>`;
  }

  workspace.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-lead]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const label = btn.dataset.delLabel || 'this request';
    if (!confirm(`Permanently delete ${label} and any attached photos/videos? This frees storage space and cannot be undone.`)) return;
    btn.disabled = true;
    try {
      const out = await api(`/api/owner/leads/${encodeURIComponent(btn.dataset.delLead)}`, { method: 'DELETE' });
      toast(`Deleted ${out.leadNumber || 'request'}${out.mediaBytesFreed ? ` · freed ${fmtBytes(out.mediaBytesFreed)}` : ''}`);
      refreshUnreadLeadBadge();
      route({ keepScroll: true });
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  });

  function scheduleFresh() {
    if (!state.fresh.size) return;
    clearTimeout(scheduleFresh._t);
    scheduleFresh._t = setTimeout(() => state.fresh.clear(), 6000);
  }

  /* ---------------------------------------------------------------------- */
  /* 1. TODAY (/owner/command-center/)                                      */
  /* ---------------------------------------------------------------------- */
  async function renderToday(seq) {
    const today = todayIso();
    const [ov, list, cal, pins, pushSt] = await Promise.all([
      api('/api/owner/overview'),
      api('/api/owner/leads?pageSize=60'),
      api(`/api/owner/calendar?from=${today}&to=${addDaysIso(today, 13)}`),
      api('/api/owner/map/pins').catch(() => ({ pins: [] })),
      getDetailedPushStatus().catch(() => null)
    ]);
    if (seq !== state.navSeq) return;
    const k = ov.kpis || {};
    setUnreadBadges(k.unreadLeads);

    const waiting = (list.leads || []).filter((l) => l.status === 'New' || l.status === 'Unread');
    const oldest = waiting.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    const appts = (cal.appointments || []).filter((a) => a.status === 'scheduled' || a.status === 'in_progress');
    const todays = appts.filter((a) => a.scheduled_date === today);
    const upcoming = appts.filter((a) => a.scheduled_date > today).slice(0, 5);
    const hour = chicagoHour();
    const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = esc(firstName(state.owner?.displayName || ''));
    const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

    let focus;
    if (waiting.length && oldest) {
      focus = `<article class="cc-focus cc-focus--urgent" data-today-focus>
        <div class="cc-focus__art" aria-hidden="true"></div>
        <p class="cc-focus__eyebrow">${ico('sparkle')} Your focus right now</p>
        <h2 class="cc-focus__title"><span class="cc-focus__num">${waiting.length}</span> new request${waiting.length === 1 ? '' : 's'} waiting for a call</h2>
        <p class="cc-focus__sub">Waiting longest: <strong>${esc(oldest.fullName)}</strong> · ${esc(oldest.city)} · ${esc(timeAgo(oldest.createdAt))}</p>
        <div class="cc-focus__actions">
          <a class="cc-btn cc-btn--primary cc-btn--lg" href="${telHref(oldest.phone)}">${ico('phone')}Call ${esc(firstName(oldest.fullName))}</a>
          <a class="cc-btn cc-btn--glass cc-btn--lg" href="/owner/leads/${encodeURIComponent(oldest.leadNumber)}" data-spa>See request ${ico('chevRight')}</a>
        </div>
      </article>`;
    } else if (todays.length) {
      const a = todays[0];
      focus = `<article class="cc-focus cc-focus--route" data-today-focus>
        <div class="cc-focus__art" aria-hidden="true"></div>
        <p class="cc-focus__eyebrow">${ico('truck')} On the road today</p>
        <h2 class="cc-focus__title"><span class="cc-focus__num">${todays.length}</span> pickup${todays.length === 1 ? '' : 's'} today</h2>
        <p class="cc-focus__sub">First up: <strong>${esc(a.customer_name)}</strong> · ${esc(a.time_window)} · ${esc(a.pickup_address)}, ${esc(a.city)}</p>
        <div class="cc-focus__actions">
          <a class="cc-btn cc-btn--primary cc-btn--lg" href="${apptLinks(a)}" target="_blank" rel="noopener">${ico('directions')}Directions</a>
          <a class="cc-btn cc-btn--glass cc-btn--lg" href="/owner/leads/${encodeURIComponent(a.lead_number)}" data-spa>Open job ${ico('chevRight')}</a>
        </div>
      </article>`;
    } else {
      focus = `<article class="cc-focus cc-focus--calm" data-today-focus>
        <div class="cc-focus__art" aria-hidden="true"></div>
        <p class="cc-focus__eyebrow">${ico('check')} Nothing urgent</p>
        <h2 class="cc-focus__title">You're all caught up.</h2>
        <p class="cc-focus__sub">New requests pop up here the moment a customer sends one — with their photos, address and map.</p>
        <div class="cc-focus__actions">
          <a class="cc-btn cc-btn--glass cc-btn--lg" href="/owner/leads/" data-spa>Browse requests ${ico('chevRight')}</a>
        </div>
      </article>`;
    }

    const big = [
      ['Waiting for a call', k.leadsAwaitingContact, '/owner/leads/?view=new', 'new'],
      ['Pickups booked', k.scheduledPickups, '/owner/leads/?view=scheduled', 'booked'],
      ['New this week', k.leadsThisWeek, '/owner/leads/', 'quote'],
      ['Jobs done', k.completedJobs, '/owner/leads/?view=done', 'done']
    ];

    const attention = waiting.slice(0, 8);
    const agendaRow = (a) => {
      const dp = dayParts(a.scheduled_date);
      return `<li class="cc-agenda__item">
        <span class="cc-datebadge ${a.scheduled_date === today ? 'is-today' : ''}"><span>${esc(a.scheduled_date === today ? 'Today' : dp.wd)}</span><strong>${esc(dp.day)}</strong></span>
        <a class="cc-agenda__body" href="/owner/leads/${encodeURIComponent(a.lead_number)}" data-spa>
          <strong>${esc(a.customer_name)}</strong>
          <span>${ico('clock')}${esc(a.time_window)}</span>
          <span>${ico('pin')}${esc(a.pickup_address)}, ${esc(a.city)}</span>
        </a>
        <a class="cc-iconbtn cc-iconbtn--tint" href="${apptLinks(a)}" target="_blank" rel="noopener" aria-label="Directions to ${esc(a.customer_name)}">${ico('directions')}</a>
      </li>`;
    };

    const recent = (ov.recentLeads || []).slice(0, 5);
    const pinList = (pins.pins || []).filter(hasGeo);

    workspace.innerHTML = `
      <div class="cc-today">
        <header class="cc-hello">
          <p class="cc-eyebrow">${esc(dateLabel)}</p>
          <h1>${hello}${name ? `, ${name}` : ''}</h1>
          ${
            state.currentDevice
              ? `<a class="cc-hello__device" href="${ownerUrl('/owner/security/')}" data-spa>${ico(deviceIconName(state.deviceKind))}<span>Logged in from <strong>${esc(state.currentDevice)}</strong>${state.activeDeviceCount > 1 ? ` · ${esc(state.activeDeviceCount)} devices` : ''}</span></a>`
              : ''
          }
          <div class="cc-hello__actions">
            <button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-log-lead>${ico('plus')}Log request</button>
            <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm" data-setup-push>${ico('bell')}Phone alerts</button>
            ${!window.ZOIRIS_PWA?.isStandalone() ? `<button type="button" class="cc-btn cc-btn--navy cc-btn--sm" data-install-app>${ico('smartphone')}Download on phone</button>` : ''}
          </div>
        </header>

        ${focus}

        ${
          pushSt && ((pushSt.localVaultMode && !pushSt.cloudConnected) || (!pushSt.thisDeviceSubscribed && !readPref('zoiris.hidePushHint', '')))
            ? `<section class="cc-push-banner" aria-label="Background phone notifications">
                 <div class="cc-push-banner__text">
                   <strong>${ico('bell')}${
                     pushSt.localVaultMode && !pushSt.cloudConnected
                       ? 'Activate live real-time sync &amp; mobile app alerts'
                       : 'Get mobile notifications even when Zoiris is closed'
                   }</strong>
                   <span>${
                     pushSt.localVaultMode && !pushSt.cloudConnected
                       ? 'Tap below and enter your owner password once so new website leads appear live and notify your installed app 24/7.'
                       : 'Tap once below to allow lock-screen alerts directly from your installed Zoiris app whenever a customer submits a pickup form.'
                   }</span>
                 </div>
                 <div class="cc-push-banner__btns">
                   ${
                     pushSt.localVaultMode && !pushSt.cloudConnected
                       ? `<button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-setup-push>${ico('bell')}Connect &amp; turn on alerts</button>`
                       : `<button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-enable-webpush="${esc(pushSt.vapidPublicKey || '')}">${ico('bell')}Turn On Mobile App Notifications</button>
                          <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm" data-dismiss-push-hint>Later</button>`
                   }
                 </div>
               </section>`
            : ''
        }

        <section class="cc-big4" aria-label="Quick numbers">
          ${big
            .map(
              ([label, val, href, tone]) => `<a class="cc-big cc-big--${tone}" href="${href}" data-spa>
                <span class="cc-big__num">${esc(val ?? 0)}</span>
                <span class="cc-big__label">${esc(label)}</span>
              </a>`
            )
            .join('')}
        </section>

        <section class="cc-section">
          <div class="cc-sec-head">
            <h2>Needs a call</h2>
            <a href="/owner/leads/?view=new" data-spa>See all ${ico('chevRight')}</a>
          </div>
          ${
            attention.length
              ? `<div class="cc-swipe" role="list">${attention
                  .map((l) => `<div class="cc-swipe__item" role="listitem">${leadCard(l)}</div>`)
                  .join('')}</div>`
              : emptyState('No one is waiting on you', 'Every new request has been handled. Nice work.')
          }
        </section>

        <div class="cc-today__cols">
          <section class="cc-section">
            <div class="cc-sec-head">
              <h2>Pickups</h2>
              <a href="/owner/calendar/" data-spa>Schedule ${ico('chevRight')}</a>
            </div>
            <div class="cc-card cc-card--flush">
              ${
                todays.length || upcoming.length
                  ? `<ul class="cc-agenda">${todays.concat(upcoming).map(agendaRow).join('')}</ul>`
                  : emptyState('No pickups booked yet', 'Open a request and tap “Book the pickup” to put it on your schedule.')
              }
            </div>
          </section>

          <section class="cc-section">
            <div class="cc-sec-head">
              <h2>Where the jobs are</h2>
              <a href="/owner/map/" data-spa>Open map ${ico('chevRight')}</a>
            </div>
            ${
              pinList.length
                ? `<div class="cc-card cc-card--flush cc-minimap-card"><div class="cc-minimap" data-mini-map aria-label="Map of active requests"></div></div>`
                : `<div class="cc-card cc-card--flush">${emptyState('No pins yet', 'Active requests with a checked address appear on the map automatically.')}</div>`
            }
          </section>
        </div>

        <section class="cc-section">
          <div class="cc-sec-head">
            <h2>Latest requests</h2>
            <a href="/owner/leads/" data-spa>All requests ${ico('chevRight')}</a>
          </div>
          <div class="cc-card cc-card--flush">
            ${
              recent.length
                ? `<ul class="cc-mini-list">${recent
                    .map(
                      (l) => `<li><a href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa class="${state.fresh.has(l.leadNumber) ? 'is-fresh' : ''}">
                        ${avatar(l.fullName, 'cc-avatar--sm')}
                        <span class="cc-mini-list__body"><strong>${esc(l.fullName)}</strong><span>${esc(l.requestedService)} · ${esc(l.city)} · ${esc(l.leadNumber)}</span></span>
                        ${statusPill(l.status)}
                      </a></li>`
                    )
                    .join('')}</ul>`
                : emptyState('No requests yet', 'When a customer fills out the pickup form on your website it lands right here.')
            }
          </div>
        </section>

        <a class="cc-seeall" href="/owner/stats/" data-spa>${ico('stats')}See all business numbers ${ico('chevRight')}</a>
      </div>`;

    const mini = workspace.querySelector('[data-mini-map]');
    if (mini) {
      mountMap(mini, {
        markers: pinList.map(leadMarker),
        fit: true,
        fitPadding: { top: 56, right: 60, bottom: 32, left: 20 },
        maxFitZoom: 14,
        onMarkerClick: (m) => navigate(`/owner/map/?lead=${encodeURIComponent(m.id)}`)
      });
    }
    wirePushControls(workspace.querySelector('.cc-push-banner'), () => renderToday(state.navSeq));
    scheduleFresh();
  }

  /* ---------------------------------------------------------------------- */
  /* 2. BUSINESS STATS (/owner/stats/) — 15 KPIs + 9 charts                 */
  /* ---------------------------------------------------------------------- */
  async function renderStats(seq) {
    const d = await api('/api/owner/overview');
    if (seq !== state.navSeq) return;
    const k = d.kpis;
    setUnreadBadges(k.unreadLeads);

    const kpiCards = [
      ['Total Leads', k.totalLeads, 'cc-kpi--teal'],
      ['New Leads', k.newLeads, 'cc-kpi--accent'],
      ['Unread Leads', k.unreadLeads, 'cc-kpi--accent'],
      ['Leads Awaiting Contact', k.leadsAwaitingContact, ''],
      ['Quotes Awaiting Response', k.quotesAwaitingResponse, ''],
      ['Scheduled Pickups', k.scheduledPickups, 'cc-kpi--teal'],
      ['In-Progress Jobs', k.inProgressJobs, ''],
      ['Completed Jobs', k.completedJobs, 'cc-kpi--teal'],
      ['Lost Opportunities', k.lostOpportunities, ''],
      ['Leads Today', k.leadsToday, ''],
      ['Leads This Week', k.leadsThisWeek, ''],
      ['Leads This Month', k.leadsThisMonth, ''],
      ['Pending Customer Uploads', k.pendingCustomerUploads, ''],
      ['Total Registered Customers', k.totalRegisteredCustomers, ''],
      ['Active Service Areas', k.activeServiceAreas, 'cc-kpi--teal']
    ];
    const H = ['Ref', 'Customer', 'Location', 'Service', 'Media', 'Status'];

    workspace.innerHTML = `
      ${pageHead(
        'Business stats',
        `Every number comes from real records in your CRM (${esc(d.timezone)}). Nothing is estimated or made up.`,
        `<a class="cc-btn cc-btn--ghost cc-btn--sm" href="/api/owner/exports/leads.csv">${ico('download')}Export CSV</a>`
      )}

      <section class="cc-kpi-grid" aria-label="15 key numbers">
        ${kpiCards
          .map(
            ([label, val, cls]) => `<div class="cc-kpi ${cls}">
              <div class="cc-kpi__val">${esc(val)}</div>
              <div class="cc-kpi__label">${esc(label)}</div>
            </div>`
          )
          .join('')}
      </section>

      <div class="cc-grid-3">
        <div class="cc-card"><h2>Requests over time (30 days)</h2>${renderSvgColumns(d.charts.leadsOverTime)}</div>
        <div class="cc-card"><h2>Where requests come from</h2>${renderBarList(d.charts.leadSources)}</div>
        <div class="cc-card"><h2>Requests by city</h2>${renderBarList(d.charts.submissionsByLocation)}</div>
        <div class="cc-card"><h2>Services requested</h2>${renderBarList(d.charts.serviceRequests)}</div>
        <div class="cc-card"><h2>Homes vs. businesses</h2>${renderDonut(d.charts.residentialVsCommercial)}</div>
        <div class="cc-card"><h2>Electronics vs. general junk</h2>${renderDonut(d.charts.electronicsVsGeneralJunk)}</div>
        <div class="cc-card"><h2>New vs. completed</h2>${renderBarList(d.charts.newVsCompleted)}</div>
        <div class="cc-card"><h2>Phone vs. computer</h2>${renderDonut(d.charts.mobileVsDesktop)}</div>
        <div class="cc-card"><h2>Conversion rates</h2>${renderBarList(
          d.charts.conversionRates.map((c) => ({ label: `${c.label} (n=${c.denominator})`, value: c.value })),
          '%'
        )}</div>
      </div>

      <div class="cc-grid-2">
        <div class="cc-card">
          <h2>Recent requests</h2>
          ${
            d.recentLeads.length
              ? table(
                  H,
                  d.recentLeads
                    .map((l) =>
                      tr(
                        H,
                        [
                          `<a href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa><strong>${esc(l.leadNumber)}</strong></a>`,
                          `${esc(l.fullName)}<br/><small>${esc(l.phone)}</small>`,
                          `${esc(l.city)}, ${esc(l.state)}`,
                          esc(l.requestedService),
                          `${l.photoCount}P / ${l.videoCount}V`,
                          statusPill(l.status)
                        ],
                        l.isUnread ? 'is-unread' : ''
                      )
                    )
                    .join('')
                )
              : emptyState('No requests yet')
          }
        </div>
        <div class="cc-card">
          <h2>Latest activity</h2>
          ${
            d.recentActivity.length
              ? `<ul class="cc-timeline">${d.recentActivity
                  .map(
                    (ev) => `<li>
                      <div class="cc-timeline__top"><a href="/owner/leads/${encodeURIComponent(ev.lead_number)}" data-spa><strong>${esc(ev.lead_number)}</strong></a><small>${fmtChicago(ev.created_at)}</small></div>
                      <div>${esc(ev.summary)}</div>
                    </li>`
                  )
                  .join('')}</ul>`
              : emptyState('No activity yet', 'Activity appears in real time as requests arrive and move along.')
          }
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /* 3. REQUESTS (/owner/leads/)                                            */
  /* ---------------------------------------------------------------------- */
  async function fetchLeadsForView(view, q, page) {
    if (view.statuses) {
      const results = await Promise.all(
        view.statuses.map((s) => api(`/api/owner/leads?status=${encodeURIComponent(s)}&pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}`))
      );
      const leads = results.flatMap((r) => r.leads || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { leads, total: leads.length, page: 1, totalPages: 1 };
    }
    if (view.filter) {
      const r = await api(`/api/owner/leads?pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      const leads = (r.leads || []).filter(view.filter);
      return { leads, total: leads.length, page: 1, totalPages: 1 };
    }
    return api(`/api/owner/leads?pageSize=25&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  }

  async function renderLeads(seq) {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('q') || '';
    const view = LEAD_VIEWS.find((v) => v.id === sp.get('view')) || LEAD_VIEWS[0];
    const res = await fetchLeadsForView(view, q, 1);
    if (seq !== state.navSeq) return;

    const chipHref = (id) => {
      const n = new URLSearchParams();
      if (id !== 'all') n.set('view', id);
      if (q) n.set('q', q);
      return `/owner/leads/${n.toString() ? '?' + n.toString() : ''}`;
    };

    workspace.innerHTML = `
      ${pageHead(
        'Requests',
        `${res.total} ${view.id === 'all' ? 'active' : view.label.toLowerCase()} request${res.total === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}`,
        `<button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-log-lead>${ico('plus')}Log request</button>
         <a class="cc-btn cc-btn--ghost cc-btn--sm" href="/api/owner/exports/leads.csv">${ico('download')}Export CSV</a>
         ${res.leads.length ? `<button id="leads-purge-view" type="button" class="cc-btn cc-btn--danger cc-btn--sm">${ico('trash')}Delete ${q || view.id !== 'all' ? `shown (${res.leads.length})` : `all (${res.total})`}</button>` : ''}`
      )}

      <form id="leads-filter-form" class="cc-search" role="search">
        ${ico('search')}
        <input id="lf-q" type="search" value="${esc(q)}" placeholder="Search name, phone, street, ZIP or ZJ-…" aria-label="Search requests" enterkeyhint="search" />
        ${q ? `<a class="cc-search__clear" href="${view.id === 'all' ? '/owner/leads/' : `/owner/leads/?view=${view.id}`}" data-spa aria-label="Clear search">${ico('plus', 'cc-ico--x')}</a>` : ''}
      </form>

      <nav class="cc-chips" aria-label="Filter requests">
        ${LEAD_VIEWS.map(
          (v) => `<a class="cc-chipnav ${v.id === view.id ? 'is-on' : ''}" href="${chipHref(v.id)}" data-spa ${v.id === view.id ? 'aria-current="page"' : ''}>${esc(v.label)}</a>`
        ).join('')}
      </nav>

      <div class="cc-req-list" data-lead-list>
        ${res.leads.length ? res.leads.map(leadCard).join('') : emptyState(q ? 'No matches' : 'Nothing here right now', q ? 'Try a different name, phone number or street.' : 'Requests in this group will show up here.')}
      </div>
      ${res.page < res.totalPages ? `<button type="button" id="leads-more" class="cc-btn cc-btn--ghost cc-btn--block">Show more requests</button>` : ''}
    `;

    let page = res.page;
    let totalPages = res.totalPages;
    const moreBtnEl = document.getElementById('leads-more');
    bindClick(moreBtnEl, async () => {
      const next = await fetchLeadsForView(view, q, page + 1);
      page = next.page;
      totalPages = next.totalPages;
      workspace.querySelector('[data-lead-list]').insertAdjacentHTML('beforeend', next.leads.map(leadCard).join(''));
      if (page >= totalPages) moreBtnEl.remove();
    });

    document.getElementById('leads-filter-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = document.getElementById('lf-q').value.trim();
      const n = new URLSearchParams();
      if (view.id !== 'all') n.set('view', view.id);
      if (v) n.set('q', v);
      navigate(`/owner/leads/${n.toString() ? '?' + n.toString() : ''}`);
    });

    bindClick(document.getElementById('leads-purge-view'), async () => {
      const label = q || view.id !== 'all' ? `these ${res.leads.length} shown request(s)` : `all ${res.total} request(s)`;
      if (!confirm(`Permanently delete ${label} and all attached photos/videos from storage? This cannot be undone.`)) return;
      const body =
        !q && view.id === 'all'
          ? { all: true }
          : !q && view.statuses
            ? { statuses: view.statuses }
            : { leadIds: res.leads.map((x) => x.id) };
      const out = await api('/api/owner/leads/bulk-delete', { method: 'POST', body });
      toast(`Deleted ${out.deletedLeads} request(s) · freed ${fmtBytes(out.bytesFreed || 0)}`);
      refreshUnreadLeadBadge();
      renderLeads(state.navSeq);
    });
    scheduleFresh();
  }

  /* ---------------------------------------------------------------------- */
  /* 4. REQUEST DETAIL (/owner/leads/:leadNumber)                           */
  /* ---------------------------------------------------------------------- */
  function tool(name, title, iconName, body, { defaultOpen = false, badge = '' } = {}) {
    const open = Object.prototype.hasOwnProperty.call(state.toolOpen, name) ? state.toolOpen[name] : defaultOpen && isWide();
    return `<details class="cc-tool" data-tool="${name}" ${open ? 'open' : ''}>
      <summary>
        <span class="cc-tool__ico">${ico(iconName)}</span>
        <span class="cc-tool__title">${title}</span>
        ${badge ? `<span class="cc-tool__badge">${badge}</span>` : ''}
        <span class="cc-tool__chev">${ico('chevDown')}</span>
      </summary>
      <div class="cc-tool__body">${body}</div>
    </details>`;
  }

  function nextStepFor(l) {
    const step = STATUS_STEP[l.status];
    if (step === undefined) return { label: 'Reopen this request', status: 'Contacted', icon: 'history' };
    if (step === 0) return { label: `I reached ${firstName(l.fullName)} — mark Contacted`, status: 'Contacted', icon: 'phone' };
    if (step === 1) return { label: 'I sent the estimate', status: 'Estimate Sent', icon: 'money' };
    if (step === 2) return { label: 'Book the pickup', action: 'schedule', icon: 'calendar' };
    if (step === 3) return { label: 'Job done — mark Completed', status: 'Completed', icon: 'check' };
    return null;
  }

  function addressSourceText(l) {
    if (l.addressSource === 'census' || l.addressSource === 'us-census') return 'Matched by the U.S. Census Bureau address database.';
    if (l.addressSource === 'openstreetmap') return 'Matched an OpenStreetMap house number.';
    if (l.addressSource === 'mock') return 'Checked by the offline test geocoder.';
    return 'We couldn’t auto-check this address — confirm it with the customer on the phone.';
  }

  function factRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="cc-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  }

  async function renderLeadDetail(idOrNumber, seq = state.navSeq) {
    const d = await api(`/api/owner/leads/${encodeURIComponent(idOrNumber)}`);
    if (seq !== state.navSeq) return;
    const l = d.lead;
    state.detail = { id: idOrNumber, loadedAt: Date.now(), attachments: d.attachments };
    refreshUnreadLeadBadge();
    destroyMaps();

    const links = mapLinks(l);
    const geo = hasGeo(l);
    const step = STATUS_STEP[l.status];
    const next = nextStepFor(l);
    const addr = fullAddress(l);
    const photos = d.attachments.filter((a) => a.mediaKind === 'photo').length;
    const videos = d.attachments.length - photos;
    const openTasks = d.followUps.filter((t) => t.status === 'open').length;

    const pathHtml = `<ol class="cc-path" aria-label="Request progress">
      ${GUIDED_PATH.map((p, i) => {
        const cls = step === undefined ? '' : i < step ? 'is-done' : i === step ? 'is-current' : '';
        return `<li class="${cls}" ${i === step ? 'aria-current="step"' : ''}><span class="cc-path__dot">${i < step ? ico('check') : i + 1}</span><span class="cc-path__label">${esc(p.label)}</span></li>`;
      }).join('')}
    </ol>`;

    const mediaHtml = d.attachments.length
      ? `<div class="cc-media-grid cc-media-grid--lead">
          ${d.attachments
            .map(
              (att, i) => `<figure class="cc-media-item" data-att-card="${esc(att.id)}">
                <button type="button" class="cc-media-preview" data-view-index="${i}" aria-label="Open ${att.mediaKind === 'photo' ? 'photo' : 'video'} ${i + 1} of ${d.attachments.length} full screen">
                  ${
                    att.mediaKind === 'photo'
                      ? `<img src="${esc(att.previewUrl)}" alt="${esc(att.safeFilename)}" />`
                      : `<video src="${esc(att.streamUrl)}" preload="metadata" muted playsinline></video><span class="cc-media-play">${ico('play')}</span>`
                  }
                  <span class="cc-media-kind">${att.mediaKind === 'photo' ? ico('camera') : ico('video')}${att.mediaKind === 'photo' ? 'Photo' : 'Video'}</span>
                </button>
                <figcaption class="cc-media-meta">
                  <span class="cc-media-meta__text"><span class="cc-media-name">${esc(att.safeFilename)}</span><span class="cc-muted">${fmtBytes(att.byteSize)}</span></span>
                  <span class="cc-media-actions">
                    <a class="cc-iconbtn cc-iconbtn--sm" href="${esc(att.downloadUrl)}" download="${esc(att.safeFilename)}" aria-label="Download ${esc(att.safeFilename)}">${ico('download')}</a>
                    <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-del-att="${esc(att.id)}" aria-label="Delete ${esc(att.safeFilename)}">${ico('trash')}</button>
                  </span>
                </figcaption>
              </figure>`
            )
            .join('')}
        </div>`
      : emptyState('No photos or videos', 'The customer didn’t attach any. Ask them to text a few pictures if you need a closer look.');

    const items = d.items.length
      ? d.items
          .map(
            (it) =>
              `<span class="cc-chip ${it.requires_confirmation ? 'cc-chip--amber' : it.is_electronics ? 'cc-chip--teal' : ''}">${esc(it.category)}: ${esc(it.item_name)}</span>`
          )
          .join('')
      : '<span class="cc-chip">See description</span>';

    const access = [l.indoorsOrOutdoors, l.floorLevel, l.hasStairs, l.elevatorAvailable ? `Elevator: ${l.elevatorAvailable}` : '']
      .filter(Boolean)
      .map(esc)
      .join(' · ');

    const apptList = d.appointments.length
      ? `<ul class="cc-stack-list">${d.appointments
          .map(
            (a) => `<li class="cc-appt"><span class="cc-appt__when">${ico('calendar')}<strong>${esc(dayParts(a.scheduled_date).label)}</strong> · ${esc(a.time_window)}</span>
              <span class="cc-inline-actions">
                <span class="cc-pill cc-pill--${a.status === 'completed' ? 'done' : a.status === 'cancelled' ? 'closed' : 'booked'}">${esc(a.status)}</span>
                <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-del-appt="${esc(a.id)}" aria-label="Delete scheduled pickup">${ico('trash')}</button>
              </span>
              ${a.instructions ? `<span class="cc-appt__note">${esc(a.instructions)}</span>` : ''}</li>`
          )
          .join('')}</ul>`
      : '';

    workspace.innerHTML = `
      <a class="cc-back" href="/owner/leads/" data-spa>${ico('back')}Requests</a>

      <section class="cc-lead-hero" style="--tone:${toneColor(l.status)}">
        <div class="cc-lead-hero__top">
          ${avatar(l.fullName, 'cc-avatar--lg')}
          <div class="cc-lead-hero__id">
            <h1>${esc(l.fullName)}</h1>
            <p class="cc-lead-hero__sub"><span data-lead-status>${statusPill(l.status)}</span><span>${esc(l.leadNumber)}</span><span>${esc(timeAgo(l.createdAt))}</span></p>
          </div>
        </div>
        <a class="cc-lead-hero__addr" href="${links.directions}" target="_blank" rel="noopener">
          ${ico('pin')}<span><strong>${esc(addr)}</strong>${l.countyName ? `<small>${esc(l.countyName)}</small>` : ''}</span>
        </a>
        <div class="cc-lead-hero__trust">${trustBadges(l)}</div>
        <div class="cc-actions4">
          <a class="cc-action cc-action--call" href="${telHref(l.phone)}">${ico('phone')}<span>Call</span></a>
          <a class="cc-action" href="${smsHref(l.phone)}">${ico('sms')}<span>Text</span></a>
          <a class="cc-action" href="${links.directions}" target="_blank" rel="noopener">${ico('directions')}<span>Directions</span></a>
          ${
            geo
              ? `<a class="cc-action" href="${links.streetView}" target="_blank" rel="noopener">${ico('streetview')}<span>Street View</span></a>`
              : `<a class="cc-action" href="${links.search}" target="_blank" rel="noopener">${ico('external')}<span>Google Maps</span></a>`
          }
        </div>
      </section>

      <div class="cc-detail">
        <div class="cc-detail__main">
          <section class="cc-card cc-next">
            <div class="cc-card__head"><h2>Next step</h2>${step !== undefined ? `<span class="cc-muted">Step ${Math.min(step + 1, 5)} of 5</span>` : `<span class="cc-muted">Closed</span>`}</div>
            ${pathHtml}
            ${
              next
                ? `<button id="ld-next-step" type="button" class="cc-btn cc-btn--primary cc-btn--lg cc-btn--block" ${next.status ? `data-next-status="${esc(next.status)}"` : 'data-next-action="schedule"'}>${ico(next.icon)}${esc(next.label)}</button>`
                : `<div class="cc-done-banner">${ico('check')}Job completed${l.completedAt ? ` · ${esc(fmtChicago(l.completedAt))}` : ''}</div>`
            }
            <div class="cc-next__alt">
              <button id="ld-mark-complete" type="button" class="cc-btn cc-btn--ghost cc-btn--sm" ${l.status === 'Completed' ? 'disabled' : ''}>${ico('check')}Mark completed</button>
              <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm" data-quick-status="Not Converted" ${l.status === 'Not Converted' ? 'disabled' : ''}>Not interested</button>
              <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm cc-btn--warn" data-quick-status="Spam" ${l.status === 'Spam' ? 'disabled' : ''}>Spam</button>
              <button id="ld-delete-lead" type="button" class="cc-btn cc-btn--danger cc-btn--sm">${ico('trash')}Delete request</button>
            </div>
          </section>

          <section class="cc-card cc-mapcard">
            <div class="cc-card__head"><h2>${ico('pin')}Pickup location</h2>${l.addressStatus === 'verified' ? '<span class="cc-badge cc-badge--ok">' + ico('check') + 'Verified</span>' : l.addressStatus === 'map-match' ? '<span class="cc-badge cc-badge--info">Map match</span>' : '<span class="cc-badge cc-badge--warn">Not verified</span>'}</div>
            ${
              geo
                ? `<div class="cc-map" data-lead-map aria-label="Map of ${esc(addr)}. Use arrow keys to move, plus and minus to zoom."></div>`
                : `<div class="cc-map-fallback">
                    ${ico('pin')}
                    <strong>${esc(addr)}</strong>
                    <span>This address couldn’t be placed on the map automatically.</span>
                    <a class="cc-btn cc-btn--navy" href="${links.search}" target="_blank" rel="noopener">${ico('external')}Open in Google Maps</a>
                  </div>`
            }
            <dl class="cc-facts cc-facts--tight">
              ${factRow('Typed address', esc(addr))}
              ${l.matchedAddress && l.matchedAddress.toLowerCase() !== addr.toLowerCase() ? factRow('Matched as', esc(l.matchedAddress)) : ''}
              ${factRow('County', esc(l.countyName || '—'))}
              ${factRow('Check', esc(addressSourceText(l)))}
            </dl>
            <div class="cc-linkrow">
              ${geo ? `<a href="${links.streetView}" target="_blank" rel="noopener">${ico('streetview')}Street View</a>` : ''}
              <a href="${links.directions}" target="_blank" rel="noopener">${ico('directions')}Google directions</a>
              <a href="${links.apple}" target="_blank" rel="noopener">${ico('external')}Apple Maps</a>
              ${geo ? `<a href="/owner/map/?lead=${encodeURIComponent(l.leadNumber)}" data-spa>${ico('layers')}Big map</a>` : ''}
            </div>
          </section>

          <section class="cc-card">
            <div class="cc-card__head">
              <h2>${ico('media')}Photos &amp; videos</h2>
              <span class="cc-inline-actions">
                <span class="cc-muted">${photos} photo${photos === 1 ? '' : 's'} · ${videos} video${videos === 1 ? '' : 's'}</span>
                ${window.__ZOIRIS_LOCAL_VAULT__ ? `<input id="ld-upload-input" type="file" accept="image/*,video/*" multiple hidden /><button id="ld-add-media" type="button" class="cc-btn cc-btn--navy cc-btn--sm">${ico('camera')}Add</button>` : ''}
                ${d.attachments.length ? `<button id="ld-del-all-media" type="button" class="cc-btn cc-btn--danger cc-btn--sm">${ico('trash')}Delete all (${d.attachments.length})</button>` : ''}
              </span>
            </div>
            ${mediaHtml}
            ${d.attachments.length ? '<p class="cc-fine">Tap any photo or video to see it full screen. Files are private and links expire after a few minutes.</p>' : ''}
          </section>

          ${
            l.needsReview
              ? `<section class="cc-card cc-review">
                  <div class="cc-card__head"><h2>${ico('alert')}Double-check this one</h2><span class="cc-muted">Spam score ${esc(l.spamScore)}/100</span></div>
                  <ul class="cc-flags">${(l.spamFlags || []).length ? l.spamFlags.map((f) => `<li>${esc(f)}</li>`).join('') : '<li>Address could not be auto-verified</li>'}</ul>
                  <p class="cc-fine">This doesn’t mean it’s fake — just give them a quick call to confirm before driving out.</p>
                </section>`
              : ''
          }

          <section class="cc-card">
            <div class="cc-card__head"><h2>${ico('truck')}What they need</h2></div>
            <div class="cc-chiprow">${items}</div>
            <dl class="cc-facts">
              ${factRow('Service', esc(l.requestedService))}
              ${factRow('Amount', `${esc(l.estimatedQuantity || '—')}${l.estimatedDimensions ? ` (${esc(l.estimatedDimensions)})` : ''}`)}
              ${factRow('Description', esc(l.itemDescription || '—'))}
              ${l.otherItemDescription ? factRow('Other item', esc(l.otherItemDescription)) : ''}
              ${factRow('Access', access || '—')}
              ${factRow('Disassembly', esc(l.disassembledStatus || '—'))}
              ${factRow('Preferred time', `${esc(l.preferredDate || 'Flexible')} ${esc(l.preferredWindow || '')}`)}
              ${factRow('Access notes', esc(l.accessInstructions || 'None provided'))}
              ${l.customerNotes ? factRow('Customer notes', esc(l.customerNotes)) : ''}
            </dl>
          </section>

          <section class="cc-card">
            <div class="cc-card__head"><h2>${ico('user')}Customer</h2></div>
            <dl class="cc-facts">
              ${factRow('Phone', `<a href="${telHref(l.phone)}">${esc(l.phone)}</a>`)}
              ${factRow('Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—')}
              ${factRow('Prefers', esc(l.preferredContact || '—'))}
              ${factRow('Type', esc(l.customerType || '—'))}
              ${factRow('Submitted', `${esc(fmtChicago(l.createdAt))} · ${esc(l.deviceCategory || '')}`)}
              ${factRow('Found you via', `<code>${esc(l.sourcePagePath || l.sourceType || '—')}</code>`)}
              ${factRow('Campaign / referrer', esc([l.utmSource, l.utmMedium, l.utmCampaign].filter(Boolean).join(' / ') || l.referrerUrl || 'Direct'))}
            </dl>
          </section>
        </div>

        <aside class="cc-detail__side" aria-label="Tools">
          ${tool(
            'schedule',
            'Schedule pickup',
            'calendar',
            `${apptList}
            <form id="ld-appt-form" class="cc-form">
              <div class="cc-form-row">
                <div class="cc-field"><label for="ld-appt-date">Pickup date</label><input id="ld-appt-date" class="cc-input" type="date" value="${esc(l.preferredDate || '')}" required /></div>
                <div class="cc-field"><label for="ld-appt-win">Time window</label>
                  <select id="ld-appt-win" class="cc-select">
                    <option value="8:00 AM – 11:00 AM">8:00 AM – 11:00 AM</option>
                    <option value="11:00 AM – 2:00 PM">11:00 AM – 2:00 PM</option>
                    <option value="2:00 PM – 5:00 PM">2:00 PM – 5:00 PM</option>
                  </select>
                </div>
              </div>
              <div class="cc-field"><label for="ld-appt-inst">Notes for the crew</label><input id="ld-appt-inst" class="cc-input" type="text" value="${esc(l.accessInstructions || '')}" /></div>
              <button class="cc-btn cc-btn--primary cc-btn--block" type="submit">${ico('calendar')}Put it on the schedule</button>
            </form>`,
            { defaultOpen: true, badge: d.appointments.length ? String(d.appointments.length) : '' }
          )}
          ${tool(
            'estimate',
            'Estimate &amp; priority',
            'money',
            `<form id="ld-fields-form" class="cc-form">
              <div class="cc-form-row">
                <div class="cc-field"><label for="ld-estimate">Estimate ($)</label><input id="ld-estimate" class="cc-input" type="number" inputmode="decimal" step="0.01" min="0" value="${l.estimateCents !== null && l.estimateCents !== undefined ? (l.estimateCents / 100).toFixed(2) : ''}" /></div>
                <div class="cc-field"><label for="ld-priority">Priority</label>
                  <select id="ld-priority" class="cc-select">${['low', 'normal', 'high', 'urgent'].map((p) => `<option value="${p}" ${l.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
                </div>
              </div>
              <div class="cc-field"><label for="ld-est-notes">What the estimate covers</label><textarea id="ld-est-notes" class="cc-textarea" rows="2">${esc(l.estimateNotes || '')}</textarea></div>
              <button class="cc-btn cc-btn--navy cc-btn--block" type="submit">Save estimate</button>
            </form>`,
            { defaultOpen: true, badge: l.estimateCents !== null && l.estimateCents !== undefined ? `$${(l.estimateCents / 100).toFixed(0)}` : '' }
          )}
          ${tool(
            'notes',
            'Notes &amp; call log',
            'note',
            `<form id="ld-note-form" class="cc-form">
              <div class="cc-field"><label for="ld-note-type">Type</label>
                <select id="ld-note-type" class="cc-select">
                  <option value="internal_note">Note to self</option>
                  <option value="phone_call">I called them</option>
                  <option value="text_interaction">I texted them</option>
                  <option value="email_interaction">I emailed them</option>
                </select>
              </div>
              <div class="cc-field"><label for="ld-note-body">What happened?</label><textarea id="ld-note-body" class="cc-textarea" rows="3" required></textarea></div>
              <button class="cc-btn cc-btn--primary cc-btn--block" type="submit">Save note</button>
              <p class="cc-fine">Private — nothing is sent to the customer.</p>
            </form>
            ${
              d.notes.length
                ? `<ul class="cc-notes">${d.notes
                    .map(
                      (n) => `<li><div class="cc-notes__top"><strong>${esc(String(n.note_type).replace(/_/g, ' '))}</strong><span class="cc-inline-actions"><small>${esc(fmtChicago(n.created_at))}</small><button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-del-note="${esc(n.id)}" aria-label="Delete note">${ico('trash')}</button></span></div><div>${esc(n.body)}</div><small class="cc-muted">${esc(n.author_name)}</small></li>`
                    )
                    .join('')}</ul>`
                : ''
            }`,
            { defaultOpen: true, badge: d.notes.length ? String(d.notes.length) : '' }
          )}
          ${tool(
            'tasks',
            'Follow-up reminders',
            'task',
            `${
              d.followUps.length
                ? `<ul class="cc-stack-list">${d.followUps
                    .map(
                      (t) => `<li class="cc-task ${t.status === 'open' ? '' : 'is-done'}"><span><strong>${esc(t.due_date)}</strong> · ${esc(t.title)}</span>
                        <span class="cc-inline-actions">
                          ${t.status === 'open' ? `<button type="button" class="cc-btn cc-btn--sm cc-btn--ghost" data-complete-task="${esc(t.id)}">${ico('check')}Done</button>` : `<span class="cc-pill cc-pill--done">${esc(t.status)}</span>`}
                          <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-del-task="${esc(t.id)}" aria-label="Delete reminder">${ico('trash')}</button>
                        </span></li>`
                    )
                    .join('')}</ul>`
                : ''
            }
            <form id="ld-task-form" class="cc-form">
              <div class="cc-field"><label for="ld-task-title">Remind me to…</label><input id="ld-task-title" class="cc-input" type="text" placeholder="Call back after reviewing photos" required /></div>
              <div class="cc-field"><label for="ld-task-due">On</label><input id="ld-task-due" class="cc-input" type="date" required /></div>
              <button class="cc-btn cc-btn--ghost cc-btn--block" type="submit">${ico('plus')}Add reminder</button>
            </form>`,
            { badge: openTasks ? String(openTasks) : '' }
          )}
          ${tool(
            'stage',
            'All stages',
            'stage',
            `<form id="ld-status-form" class="cc-form">
              <div class="cc-field"><label for="ld-status-sel">Move to stage</label>
                <select id="ld-status-sel" class="cc-select">${PIPELINE_STATUSES.map((s) => `<option value="${esc(s)}" ${l.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
              </div>
              <div class="cc-field"><label for="ld-status-note">Note (optional)</label><input id="ld-status-note" class="cc-input" type="text" placeholder="Why it moved…" /></div>
              <button class="cc-btn cc-btn--navy cc-btn--block" type="submit">Update stage</button>
            </form>`
          )}
          ${tool(
            'timeline',
            'History',
            'history',
            `<ul class="cc-timeline" data-lead-timeline>
              ${d.timeline
                .map(
                  (ev) => `<li>
                    <div class="cc-timeline__top"><strong>${esc(ev.event_type)}</strong><small>${esc(fmtChicago(ev.created_at))}</small></div>
                    <div>${esc(ev.summary)}</div>
                    <small class="cc-muted">${esc(ev.actor_label)}</small>
                  </li>`
                )
                .join('')}
            </ul>`,
            { badge: String(d.timeline.length) }
          )}
          ${tool(
            'export',
            'Export',
            'exportIco',
            `<div class="cc-row cc-row--wrap">
              <a class="cc-btn cc-btn--ghost" href="/api/owner/leads/${encodeURIComponent(l.leadNumber)}/export?format=json" data-export-link="json">${ico('download')}JSON</a>
              <a class="cc-btn cc-btn--ghost" href="/api/owner/leads/${encodeURIComponent(l.leadNumber)}/export?format=csv" data-export-link="csv">${ico('download')}CSV</a>
            </div>`
          )}
        </aside>
      </div>
    `;

    // Map
    const mapEl = workspace.querySelector('[data-lead-map]');
    if (mapEl) {
      mountMap(mapEl, { center: [Number(l.lat), Number(l.lng)], zoom: 17, markers: [leadMarker(l)] });
    }

    // Remember which tools are open across re-renders
    workspace.querySelectorAll('details.cc-tool').forEach((det) =>
      det.addEventListener('toggle', () => {
        state.toolOpen[det.dataset.tool] = det.open;
      })
    );

    const rerender = () => renderLeadDetail(idOrNumber);
    const setStatus = async (status, note) => {
      await api(`/api/owner/leads/${encodeURIComponent(l.id)}/status`, { method: 'POST', body: { status, note } });
    };

    const nextBtn = document.getElementById('ld-next-step');
    bindClick(nextBtn, async () => {
      if (nextBtn.dataset.nextAction === 'schedule') {
        const det = workspace.querySelector('[data-tool="schedule"]');
        det.open = true;
        state.toolOpen.schedule = true;
        det.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        setTimeout(() => document.getElementById('ld-appt-date')?.focus({ preventScroll: true }), 250);
        return;
      }
      await setStatus(nextBtn.dataset.nextStatus, 'Updated from Next step');
      toast(`Moved to ${nextBtn.dataset.nextStatus}`);
      await rerender();
    });

    bindClick(document.getElementById('ld-mark-complete'), async () => {
      await setStatus('Completed', 'Marked completed from Lead Detail');
      toast('Request marked Completed');
      await rerender();
    });

    workspace.querySelectorAll('[data-quick-status]').forEach((b) =>
      bindClick(b, async () => {
        const st = b.dataset.quickStatus;
        if (!confirm(st === 'Spam' ? 'Mark this request as spam? It will be hidden from your lists.' : 'Mark this request as not interested?')) return;
        await setStatus(st, 'Quick action from Lead Detail');
        toast(`Marked ${st}`);
        await rerender();
      })
    );

    bindForm('ld-status-form', async () => {
      await setStatus(document.getElementById('ld-status-sel').value, document.getElementById('ld-status-note').value);
      toast('Stage updated');
      await rerender();
    });

    bindForm('ld-fields-form', async () => {
      await api(`/api/owner/leads/${encodeURIComponent(l.id)}`, {
        method: 'PATCH',
        body: {
          priority: document.getElementById('ld-priority').value,
          estimateDollars: document.getElementById('ld-estimate').value,
          estimateNotes: document.getElementById('ld-est-notes').value
        }
      });
      toast('Estimate saved');
      await rerender();
    });

    bindForm('ld-appt-form', async () => {
      await api('/api/owner/calendar', {
        method: 'POST',
        body: {
          leadId: l.id,
          scheduledDate: document.getElementById('ld-appt-date').value,
          timeWindow: document.getElementById('ld-appt-win').value,
          instructions: document.getElementById('ld-appt-inst').value
        }
      });
      toast('Pickup added to your schedule');
      await rerender();
    });

    bindForm('ld-task-form', async () => {
      await api(`/api/owner/leads/${encodeURIComponent(l.id)}/follow-ups`, {
        method: 'POST',
        body: {
          title: document.getElementById('ld-task-title').value,
          dueDate: document.getElementById('ld-task-due').value
        }
      });
      toast('Reminder added');
      await rerender();
    });

    workspace.querySelectorAll('[data-complete-task]').forEach((b) =>
      bindClick(b, async () => {
        await api(`/api/owner/follow-ups/${encodeURIComponent(b.dataset.completeTask)}`, { method: 'PATCH', body: { status: 'completed' } });
        toast('Reminder done');
        await rerender();
      })
    );

    bindForm('ld-note-form', async () => {
      await api(`/api/owner/leads/${encodeURIComponent(l.id)}/notes`, {
        method: 'POST',
        body: {
          noteType: document.getElementById('ld-note-type').value,
          body: document.getElementById('ld-note-body').value
        }
      });
      toast('Note saved');
      await rerender();
    });

    // Fullscreen viewer (re-fetches signed URLs if they may have expired)
    workspace.querySelectorAll('[data-view-index]').forEach((b) =>
      b.addEventListener('click', async () => {
        let atts = state.detail.attachments;
        if (Date.now() - state.detail.loadedAt > 3 * 60 * 1000) {
          try {
            const fresh = await api(`/api/owner/leads/${encodeURIComponent(l.id)}`);
            atts = fresh.attachments;
            state.detail = { id: idOrNumber, loadedAt: Date.now(), attachments: atts };
          } catch {}
        }
        openViewer(atts, Number(b.dataset.viewIndex));
      })
    );

    workspace.querySelectorAll('[data-del-att]').forEach((b) =>
      bindClick(b, async () => {
        if (!confirm('Permanently delete this photo/video from private storage?')) return;
        await api(`/api/owner/media/${encodeURIComponent(b.dataset.delAtt)}`, { method: 'DELETE' });
        toast('File deleted');
        await rerender();
      })
    );

    const uploadBtn = document.getElementById('ld-add-media');
    const uploadInp = document.getElementById('ld-upload-input');
    if (uploadBtn && uploadInp) {
      uploadBtn.addEventListener('click', () => uploadInp.click());
      uploadInp.addEventListener('change', async () => {
        const files = Array.from(uploadInp.files || []);
        if (!files.length) return;
        uploadBtn.disabled = true;
        try {
          for (const f of files) {
            const fd = new FormData();
            fd.append('file', f);
            await api(`/api/owner/leads/${encodeURIComponent(l.id)}/media`, { method: 'POST', body: fd });
          }
          toast(`Added ${files.length} file(s)`);
          await rerender();
        } catch (err) {
          toast(err.message, true);
        } finally {
          uploadBtn.disabled = false;
        }
      });
    }

    bindClick(document.getElementById('ld-del-all-media'), async () => {
      if (!confirm(`Permanently delete all ${d.attachments.length} photo(s)/video(s) on this request from storage?`)) return;
      const out = await api(`/api/owner/leads/${encodeURIComponent(l.id)}/media`, { method: 'DELETE' });
      toast(`Deleted ${out.deletedCount || d.attachments.length} file(s) · freed ${fmtBytes(out.bytesFreed || 0)}`);
      await rerender();
    });

    bindClick(document.getElementById('ld-delete-lead'), async () => {
      if (!confirm(`Permanently delete ${l.leadNumber} (${l.fullName}) and all attached photos/videos from storage? This cannot be undone.`)) return;
      const out = await api(`/api/owner/leads/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
      toast(`Deleted ${l.leadNumber} · freed ${fmtBytes(out.bytesFreed || 0)}`);
      refreshUnreadLeadBadge();
      navigate('/owner/leads/');
    });

    workspace.querySelectorAll('[data-del-appt]').forEach((b) =>
      bindClick(b, async () => {
        if (!confirm('Delete this scheduled pickup?')) return;
        await api(`/api/owner/calendar/${encodeURIComponent(b.dataset.delAppt)}`, { method: 'DELETE' });
        toast('Scheduled pickup deleted');
        await rerender();
      })
    );

    workspace.querySelectorAll('[data-del-note]').forEach((b) =>
      bindClick(b, async () => {
        if (!confirm('Delete this note permanently?')) return;
        await api(`/api/owner/notes/${encodeURIComponent(b.dataset.delNote)}`, { method: 'DELETE' });
        toast('Note deleted');
        await rerender();
      })
    );

    workspace.querySelectorAll('[data-del-task]').forEach((b) =>
      bindClick(b, async () => {
        if (!confirm('Delete this follow-up reminder?')) return;
        await api(`/api/owner/follow-ups/${encodeURIComponent(b.dataset.delTask)}`, { method: 'DELETE' });
        toast('Reminder deleted');
        await rerender();
      })
    );
  }

  function openViewer(attachments, index) {
    if (!window.ZViewer) return;
    window.ZViewer.open(
      attachments.map((a) => ({
        kind: a.mediaKind === 'video' ? 'video' : 'photo',
        src: a.streamUrl,
        preview: a.mediaKind === 'photo' ? a.previewUrl : '',
        name: a.safeFilename,
        download: a.downloadUrl
      })),
      index
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 5. MAP (/owner/map/)                                                   */
  /* ---------------------------------------------------------------------- */
  async function renderMap(seq) {
    const sp = new URLSearchParams(window.location.search);
    const showAll = sp.get('all') === '1';
    const focusLead = sp.get('lead') || '';
    const res = await api(`/api/owner/map/pins${showAll || focusLead ? '?all=1' : ''}`);
    if (seq !== state.navSeq) return;
    const pins = (res.pins || []).filter(hasGeo);
    destroyMaps();

    const tones = ['new', 'follow', 'quote', 'booked'].concat(showAll ? ['done'] : []);
    workspace.innerHTML = `
      <section class="cc-mapview">
        <div class="cc-mapview__map" data-big-map aria-label="Map of customer pickup requests. Use arrow keys to move, plus and minus to zoom."></div>
        <div class="cc-mapview__top">
          <div class="cc-mapview__title">
            <h1>Map</h1>
            <span>${pins.length} request${pins.length === 1 ? '' : 's'} on the map</span>
          </div>
          <nav class="cc-seg" aria-label="Which requests">
            <a href="/owner/map/" data-spa class="${showAll || focusLead ? '' : 'is-on'}">Active</a>
            <a href="/owner/map/?all=1" data-spa class="${showAll ? 'is-on' : ''}">Include done</a>
          </nav>
        </div>
        <div class="cc-mapview__legend" aria-label="Pin colors">
          ${tones.map((t) => `<span><i style="background:${TONE_COLOR[t]}"></i>${esc(TONE_LABEL[t])}</span>`).join('')}
        </div>
        <div class="cc-mapview__card" data-pin-card hidden></div>
        ${
          pins.length
            ? ''
            : `<div class="cc-mapview__empty">${emptyState('No requests on the map yet', 'When a customer sends a request with a checked address, a pin drops here automatically.')}</div>`
        }
      </section>`;

    const card = workspace.querySelector('[data-pin-card]');
    const showCard = (l) => {
      const links = mapLinks(l);
      card.innerHTML = `<article class="cc-pincard" style="--tone:${toneColor(l.status)}">
        <button type="button" class="cc-iconbtn cc-pincard__close" aria-label="Close">${ico('plus', 'cc-ico--x')}</button>
        <a class="cc-pincard__main" href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa>
          ${avatar(l.fullName)}
          <span class="cc-pincard__body">
            <strong>${esc(l.fullName)}</strong>
            <span>${esc(fullAddress(l))}</span>
            <span class="cc-pincard__meta">${statusPill(l.status)}${mediaSummary(l)}<span class="cc-meta">${esc(timeAgo(l.createdAt))}</span></span>
          </span>
        </a>
        <div class="cc-pincard__actions">
          <a class="cc-btn cc-btn--primary" href="${telHref(l.phone)}">${ico('phone')}Call</a>
          <a class="cc-btn cc-btn--ghost" href="${links.directions}" target="_blank" rel="noopener">${ico('directions')}Go</a>
          <a class="cc-btn cc-btn--navy" href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa>Open ${ico('chevRight')}</a>
        </div>
      </article>`;
      card.hidden = false;
      card.querySelector('.cc-pincard__close').addEventListener('click', () => {
        card.hidden = true;
        map?.select(null);
      });
    };

    const map = mountMap(workspace.querySelector('[data-big-map]'), {
      markers: pins.map(leadMarker),
      fit: pins.length > 0,
      fitPadding: () => (isWide() ? { top: 128, right: 72, bottom: 78, left: 32 } : { top: 132, right: 64, bottom: 168, left: 24 }),
      wheel: true,
      zoom: 11,
      onMarkerClick: (m) => showCard(m.lead)
    });
    if (focusLead && map) {
      const hit = pins.find((p) => p.leadNumber === focusLead);
      if (hit) {
        map.setView(Number(hit.lat), Number(hit.lng), 17);
        map.select(hit.leadNumber);
        showCard(hit);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 6. SCHEDULE (/owner/calendar/) — America/Chicago                       */
  /* ---------------------------------------------------------------------- */
  async function renderCalendar(seq) {
    if (state.calYear === null) {
      const [y, m] = todayIso().split('-').map(Number);
      state.calYear = y;
      state.calMonth = m - 1;
    }
    const y = state.calYear;
    const m = state.calMonth;
    const firstDay = new Date(Date.UTC(y, m, 1));
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const startWeekday = firstDay.getUTCDay();
    const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(firstDay);
    const pad = (n) => String(n).padStart(2, '0');
    const res = await api(`/api/owner/calendar?from=${y}-${pad(m + 1)}-01&to=${y}-${pad(m + 1)}-${pad(daysInMonth)}`);
    if (seq !== state.navSeq) return;
    const appts = res.appointments || [];
    const today = todayIso();

    const byDate = {};
    appts.forEach((a) => (byDate[a.scheduled_date] = byDate[a.scheduled_date] || []).push(a));

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cc-cal-day is-blank" aria-hidden="true"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const dStr = `${y}-${pad(m + 1)}-${pad(day)}`;
      const list = byDate[dStr] || [];
      cells.push(`<div class="cc-cal-day ${dStr === today ? 'is-today' : ''} ${list.length ? 'has-items' : ''}">
        <span class="cc-cal-num">${day}</span>
        ${list.length ? `<span class="cc-cal-dots" aria-label="${list.length} pickup(s)">${list.slice(0, 3).map(() => '<i></i>').join('')}</span>` : ''}
        ${list
          .map(
            (a) => `<a class="cc-cal-chip" href="/owner/leads/${encodeURIComponent(a.lead_number)}" data-spa title="${esc(a.time_window)} — ${esc(a.customer_name)}">${esc(a.customer_name)}</a>`
          )
          .join('')}
      </div>`);
    }

    const groups = Object.keys(byDate).sort();

    workspace.innerHTML = `
      ${pageHead('Schedule', 'Pickup windows in Central Time (Mobile, AL).')}
      <div class="cc-monthbar">
        <button id="cal-prev" type="button" class="cc-iconbtn cc-iconbtn--tint" aria-label="Previous month">${ico('chevLeft')}</button>
        <strong>${esc(monthLabel)}</strong>
        <button id="cal-next" type="button" class="cc-iconbtn cc-iconbtn--tint" aria-label="Next month">${ico('chevRight')}</button>
        <button id="cal-today" type="button" class="cc-btn cc-btn--ghost cc-btn--sm">Today</button>
      </div>

      <div class="cc-sched">
        <section class="cc-sched__agenda" aria-label="Pickups this month">
          ${
            groups.length
              ? groups
                  .map((date) => {
                    const dp = dayParts(date);
                    return `<div class="cc-dayblock ${date === today ? 'is-today' : ''} ${date < today ? 'is-past' : ''}">
                      <div class="cc-dayblock__head"><span class="cc-datebadge ${date === today ? 'is-today' : ''}"><span>${esc(date === today ? 'Today' : dp.wd)}</span><strong>${esc(dp.day)}</strong></span><h2>${esc(dp.label)}</h2></div>
                      ${byDate[date]
                        .map(
                          (a) => `<article class="cc-jobcard">
                            <a class="cc-jobcard__main" href="/owner/leads/${encodeURIComponent(a.lead_number)}" data-spa>
                              <span class="cc-jobcard__time">${ico('clock')}${esc(a.time_window)}</span>
                              <strong>${esc(a.customer_name)}</strong>
                              <span>${ico('pin')}${esc(a.pickup_address)}, ${esc(a.city)}</span>
                              <span class="cc-meta">${esc(a.lead_number)} · ${esc(a.requested_service || '')}</span>
                              ${a.instructions ? `<span class="cc-jobcard__note">${esc(a.instructions)}</span>` : ''}
                            </a>
                            <div class="cc-jobcard__actions">
                              <a class="cc-iconbtn cc-iconbtn--tint" href="${telHref(a.customer_phone)}" aria-label="Call ${esc(a.customer_name)}">${ico('phone')}</a>
                              <a class="cc-iconbtn cc-iconbtn--tint" href="${apptLinks(a)}" target="_blank" rel="noopener" aria-label="Directions">${ico('directions')}</a>
                              <label class="cc-visually-hidden" for="appt-st-${esc(a.id)}">Status for ${esc(a.customer_name)}</label>
                              <select id="appt-st-${esc(a.id)}" class="cc-select cc-select--sm" data-appt-status="${esc(a.id)}">
                                ${['scheduled', 'in_progress', 'completed', 'cancelled'].map((s) => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
                              </select>
                              <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-del-appt="${esc(a.id)}" aria-label="Delete pickup for ${esc(a.customer_name)}">${ico('trash')}</button>
                            </div>
                          </article>`
                        )
                        .join('')}
                    </div>`;
                  })
                  .join('')
              : emptyState(`Nothing booked in ${esc(monthLabel)}`, 'Open a request and tap “Book the pickup” to add it here.')
          }
        </section>
        <section class="cc-card cc-sched__month" aria-label="Month view">
          <div class="cc-cal-grid cc-cal-grid--head" aria-hidden="true"><div>S</div><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div></div>
          <div class="cc-cal-grid">${cells.join('')}</div>
        </section>
      </div>`;

    const shift = (delta) => {
      state.calMonth += delta;
      if (state.calMonth < 0) {
        state.calMonth = 11;
        state.calYear--;
      } else if (state.calMonth > 11) {
        state.calMonth = 0;
        state.calYear++;
      }
      renderCalendar(state.navSeq);
    };
    document.getElementById('cal-prev').addEventListener('click', () => shift(-1));
    document.getElementById('cal-next').addEventListener('click', () => shift(1));
    document.getElementById('cal-today').addEventListener('click', () => {
      state.calYear = null;
      renderCalendar(state.navSeq);
    });
    workspace.querySelectorAll('[data-appt-status]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/owner/calendar/${encodeURIComponent(sel.dataset.apptStatus)}`, { method: 'PATCH', body: { status: sel.value } });
          toast('Pickup updated');
          renderCalendar(state.navSeq);
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    workspace.querySelectorAll('[data-del-appt]').forEach((btn) =>
      bindClick(btn, async () => {
        if (!confirm('Delete this scheduled pickup from your calendar?')) return;
        await api(`/api/owner/calendar/${encodeURIComponent(btn.dataset.delAppt)}`, { method: 'DELETE' });
        toast('Scheduled pickup deleted');
        renderCalendar(state.navSeq);
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 7. PIPELINE BOARD (/owner/pipeline/)                                   */
  /* ---------------------------------------------------------------------- */
  async function renderPipeline(seq) {
    const board = await api('/api/owner/pipeline');
    if (seq !== state.navSeq) return;
    workspace.innerHTML = `
      ${pageHead('Pipeline board', 'All 12 stages side by side. Swipe sideways on your phone. Change a stage from the menu on each card.')}
      <div class="cc-pipeline">
        ${board.statuses
          .map((st) => {
            const list = board.columns[st] || [];
            return `<section class="cc-pipe-col" data-pipe-col="${esc(st)}" style="--tone:${toneColor(st)}">
              <div class="cc-pipe-head"><span>${esc(st)}</span><span class="cc-pill cc-pill--neutral">${list.length}</span></div>
              ${
                list.length
                  ? list
                      .map(
                        (l) => `<div class="cc-pipe-card">
                          <div class="cc-pipe-card__top">
                            <a href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa><strong>${esc(l.leadNumber)}</strong></a>
                            <span class="cc-inline-actions">
                              <span class="cc-pill cc-pill--neutral">${esc(l.priority)}</span>
                              <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-pipe-del="${esc(l.id)}" data-pipe-label="${esc(l.leadNumber)}" aria-label="Delete ${esc(l.leadNumber)}">${ico('trash')}</button>
                            </span>
                          </div>
                          <div><strong>${esc(l.fullName)}</strong> · ${esc(l.city)}</div>
                          <div class="cc-muted">${esc(l.requestedService)} (${l.photoCount}P/${l.videoCount}V)</div>
                          <label class="cc-visually-hidden" for="pm-${esc(l.id)}">Move ${esc(l.leadNumber)}</label>
                          <select id="pm-${esc(l.id)}" class="cc-select cc-select--sm" data-pipe-move="${esc(l.id)}">
                            ${board.statuses.map((opt) => `<option value="${esc(opt)}" ${opt === st ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
                          </select>
                        </div>`
                      )
                      .join('')
                  : '<div class="cc-pipe-empty">Empty</div>'
              }
            </section>`;
          })
          .join('')}
      </div>`;

    workspace.querySelectorAll('[data-pipe-move]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/owner/leads/${encodeURIComponent(sel.dataset.pipeMove)}/status`, {
            method: 'POST',
            body: { status: sel.value, note: 'Moved on Pipeline Board' }
          });
          toast(`Moved to ${sel.value}`);
          renderPipeline(state.navSeq);
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    workspace.querySelectorAll('[data-pipe-del]').forEach((btn) =>
      bindClick(btn, async () => {
        if (!confirm(`Permanently delete ${btn.dataset.pipeLabel} and all attached photos/videos?`)) return;
        const out = await api(`/api/owner/leads/${encodeURIComponent(btn.dataset.pipeDel)}`, { method: 'DELETE' });
        toast(`Deleted ${btn.dataset.pipeLabel} · freed ${fmtBytes(out.bytesFreed || 0)}`);
        refreshUnreadLeadBadge();
        renderPipeline(state.navSeq);
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 8. CUSTOMERS (/owner/customers/)                                       */
  /* ---------------------------------------------------------------------- */
  async function renderCustomers(seq) {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('q') || '';
    const res = await api(`/api/owner/customers?q=${encodeURIComponent(q)}`);
    if (seq !== state.navSeq) return;
    const H = ['Customer', 'Phone / Email', 'Address', 'Type', 'Requests', 'Completed', ''];

    workspace.innerHTML = `
      ${pageHead('Customers', `${res.total} customer${res.total === 1 ? '' : 's'}. Repeat requests link automatically when name + phone match; possible duplicates wait for you to confirm.`)}

      ${
        res.duplicateSuggestions?.length
          ? `<section class="cc-alert cc-alert--warn">
              <strong>${ico('customers')}Possible duplicates (${res.duplicateSuggestions.length})</strong>
              <div class="cc-dupes">
                ${res.duplicateSuggestions
                  .map(
                    (dup) => `<div class="cc-dupe">
                      <span><strong>${esc(dup.primary.full_name)}</strong> (${esc(dup.primary.phone_display)}) ↔ <strong>${esc(dup.duplicate.full_name)}</strong> (${esc(dup.duplicate.phone_display)}) — ${esc((dup.reasons || []).join(', '))}</span>
                      <button type="button" class="cc-btn cc-btn--sm cc-btn--navy" data-merge-target="${esc(dup.primary.id)}" data-merge-source="${esc(dup.duplicate.id)}" data-merge-label="${esc(dup.duplicate.full_name)} into ${esc(dup.primary.full_name)}">Review &amp; merge</button>
                    </div>`
                  )
                  .join('')}
              </div>
            </section>`
          : ''
      }

      <form id="cust-search-form" class="cc-search" role="search">
        ${ico('search')}
        <input id="cust-q" type="search" value="${esc(q)}" placeholder="Search name, phone, email, city…" aria-label="Search customers" />
      </form>

      <div class="cc-card">
        ${
          res.customers.length
            ? table(
                H,
                res.customers
                  .map((c) =>
                    tr(H, [
                      `<strong>${esc(c.full_name)}</strong>`,
                      `<a href="${telHref(c.phone_display)}">${esc(c.phone_display)}</a><br/><small>${esc(c.email || '—')}</small>`,
                      `${esc(c.primary_address)}, ${esc(c.city)}, ${esc(c.state)} ${esc(c.zip_code)}`,
                      esc(c.customer_type),
                      esc(c.total_inquiries),
                      esc(c.completed_pickups),
                      `<span class="cc-inline-actions">
                        <button type="button" class="cc-btn cc-btn--sm cc-btn--ghost" data-open-cust="${esc(c.id)}">History &amp; privacy</button>
                        <button type="button" class="cc-btn cc-btn--sm cc-btn--danger" data-del-cust="${esc(c.id)}" data-del-cust-name="${esc(c.full_name)}">${ico('trash')}Delete</button>
                      </span>`
                    ])
                  )
                  .join('')
              )
            : emptyState('No customers yet', 'Customers are created automatically from website requests.')
        }
      </div>`;

    document.getElementById('cust-search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = document.getElementById('cust-q').value.trim();
      navigate(`/owner/customers/${v ? '?q=' + encodeURIComponent(v) : ''}`);
    });

    workspace.querySelectorAll('[data-merge-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openModal(
          'Merge these customers?',
          `<p>Merge <strong>${esc(btn.dataset.mergeLabel)}</strong>? All their past requests will be linked to one customer record.</p>
           <label class="cc-check">
             <input id="confirm-merge-chk" type="checkbox" /> <span>Yes, these are the same person.</span>
           </label>
           <button id="exec-merge-btn" type="button" class="cc-btn cc-btn--primary cc-btn--block">Merge customer records</button>`
        );
        bindClick(document.getElementById('exec-merge-btn'), async () => {
          if (!document.getElementById('confirm-merge-chk').checked) {
            toast('Tick the confirmation box first.', true);
            return;
          }
          await api('/api/owner/customers/merge', {
            method: 'POST',
            body: { targetCustomerId: btn.dataset.mergeTarget, sourceCustomerId: btn.dataset.mergeSource, confirmed: true }
          });
          modal.close();
          toast('Customer records merged');
          renderCustomers(state.navSeq);
        });
      });
    });

    workspace.querySelectorAll('[data-open-cust]').forEach((btn) => {
      bindClick(btn, async () => {
        const det = await api(`/api/owner/customers/${encodeURIComponent(btn.dataset.openCust)}`);
        const c = det.customer;
        openModal(
          c.full_name,
          `<dl class="cc-facts">
            ${factRow('Phone', `<a href="${telHref(c.phone_display)}">${esc(c.phone_display)}</a>`)}
            ${factRow('Email', esc(c.email || '—'))}
            ${factRow('Address', `${esc(c.primary_address)}, ${esc(c.city)}, ${esc(c.state)} ${esc(c.zip_code)}`)}
          </dl>
          <h3 class="cc-h3">Requests (${det.leads.length})</h3>
          <ul class="cc-mini-list">
            ${det.leads
              .map(
                (l) => `<li><a href="/owner/leads/${encodeURIComponent(l.leadNumber)}" data-spa>
                  <span class="cc-mini-list__body"><strong>${esc(l.leadNumber)}</strong><span>${esc(l.requestedService)}</span></span>${statusPill(l.status)}</a></li>`
              )
              .join('')}
          </ul>
          <div class="cc-modal__danger">
            <button id="delete-cust-btn" type="button" class="cc-btn cc-btn--danger cc-btn--sm">${ico('trash')}Delete customer &amp; all requests</button>
            <button id="redact-cust-btn" type="button" class="cc-btn cc-btn--ghost cc-btn--sm">Erase personal info only</button>
          </div>`
        );
        bindClick(document.getElementById('delete-cust-btn'), async () => {
          if (!confirm(`Permanently delete ${c.full_name}, all ${det.leads.length} request(s), and any uploaded photos/videos from storage? This cannot be undone.`)) return;
          const out = await api(`/api/owner/customers/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
          modal.close();
          toast(`Deleted ${c.full_name} · freed ${fmtBytes(out.bytesFreed || 0)}`);
          refreshUnreadLeadBadge();
          renderCustomers(state.navSeq);
        });
        bindClick(document.getElementById('redact-cust-btn'), async () => {
          if (!confirm('Erase personal contact details and delete any media files for this customer (privacy request)?')) return;
          await api(`/api/owner/customers/${encodeURIComponent(c.id)}/redact`, { method: 'POST', body: { confirmed: true } });
          modal.close();
          toast('Customer personal info erased');
          renderCustomers(state.navSeq);
        });
      });
    });

    workspace.querySelectorAll('[data-del-cust]').forEach((btn) =>
      bindClick(btn, async () => {
        const name = btn.dataset.delCustName || 'this customer';
        if (!confirm(`Permanently delete ${name}, all of their requests, and any attached photos/videos from storage? This cannot be undone.`)) return;
        const out = await api(`/api/owner/customers/${encodeURIComponent(btn.dataset.delCust)}`, { method: 'DELETE' });
        toast(`Deleted ${name} · freed ${fmtBytes(out.bytesFreed || 0)}`);
        refreshUnreadLeadBadge();
        renderCustomers(state.navSeq);
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 9. WEBSITE VISITS (/owner/analytics/)                                  */
  /* ---------------------------------------------------------------------- */
  function rangeSeg(ranges, current, attr) {
    return `<div class="cc-seg cc-seg--sm" role="group" aria-label="Date range">${ranges
      .map((r) => `<button type="button" class="${current === r ? 'is-on' : ''}" ${attr}="${r}" aria-pressed="${current === r}">${r}</button>`)
      .join('')}</div>`;
  }

  async function renderAnalytics(seq) {
    const [rep, rt] = await Promise.all([
      api(`/api/owner/analytics?range=${encodeURIComponent(state.analyticsRange)}`),
      api('/api/owner/analytics/realtime')
    ]);
    if (seq !== state.navSeq) return;
    const s = rep.summary;
    const H = ['Page', 'Views', 'Sessions', 'Phone taps', 'Requests'];

    workspace.innerHTML = `
      ${pageHead(
        'Website visits',
        'Visits, phone taps, form starts and real requests are counted separately — never mixed together.',
        `${rangeSeg(['today', 'yesterday', '7d', '30d', '90d'], state.analyticsRange, 'data-an-range')}
         <a class="cc-btn cc-btn--sm cc-btn--ghost" href="/api/owner/exports/analytics.csv?range=${encodeURIComponent(state.analyticsRange)}">${ico('download')}CSV</a>
         <button id="an-clear-btn" type="button" class="cc-btn cc-btn--sm cc-btn--danger">${ico('trash')}Clear visits</button>`
      )}

      <div class="cc-alert cc-alert--ok cc-alert--row">
        <span><strong>Right now (5 min):</strong> ${rt.activeVisitorsLast5Min} visitor(s) · ${rt.pageViewsLast5Min} page view(s) · ${rt.phoneClicksLast5Min} phone tap(s)</span>
        <span>GA4: <strong>${esc(rep.source.ga4Status)}</strong></span>
      </div>

      <div class="cc-kpi-grid">
        <div class="cc-kpi"><div class="cc-kpi__val">${s.visitors}</div><div class="cc-kpi__label">Visitors</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.sessions}</div><div class="cc-kpi__label">Sessions</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.pageViews}</div><div class="cc-kpi__label">Page views</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.clickToCallEvents}</div><div class="cc-kpi__label">Phone taps*</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.formStarts}</div><div class="cc-kpi__label">Form starts</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.uploadCompletions}</div><div class="cc-kpi__label">Photo uploads</div></div>
        <div class="cc-kpi cc-kpi--teal"><div class="cc-kpi__val">${s.crmFormSubmissions}</div><div class="cc-kpi__label">Requests received</div></div>
        <div class="cc-kpi cc-kpi--accent"><div class="cc-kpi__val">${s.qualifiedLeads}</div><div class="cc-kpi__label">Qualified requests</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${s.conversionRatePct !== null ? s.conversionRatePct + '%' : '—'}</div><div class="cc-kpi__label">Visit → request</div></div>
      </div>
      <p class="cc-fine">* ${esc(rep.source.phoneClicksDisclaimer)}</p>

      <div class="cc-grid-2">
        <div class="cc-card">
          <h2>Top pages</h2>
          ${
            rep.topPages.length
              ? table(
                  H,
                  rep.topPages
                    .map((p) => tr(H, [`<code>${esc(p.pagePath)}</code>`, esc(p.pageViews), esc(p.sessions), esc(p.phoneClicks), `<strong>${esc(p.crmLeads)}</strong>`]))
                    .join('')
                )
              : emptyState('No page views in this date range yet')
          }
        </div>
        <div class="cc-card">
          <h2>How people find you</h2>
          ${renderBarList(rep.trafficSources.map((t) => ({ label: t.channel, value: t.sessions })), ' sessions')}
          <h3 class="cc-h3">Devices</h3>
          ${renderBarList(rep.deviceBreakdown.map((d) => ({ label: d.deviceCategory, value: d.sessions })), ' sessions')}
        </div>
      </div>`;

    workspace.querySelectorAll('[data-an-range]').forEach((b) =>
      b.addEventListener('click', () => {
        state.analyticsRange = b.dataset.anRange;
        renderAnalytics(state.navSeq);
      })
    );

    bindClick(document.getElementById('an-clear-btn'), async () => {
      if (!confirm('Clear all recorded website visit & click events from the CRM database?')) return;
      const out = await api('/api/owner/analytics/events', { method: 'DELETE' });
      toast(`Cleared ${out.deleted || 0} visit event(s)`);
      renderAnalytics(state.navSeq);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. GOOGLE SEARCH (/owner/search-performance/)                         */
  /* ---------------------------------------------------------------------- */
  async function renderSearchPerformance(seq) {
    const res = await api(`/api/owner/search-performance?range=${encodeURIComponent(state.searchRange)}`);
    if (seq !== state.navSeq) return;
    const t = res.totals;
    const HQ = ['Search', 'Clicks', 'Impressions', 'CTR', 'Position'];
    const HL = ['Area', 'County', 'Coverage', 'Impressions', 'Phone taps', 'Requests'];

    workspace.innerHTML = `
      ${pageHead(
        'Google search',
        'How often you show up on Google and how many people click — kept separate from website visits and requests.',
        `${rangeSeg(['7d', '30d', '90d'], state.searchRange, 'data-gsc-range')}
         <button id="gsc-import-btn" type="button" class="cc-btn cc-btn--sm cc-btn--navy">${ico('plus')}Import CSV</button>
         <button id="gsc-clear-btn" type="button" class="cc-btn cc-btn--sm cc-btn--danger">${ico('trash')}Clear data</button>`
      )}

      ${
        res.connection?.status !== 'connected' && !res.connection?.lastImportedAt
          ? `<div class="cc-alert cc-alert--warn">Google Search Console isn’t connected yet (<code>GOOGLE_SEARCH_CONSOLE_PROPERTY</code> + <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>). No numbers are faked — connect it or import a Search Console CSV export.</div>`
          : ''
      }

      <div class="cc-kpi-grid">
        <div class="cc-kpi"><div class="cc-kpi__val">${t.impressions}</div><div class="cc-kpi__label">Times shown on Google</div></div>
        <div class="cc-kpi cc-kpi--teal"><div class="cc-kpi__val">${t.clicks}</div><div class="cc-kpi__label">Clicks from Google</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${t.ctr !== null && t.ctr !== undefined ? t.ctr + '%' : '0%'}</div><div class="cc-kpi__label">Click rate</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${t.avgPosition ?? '—'}</div><div class="cc-kpi__label">Average position</div></div>
      </div>

      <div class="cc-grid-2">
        <div class="cc-card">
          <h2>Top searches</h2>
          ${
            (res.topQueries || []).length
              ? table(
                  HQ,
                  res.topQueries.map((q) => tr(HQ, [`<strong>${esc(q.key)}</strong>`, esc(q.clicks), esc(q.impressions), `${esc(q.ctr)}%`, esc(q.avgPosition)])).join('')
                )
              : emptyState('No search data imported yet')
          }
        </div>
        <div class="cc-card">
          <h2>By area</h2>
          ${table(
            HL,
            (res.locationPerformance || [])
              .slice(0, 18)
              .map((loc) =>
                tr(HL, [
                  `<strong>${esc(loc.name)}</strong>`,
                  esc(loc.countyId === 'baldwin-county-al' ? 'Baldwin' : 'Mobile'),
                  statusPill(loc.coverageStatus),
                  esc(loc.searchImpressions),
                  esc(loc.telephoneClicks),
                  `<strong>${esc(loc.formSubmissions)}</strong>`
                ])
              )
              .join('')
          )}
        </div>
      </div>`;

    workspace.querySelectorAll('[data-gsc-range]').forEach((b) =>
      b.addEventListener('click', () => {
        state.searchRange = b.dataset.gscRange;
        renderSearchPerformance(state.navSeq);
      })
    );

    bindClick(document.getElementById('gsc-clear-btn'), async () => {
      if (!confirm('Clear all imported Google Search Console rows from the CRM database?')) return;
      const out = await api('/api/owner/search-performance/snapshots', { method: 'DELETE' });
      toast(`Cleared ${out.deleted || 0} search row(s)`);
      renderSearchPerformance(state.navSeq);
    });

    document.getElementById('gsc-import-btn').addEventListener('click', () => {
      openModal(
        'Import Google Search Console CSV',
        `<form id="gsc-csv-form" class="cc-form">
          <div class="cc-field">
            <label for="gsc-dim">CSV type</label>
            <select id="gsc-dim" class="cc-select">
              <option value="query">Queries (Top queries, Clicks, Impressions, CTR, Position)</option>
              <option value="page">Pages (Top pages, Clicks, Impressions, CTR, Position)</option>
            </select>
          </div>
          <div class="cc-field">
            <label for="gsc-csv-text">Paste the CSV</label>
            <textarea id="gsc-csv-text" class="cc-textarea" rows="6" placeholder="Top queries,Clicks,Impressions,CTR,Position&#10;junk removal mobile al,18,240,7.5%,3.2" required></textarea>
          </div>
          <button class="cc-btn cc-btn--primary cc-btn--block" type="submit">Import</button>
        </form>`
      );
      bindForm('gsc-csv-form', async () => {
        const out = await api('/api/owner/search-performance/import-csv', {
          method: 'POST',
          body: { dimensionKind: document.getElementById('gsc-dim').value, csvText: document.getElementById('gsc-csv-text').value }
        });
        modal.close();
        toast(`Imported ${out.imported} rows`);
        renderSearchPerformance(state.navSeq);
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. SERVICE AREAS (/owner/locations/)                                  */
  /* ---------------------------------------------------------------------- */
  async function renderLocations(seq) {
    const res = await api('/api/owner/locations');
    if (seq !== state.navSeq) return;
    const perfMap = new Map((res.performance || []).map((p) => [p.id, p]));
    const HM = ['Location', 'County', 'Type', 'ZIPs', 'Requests', 'Coverage'];
    const HN = ['Neighborhood', 'Type', 'ZIPs', 'Coverage'];
    const covSelect = (kind, id, current, label) =>
      `<label class="cc-visually-hidden" for="cov-${esc(id)}">Coverage for ${esc(label)}</label>
       <select id="cov-${esc(id)}" class="cc-select cc-select--sm" data-cov-kind="${kind}" data-cov-id="${esc(id)}">
        ${COVERAGE_OPTIONS.map((o) => `<option value="${o}" ${current === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>`;

    workspace.innerHTML = `
      ${pageHead('Service areas', 'Turn areas on or off across Mobile &amp; Baldwin County — no code needed. Research-only areas never become public pages.')}

      <div class="cc-kpi-grid cc-kpi-grid--4">
        <div class="cc-kpi"><div class="cc-kpi__val">${res.counties.length}</div><div class="cc-kpi__label">Counties</div></div>
        <div class="cc-kpi cc-kpi--teal"><div class="cc-kpi__val">${res.municipalities.filter((m) => m.coverage_status === 'active').length}</div><div class="cc-kpi__label">Active cities &amp; towns</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${res.municipalities.length}</div><div class="cc-kpi__label">Cities &amp; communities</div></div>
        <div class="cc-kpi"><div class="cc-kpi__val">${res.neighborhoods.length}</div><div class="cc-kpi__label">Mobile neighborhoods</div></div>
      </div>

      <div class="cc-card">
        <h2>Cities &amp; communities (${res.municipalities.length})</h2>
        <div class="cc-toolbar">
          <div class="cc-search cc-search--inline">${ico('search')}<input id="loc-q" type="search" placeholder="Filter Daphne, Fairhope, Mobile…" aria-label="Filter locations" /></div>
          <label class="cc-visually-hidden" for="loc-county">County</label>
          <select id="loc-county" class="cc-select">
            <option value="">Both counties</option>
            <option value="mobile-county-al">Mobile County</option>
            <option value="baldwin-county-al">Baldwin County</option>
          </select>
        </div>
        ${table(HM, '', { tbodyId: 'loc-tbody' })}
      </div>

      <div class="cc-card">
        <h2>Mobile neighborhoods (${res.neighborhoods.length})</h2>
        ${table(
          HN,
          res.neighborhoods
            .map((n) =>
              tr(HN, [
                `<strong>${esc(n.name)}</strong><br/><small class="cc-muted">${esc(n.geo_reference)}</small>`,
                `<span class="cc-pill cc-pill--neutral">${esc(n.classification)}</span>`,
                esc((n.zipCodes || []).join(', ')),
                covSelect('neighborhood', n.id, n.coverage_status, n.name)
              ])
            )
            .join('')
        )}
      </div>`;

    function bindCoverageSelects(root) {
      root.querySelectorAll('[data-cov-id]').forEach((sel) => {
        if (sel.dataset.bound) return;
        sel.dataset.bound = '1';
        sel.addEventListener('change', async () => {
          try {
            await api('/api/owner/locations/coverage', {
              method: 'PATCH',
              body: { entityKind: sel.dataset.covKind, id: sel.dataset.covId, coverageStatus: sel.value }
            });
            const rec = res.municipalities.find((x) => x.id === sel.dataset.covId);
            if (rec) rec.coverage_status = sel.value;
            toast(`${sel.dataset.covId} → ${sel.value}`);
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
    }

    const drawMunis = () => {
      const q = document.getElementById('loc-q').value.toLowerCase();
      const c = document.getElementById('loc-county').value;
      const rows = res.municipalities.filter(
        (m) => (!c || m.county_id === c) && (!q || `${m.name} ${m.official_name} ${(m.zipCodes || []).join(' ')}`.toLowerCase().includes(q))
      );
      document.getElementById('loc-tbody').innerHTML = rows
        .map((m) => {
          const pf = perfMap.get(m.id);
          return tr(HM, [
            `<strong>${esc(m.name)}, ${esc(m.state)}</strong><br/><small class="cc-muted">${esc(m.official_name)}</small>`,
            `${m.county_id === 'baldwin-county-al' ? 'Baldwin County' : 'Mobile County'}<br/><small>${esc(m.sub_region)}</small>`,
            `<span class="cc-pill cc-pill--neutral">${esc(m.classification)}</span>`,
            esc((m.zipCodes || []).join(', ')),
            `<strong>${pf?.formSubmissions || 0}</strong>`,
            covSelect('municipality', m.id, m.coverage_status, m.name)
          ]);
        })
        .join('');
      bindCoverageSelects(document.getElementById('loc-tbody'));
    };

    drawMunis();
    bindCoverageSelects(workspace);
    document.getElementById('loc-q').addEventListener('input', drawMunis);
    document.getElementById('loc-county').addEventListener('change', drawMunis);
  }

  /* ---------------------------------------------------------------------- */
  /* 12. WEBSITE PAGES / SEO (/owner/seo-pages/)                            */
  /* ---------------------------------------------------------------------- */
  async function renderSeoPages(seq) {
    const res = await api('/api/owner/seo-pages');
    if (seq !== state.navSeq) return;
    const c = res.counts;
    const H = ['Path', 'Type', 'Status', 'Keyword', 'Score', 'Ready?', ''];

    workspace.innerHTML = `
      ${pageHead(
        'Website pages',
        `${c.total} pages · ${c.indexable} live on Google · ${c.draft} drafts · ${c.research} research · ${c.idea} ideas`,
        `<button id="seo-rebuild-btn" type="button" class="cc-btn cc-btn--primary cc-btn--sm">Rebuild website</button>`
      )}

      <div class="cc-card">
        <h2>Create a new service + area draft</h2>
        <p class="cc-fine">Checks for overlapping keywords and coverage first, then saves a hidden <code>draft</code> you can polish later.</p>
        <form id="seo-draft-form" class="cc-form cc-form--grid">
          <div class="cc-field"><label for="sd-service">Service</label>
            <select id="sd-service" class="cc-select" required>
              <option value="">Choose service…</option>
              ${res.services.filter((s) => s.pageId).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="cc-field"><label for="sd-location">City / town</label>
            <select id="sd-location" class="cc-select">
              <option value="">Optional…</option>
              ${res.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}, ${esc(l.county)} (${esc(l.coverage)})</option>`).join('')}
            </select>
          </div>
          <div class="cc-field"><label for="sd-neighborhood">Or Mobile neighborhood</label>
            <select id="sd-neighborhood" class="cc-select">
              <option value="">Optional…</option>
              ${res.neighborhoods.map((n) => `<option value="${esc(n.id)}">${esc(n.name)} (${esc(n.coverage)})</option>`).join('')}
            </select>
          </div>
          <button class="cc-btn cc-btn--navy" type="submit">Create draft</button>
        </form>
        <pre id="seo-build-log" class="cc-log" hidden></pre>
      </div>

      <div class="cc-card">
        <h2>All pages (${res.pages.length})</h2>
        ${table(
          H,
          res.pages
            .map((p) => {
              const isLivePage = p.status === 'published' || p.status === 'noindex';
              const liveHref = esc(publicUrl(p.path));
              return tr(H, [
                isLivePage
                  ? `<a href="${liveHref}" target="_blank" rel="noopener"><code>${esc(p.path)}</code></a><br/><small class="cc-muted">${esc(p.id)}</small>`
                  : `<code>${esc(p.path)}</code><br/><small class="cc-muted">${esc(p.id)}</small>`,
                esc(p.type),
                statusPill(p.status),
                esc(p.primaryKeyword),
                `<strong>${esc(p.score)}</strong>`,
                p.passesGate ? '<span class="cc-pill cc-pill--done">Pass</span>' : `<span class="cc-pill cc-pill--follow">${p.blockers.length} to fix</span>`,
                ['draft', 'idea', 'research'].includes(p.status)
                  ? `<button type="button" class="cc-btn cc-btn--sm cc-btn--danger" data-del-draft="${esc(p.id)}" data-del-draft-path="${esc(p.path)}">${ico('trash')}Delete</button>`
                  : `<a class="cc-btn cc-btn--sm cc-btn--ghost" href="${liveHref}" target="_blank" rel="noopener">${ico('external')}Open</a>`
              ]);
            })
            .join('')
        )}
      </div>`;

    workspace.querySelectorAll('[data-del-draft]').forEach((btn) =>
      bindClick(btn, async () => {
        if (!confirm(`Delete draft/research page ${btn.dataset.delDraftPath || btn.dataset.delDraft}?`)) return;
        await api(`/api/owner/seo-pages/${encodeURIComponent(btn.dataset.delDraft)}`, { method: 'DELETE' });
        toast('Draft page deleted');
        renderSeoPages(state.navSeq);
      })
    );

    bindForm('seo-draft-form', async () => {
      const serviceId = document.getElementById('sd-service').value;
      const locationId = document.getElementById('sd-location').value;
      const neighborhoodId = document.getElementById('sd-neighborhood').value;
      if (!locationId && !neighborhoodId) {
        toast('Choose a city or a neighborhood.', true);
        return;
      }
      const created = await api('/api/owner/seo-pages/create-draft', {
        method: 'POST',
        body: { serviceId, locationId: neighborhoodId ? undefined : locationId, neighborhoodId: neighborhoodId || undefined }
      });
      toast(`Created draft ${created.record.path}`);
      renderSeoPages(state.navSeq);
    });

    bindClick(document.getElementById('seo-rebuild-btn'), async () => {
      const logEl = document.getElementById('seo-build-log');
      logEl.hidden = false;
      logEl.textContent = 'Rebuilding website…';
      try {
        const out = await api('/api/owner/seo-pages/rebuild', { method: 'POST' });
        logEl.textContent = out.output || 'Build succeeded.';
        toast('Website rebuilt');
      } catch (err) {
        logEl.textContent = err.message;
        toast('Build failed', true);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 13. PHOTOS & VIDEOS VAULT (/owner/media/)                              */
  /* ---------------------------------------------------------------------- */
  async function renderMedia(seq) {
    const res = await api('/api/owner/media');
    if (seq !== state.navSeq) return;
    const atts = res.attachments;
    const closedCount = res.capacity?.breakdown?.closedMediaCount || 0;
    workspace.innerHTML = `
      ${pageHead(
        'Photos &amp; videos',
        `${atts.length} file${atts.length === 1 ? '' : 's'} · ${fmtBytes(res.capacity.mediaStorage.activeOriginalBytes)} used (${res.capacity.mediaStorage.usedPct}% of your space) · stored privately on ${esc(res.capacity.storageProvider)}`,
        atts.length
          ? `${closedCount ? `<button id="media-del-closed" type="button" class="cc-btn cc-btn--sm cc-btn--ghost">${ico('trash')}Clear closed-job files (${closedCount})</button>` : ''}
             <button id="media-del-all" type="button" class="cc-btn cc-btn--sm cc-btn--danger">${ico('trash')}Delete all (${atts.length})</button>`
          : ''
      )}
      ${
        atts.length
          ? `<div class="cc-media-grid">
              ${atts
                .map(
                  (att, i) => `<figure class="cc-media-item">
                    <button type="button" class="cc-media-preview" data-vault-view="${i}" aria-label="Open ${att.mediaKind} from ${esc(att.customerName)} full screen">
                      ${
                        att.mediaKind === 'photo'
                          ? `<img src="${esc(att.previewUrl)}" alt="${esc(att.safeFilename)}" loading="lazy" />`
                          : `<video src="${esc(att.streamUrl)}" preload="metadata" muted playsinline></video><span class="cc-media-play">${ico('play')}</span>`
                      }
                      <span class="cc-media-kind">${att.mediaKind === 'photo' ? ico('camera') + 'Photo' : ico('video') + 'Video'}</span>
                    </button>
                    <figcaption class="cc-media-meta">
                      <span class="cc-media-meta__text">
                        <a href="/owner/leads/${encodeURIComponent(att.leadNumber)}" data-spa><strong>${esc(att.customerName)}</strong></a>
                        <span class="cc-muted">${esc(att.leadNumber)} · ${fmtBytes(att.byteSize)}</span>
                      </span>
                      <span class="cc-media-actions">
                        <a class="cc-iconbtn cc-iconbtn--sm" href="${esc(att.downloadUrl)}" download="${esc(att.safeFilename)}" aria-label="Download ${esc(att.safeFilename)}">${ico('download')}</a>
                        <button type="button" class="cc-iconbtn cc-iconbtn--sm cc-iconbtn--danger" data-vault-del="${esc(att.id)}" aria-label="Delete ${esc(att.safeFilename)}">${ico('trash')}</button>
                      </span>
                    </figcaption>
                  </figure>`
                )
                .join('')}
            </div>`
          : emptyState('No photos or videos yet', 'When customers attach pictures to a request they’re stored privately here.')
      }`;

    const loadedAt = Date.now();
    workspace.querySelectorAll('[data-vault-view]').forEach((b) =>
      b.addEventListener('click', async () => {
        let list = atts;
        if (Date.now() - loadedAt > 3 * 60 * 1000) {
          try {
            list = (await api('/api/owner/media')).attachments;
          } catch {}
        }
        openViewer(list, Number(b.dataset.vaultView));
      })
    );
    workspace.querySelectorAll('[data-vault-del]').forEach((b) =>
      bindClick(b, async () => {
        if (!confirm('Delete this file permanently?')) return;
        await api(`/api/owner/media/${encodeURIComponent(b.dataset.vaultDel)}`, { method: 'DELETE' });
        toast('Deleted');
        renderMedia(state.navSeq);
      })
    );

    bindClick(document.getElementById('media-del-closed'), async () => {
      if (!confirm(`Permanently delete ${closedCount} photo(s)/video(s) attached to completed, closed, or spam requests?`)) return;
      const out = await api('/api/owner/media/bulk-delete', { method: 'POST', body: { filter: 'closed_leads' } });
      toast(`Deleted ${out.deletedCount} file(s) · freed ${fmtBytes(out.bytesFreed || 0)}`);
      renderMedia(state.navSeq);
    });

    bindClick(document.getElementById('media-del-all'), async () => {
      if (!confirm(`Permanently delete ALL ${atts.length} photo(s) and video(s) from private storage? This cannot be undone.`)) return;
      const out = await api('/api/owner/media/bulk-delete', { method: 'POST', body: { filter: 'all' } });
      toast(`Deleted ${out.deletedCount} file(s) · freed ${fmtBytes(out.bytesFreed || 0)}`);
      renderMedia(state.navSeq);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 14. BACKUPS & STORAGE (/owner/reports/)                                */
  /* ---------------------------------------------------------------------- */
  async function renderReports(seq) {
    const res = await api('/api/owner/capacity');
    if (seq !== state.navSeq) return;
    const cap = res.capacity;
    const b = cap.breakdown || {};
    const quotaBar = (pct) => {
      const cls = pct >= 95 ? 'cc-bar-fill--crit' : pct >= 85 ? 'cc-bar-fill--high' : pct >= 70 ? 'cc-bar-fill--warn' : '';
      return `<div class="cc-bar-track cc-bar-track--lg"><div class="cc-bar-fill ${cls}" style="width:${Math.min(100, Math.max(2, pct))}%"></div></div>`;
    };
    const H = ['Backup file', 'Created', 'Size', ''];

    workspace.innerHTML = `
      ${pageHead(
        'Backups &amp; storage',
        `Total on disk: <strong>${fmtBytes(b.totalVaultBytes || 0)}</strong> · Alerts at ${cap.thresholds.warn70}%, ${cap.thresholds.warn85}% &amp; ${cap.thresholds.warn95}% · Status: <strong>${esc(cap.alertLevel)}</strong>.`,
        `<button id="create-backup-btn" type="button" class="cc-btn cc-btn--primary cc-btn--sm">${ico('backups')}Back up now</button>
         <a class="cc-btn cc-btn--ghost cc-btn--sm" href="/api/owner/exports/leads.csv">${ico('download')}All requests CSV</a>`
      )}

      <div class="cc-grid-3">
        <div class="cc-card">
          <h2>Photo &amp; video space</h2>
          <p class="cc-big-line"><strong>${fmtBytes(cap.mediaStorage.activeOriginalBytes)}</strong> of ${fmtBytes(cap.mediaStorage.quotaBytes)} (${cap.mediaStorage.usedPct}%)</p>
          ${quotaBar(cap.mediaStorage.usedPct)}
          <p class="cc-fine">${fmtBytes(cap.mediaStorage.remainingBytes)} left · ${cap.mediaStorage.activeAttachmentCount} file(s)</p>
        </div>
        <div class="cc-card">
          <h2>CRM database</h2>
          <p class="cc-big-line"><strong>${fmtBytes(cap.database.usedBytes)}</strong> of ${fmtBytes(cap.database.quotaBytes)} (${cap.database.usedPct}%)</p>
          ${quotaBar(cap.database.usedPct)}
          <p class="cc-fine">${fmtBytes(cap.database.remainingBytes)} left · ${b.allLeadsCount || 0} request(s) · ${b.customersCount || 0} customer(s)</p>
        </div>
        <div class="cc-card">
          <h2>Monthly downloads (${esc(cap.egress.period)})</h2>
          <p class="cc-big-line"><strong>${fmtBytes(cap.egress.monthlyEgressBytes)}</strong> of ${fmtBytes(cap.egress.quotaBytes)} (${cap.egress.usedPct}%)</p>
          ${quotaBar(cap.egress.usedPct)}
          <p class="cc-fine">Failed uploads: ${cap.health.failedUploads} · Open upload sessions: ${cap.health.pendingUploads} · Alert errors: ${cap.health.notificationErrors}</p>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card__head">
          <h2>${ico('trash')}Free up space &amp; delete old data</h2>
          <span class="cc-muted">Reclaims real disk space immediately</span>
        </div>
        <div class="cc-cleanup-grid">
          <div class="cc-cleanup-item">
            <div>
              <strong>Shrink &amp; optimize storage</strong>
              <span>Sweeps leftover upload files &amp; compacts the SQLite database (VACUUM).</span>
            </div>
            <button type="button" class="cc-btn cc-btn--navy cc-btn--sm" data-cleanup-scopes="orphan_media" data-cleanup-msg="Sweep leftover upload files and compact the CRM database now?">Compact &amp; sweep now</button>
          </div>
          <div class="cc-cleanup-item">
            <div>
              <strong>Empty spam, archived &amp; closed requests</strong>
              <span>${b.trashLeadsCount || 0} request(s) in Spam / Archived / Not Converted</span>
            </div>
            <button type="button" class="cc-btn cc-btn--danger cc-btn--sm" data-cleanup-scopes="spam_archived" data-cleanup-msg="Permanently delete all Spam, Archived, and Not Converted requests and their media?" ${b.trashLeadsCount ? '' : 'disabled'}>${ico('trash')}Delete (${b.trashLeadsCount || 0})</button>
          </div>
          <div class="cc-cleanup-item">
            <div>
              <strong>Delete photos/videos on closed jobs</strong>
              <span>${b.closedMediaCount || 0} file(s) · ${fmtBytes(b.closedMediaBytes || 0)}</span>
            </div>
            <button type="button" class="cc-btn cc-btn--danger cc-btn--sm" data-cleanup-scopes="closed_media" data-cleanup-msg="Keep completed/closed request records, but permanently delete their attached photos & videos to free space?" ${b.closedMediaCount ? '' : 'disabled'}>${ico('trash')}Free ${fmtBytes(b.closedMediaBytes || 0)}</button>
          </div>
          <div class="cc-cleanup-item">
            <div>
              <strong>Delete completed jobs</strong>
              <span>${b.completedLeadsCount || 0} completed request(s) + attached files</span>
            </div>
            <button type="button" class="cc-btn cc-btn--danger cc-btn--sm" data-cleanup-scopes="completed_leads" data-cleanup-msg="Permanently delete all Completed requests and their attached files?" ${b.completedLeadsCount ? '' : 'disabled'}>${ico('trash')}Delete (${b.completedLeadsCount || 0})</button>
          </div>
          <div class="cc-cleanup-item">
            <div>
              <strong>Clear visit stats, search imports &amp; logs</strong>
              <span>${b.webEventsCount || 0} visits · ${b.searchSnapshotsCount || 0} search rows · ${(b.notificationsCount || 0) + (b.auditLogsCount || 0)} alerts/logs</span>
            </div>
            <button type="button" class="cc-btn cc-btn--ghost cc-btn--sm" data-cleanup-scopes="analytics,logs" data-cleanup-msg="Clear all website visit logs, Google Search imports, alerts, and activity logs?">Clear stats &amp; logs</button>
          </div>
          <div class="cc-cleanup-item">
            <div>
              <strong>Delete all photos &amp; videos</strong>
              <span>${cap.mediaStorage.activeAttachmentCount} file(s) · ${fmtBytes(cap.mediaStorage.activeOriginalBytes)}</span>
            </div>
            <button type="button" class="cc-btn cc-btn--danger cc-btn--sm" data-cleanup-scopes="all_media" data-cleanup-msg="Permanently delete EVERY uploaded photo and video across all requests?" ${cap.mediaStorage.activeAttachmentCount ? '' : 'disabled'}>${ico('trash')}Delete all media</button>
          </div>
          <div class="cc-cleanup-item cc-cleanup-item--danger">
            <div>
              <strong>Delete all requests &amp; customers</strong>
              <span>${b.allLeadsCount || 0} request(s) · ${b.customersCount || 0} customer(s) · resets CRM records</span>
            </div>
            <button type="button" class="cc-btn cc-btn--danger cc-btn--sm" data-cleanup-scopes="all_leads_customers" data-cleanup-msg="Permanently delete ALL requests, customers, appointments, notes, and uploaded files? This cannot be undone." ${b.allLeadsCount || b.customersCount ? '' : 'disabled'}>${ico('trash')}Delete all CRM records</button>
          </div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card__head">
          <h2>Database backups (${res.backups.length} · ${fmtBytes(b.backupsBytes || 0)})</h2>
          ${res.backups.length ? `<button id="delete-all-backups-btn" type="button" class="cc-btn cc-btn--sm cc-btn--danger">${ico('trash')}Delete all backups</button>` : ''}
        </div>
        ${
          res.backups.length
            ? table(
                H,
                res.backups
                  .map((bk) =>
                    tr(H, [
                      `<code>${esc(bk.filename)}</code>`,
                      esc(fmtChicago(bk.createdAt)),
                      esc(fmtBytes(bk.byteSize)),
                      `<span class="cc-inline-actions">
                        <a class="cc-btn cc-btn--sm cc-btn--ghost" href="/api/owner/backups/${encodeURIComponent(bk.filename)}">${ico('download')}Download .sqlite</a>
                        <button type="button" class="cc-btn cc-btn--sm cc-btn--danger" data-del-backup="${esc(bk.filename)}">${ico('trash')}Delete</button>
                      </span>`
                    ])
                  )
                  .join('')
              )
            : emptyState('No backups yet', 'Tap “Back up now” to save a snapshot of your CRM.')
        }
      </div>`;

    bindClick(document.getElementById('create-backup-btn'), async () => {
      await api('/api/owner/backups', { method: 'POST' });
      toast('Backup created');
      renderReports(state.navSeq);
    });

    bindClick(document.getElementById('delete-all-backups-btn'), async () => {
      if (!confirm(`Delete all ${res.backups.length} backup file(s) from disk?`)) return;
      const out = await api('/api/owner/backups', { method: 'DELETE' });
      toast(`Deleted ${out.deletedCount || 0} backup(s) · freed ${fmtBytes(out.bytesFreed || 0)}`);
      renderReports(state.navSeq);
    });

    workspace.querySelectorAll('[data-del-backup]').forEach((btn) =>
      bindClick(btn, async () => {
        if (!confirm(`Delete backup ${btn.dataset.delBackup} from disk?`)) return;
        const out = await api(`/api/owner/backups/${encodeURIComponent(btn.dataset.delBackup)}`, { method: 'DELETE' });
        toast(`Backup deleted · freed ${fmtBytes(out.bytesFreed || 0)}`);
        renderReports(state.navSeq);
      })
    );

    workspace.querySelectorAll('[data-cleanup-scopes]').forEach((btn) =>
      bindClick(btn, async () => {
        if (!confirm(btn.dataset.cleanupMsg || 'Run this storage cleanup now?')) return;
        const scopes = btn.dataset.cleanupScopes.split(',').filter(Boolean);
        const out = await api('/api/owner/storage/cleanup', { method: 'POST', body: { scopes } });
        const s = out.summary || {};
        toast(`Cleaned storage · freed ${fmtBytes(s.bytesFreed || 0)}`);
        refreshUnreadLeadBadge();
        refreshNotifications();
        renderReports(state.navSeq);
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 15. SETTINGS (/owner/settings/)                                        */
  /* ---------------------------------------------------------------------- */
  async function renderSettings(seq) {
    const [res, notifRes, pushSt] = await Promise.all([
      api('/api/owner/settings'),
      api('/api/owner/notifications'),
      getDetailedPushStatus()
    ]);
    if (seq !== state.navSeq) return;
    const s = res.settings;
    const np = notifRes.preferences;
    const H = ['Service', 'Provider', 'Status'];

    workspace.innerHTML = `
      ${pageHead('Settings', 'Changes apply right away to your public upload form, phone alerts, and private storage.')}

      <div class="cc-card" id="settings-push-card">
        <h2>Mobile app notifications &amp; live real-time sync</h2>
        ${renderPushControlCard(pushSt)}
      </div>

      <div class="cc-grid-2">
        <div class="cc-card">
          <h2>Customer uploads</h2>
          <form id="settings-form" class="cc-form">
            <div class="cc-form-row">
              <div class="cc-field"><label for="st-max-photos">Max photos per request</label><input id="st-max-photos" class="cc-input" type="number" min="1" max="50" value="${esc(s.max_photos)}" /></div>
              <div class="cc-field"><label for="st-max-videos">Max videos per request</label><input id="st-max-videos" class="cc-input" type="number" min="0" max="15" value="${esc(s.max_videos)}" /></div>
              <div class="cc-field"><label for="st-photo-mb">Max photo size (MB)</label><input id="st-photo-mb" class="cc-input" type="number" min="1" max="100" value="${Math.round(Number(s.max_photo_bytes) / (1024 * 1024))}" /></div>
              <div class="cc-field"><label for="st-video-mb">Max video size (MB)</label><input id="st-video-mb" class="cc-input" type="number" min="5" max="1024" value="${Math.round(Number(s.max_video_bytes) / (1024 * 1024))}" /></div>
              <div class="cc-field"><label for="st-quota-mb">Storage space (MB)</label><input id="st-quota-mb" class="cc-input" type="number" min="50" value="${Math.round(Number(s.storage_quota_bytes) / (1024 * 1024))}" /></div>
              <div class="cc-field"><label for="st-idle">Temporary sign-in timeout (min)</label><input id="st-idle" class="cc-input" type="number" min="5" max="43200" value="${esc(s.session_idle_minutes)}" /></div>
            </div>
            <label class="cc-check"><input id="st-preserve" type="checkbox" ${s.preserve_original_uploads ? 'checked' : ''} /><span>Keep the untouched original uploads next to the compressed previews</span></label>
            <button class="cc-btn cc-btn--primary cc-btn--block" type="submit">Save settings</button>
          </form>
        </div>

        <div class="cc-card">
          <h2>Where to send alerts</h2>
          <form id="notif-prefs-form" class="cc-form">
            <div class="cc-field"><label for="np-email">Alert email (needs EMAIL_PROVIDER_API_KEY)</label><input id="np-email" class="cc-input" type="email" value="${esc(np.email_address || '')}" /></div>
            <label class="cc-check"><input id="np-email-on" type="checkbox" ${np.email_enabled ? 'checked' : ''} /><span>Email me about new requests</span></label>
            <div class="cc-field"><label for="np-sms">Alert text number (needs SMS_TWILIO_*)</label><input id="np-sms" class="cc-input" type="tel" value="${esc(np.sms_phone || '')}" /></div>
            <label class="cc-check"><input id="np-sms-on" type="checkbox" ${np.sms_enabled ? 'checked' : ''} /><span>Text me about new requests</span></label>
            <button class="cc-btn cc-btn--navy cc-btn--block" type="submit">Save alert settings</button>
          </form>

          <h3 class="cc-h3">Connected services</h3>
          ${table(H, res.integrations.map((i) => tr(H, [esc(i.id), esc(i.name), statusPill(i.status)])).join(''))}

          ${
            res.localVaultMode || readPref('zoiris.cloudApiUrl', '')
              ? `<div class="login-section">
                   <h3 class="cc-h3">Custom Dedicated API Server (Optional)</h3>
                   <p class="cc-fine">Your website (<strong>www.zoirisjunkremoval.com</strong>) and mobile app already sync requests and lock-screen push notifications live 24/7. Leave this blank unless you host a separate custom Node/SQLite server.</p>
                   <form id="cloud-url-form" class="cc-form">
                     <div class="cc-field"><label for="cloud-api-url">Custom Node CRM Server URL</label><input id="cloud-api-url" class="cc-input" type="url" placeholder="https://api.zoirisjunkremoval.com" value="${esc(readPref('zoiris.cloudApiUrl', ''))}" /></div>
                     <button class="cc-btn cc-btn--ghost cc-btn--block" type="submit">Save custom URL &amp; reload</button>
                   </form>
                 </div>`
              : ''
          }
        </div>
      </div>`;

    bindForm('cloud-url-form', async () => {
      const val = document.getElementById('cloud-api-url').value.trim().replace(/\/+$/, '');
      if (val) writePref('zoiris.cloudApiUrl', val);
      else localStorage.removeItem('zoiris.cloudApiUrl');
      toast('Sync setting saved — reloading…');
      setTimeout(() => window.location.reload(), 500);
    });

    bindForm('settings-form', async () => {
      await api('/api/owner/settings', {
        method: 'PUT',
        body: {
          max_photos: Number(document.getElementById('st-max-photos').value),
          max_videos: Number(document.getElementById('st-max-videos').value),
          max_photo_bytes: Number(document.getElementById('st-photo-mb').value) * 1024 * 1024,
          max_video_bytes: Number(document.getElementById('st-video-mb').value) * 1024 * 1024,
          storage_quota_bytes: Number(document.getElementById('st-quota-mb').value) * 1024 * 1024,
          session_idle_minutes: Number(document.getElementById('st-idle').value),
          preserve_original_uploads: document.getElementById('st-preserve').checked
        }
      });
      toast('Settings saved');
    });

    bindForm('notif-prefs-form', async () => {
      await api('/api/owner/notification-preferences', {
        method: 'PUT',
        body: {
          inAppEnabled: true,
          soundEnabled: !!state.prefs.sound_enabled,
          desktopEnabled: !!state.prefs.desktop_enabled,
          emailEnabled: document.getElementById('np-email-on').checked,
          emailAddress: document.getElementById('np-email').value.trim(),
          smsEnabled: document.getElementById('np-sms-on').checked,
          smsPhone: document.getElementById('np-sms').value.trim()
        }
      });
      toast('Alert settings saved');
    });

    wirePushControls(document.getElementById('settings-push-card'), () => renderSettings(state.navSeq));
  }

  /* ---------------------------------------------------------------------- */
  /* 16. SECURITY (/owner/security/)                                        */
  /* ---------------------------------------------------------------------- */
  async function renderSecurity(seq) {
    const res = await api('/api/owner/security');
    if (seq !== state.navSeq) return;
    const H = ['When', 'Who', 'Action', 'Item'];
    const sessions = Array.isArray(res.sessions) ? res.sessions : [];
    const currentId = res.currentSessionId || state.sessionId || '';
    const curSession = sessions.find((s) => s.id === currentId);
    if (curSession?.deviceLabel) {
      state.currentDevice = curSession.deviceLabel;
      state.deviceKind = curSession.deviceKind || state.deviceKind;
    }
    state.activeDeviceCount = sessions.length || 1;
    updateDeviceIndicators();

    workspace.innerHTML = `
      ${pageHead(
        'Security',
        `Signed in as <strong>${esc(res.owner.email)}</strong>${state.currentDevice ? ` · Logged in from <strong>${esc(state.currentDevice)}</strong>` : ''} · 2-step sign-in: <strong>${res.owner.mfaEnabled ? 'On' : 'Off'}</strong>`,
        sessions.length > 1
          ? `<button id="sec-revoke-btn" type="button" class="cc-btn cc-btn--danger cc-btn--sm">Sign out other devices (${sessions.length - 1})</button>`
          : ''
      )}

      <div class="cc-card">
        <div class="cc-card__head">
          <h2>Devices signed in (${sessions.length})</h2>
          <span class="cc-muted">Phone, tablet &amp; computer can stay signed in at the same time</span>
        </div>
        ${
          sessions.length
            ? `<div class="cc-device-list">
                ${sessions
                  .map((s) => {
                    const isHere = s.id === currentId;
                    return `<div class="cc-device-row ${isHere ? 'is-current' : ''}" data-device-session="${esc(s.id)}">
                      <div class="cc-device-row__main">
                        <span class="cc-device-row__ico">${ico(deviceIconName(s.deviceKind))}</span>
                        <div class="cc-device-row__body">
                          <div class="cc-device-row__title">
                            <strong>${esc(s.deviceLabel || 'Signed-in device')}</strong>
                            ${isHere ? '<span class="cc-pill cc-pill--done">This device</span>' : ''}
                            <span class="cc-pill">${s.rememberDevice ? 'Stays signed in · 30d' : 'Temporary'}</span>
                          </div>
                          <div class="cc-device-row__meta">
                            Active ${esc(timeAgo(s.last_active_at))} · Signed in ${esc(fmtChicago(s.created_at))}${s.ip_hint ? ` · Net #${esc(s.ip_hint)}` : ''}
                          </div>
                        </div>
                      </div>
                      <button type="button" class="cc-btn cc-btn--sm ${isHere ? 'cc-btn--ghost' : 'cc-btn--danger'}" data-revoke-sess="${esc(s.id)}" data-revoke-current="${isHere ? '1' : '0'}">${isHere ? 'Sign out here' : 'Sign out'}</button>
                    </div>`;
                  })
                  .join('')}
              </div>`
            : emptyState('No active sessions', 'Sign in again to register your device.')
        }
      </div>

      <div class="cc-grid-2">
        <div class="cc-card">
          <h2>Change password</h2>
          <form id="sec-pw-form" class="cc-form">
            <div class="cc-field"><label for="sec-cur-pw">Current password</label><input id="sec-cur-pw" class="cc-input" type="password" autocomplete="current-password" required /></div>
            <div class="cc-field"><label for="sec-new-pw">New password (12+ characters)</label><input id="sec-new-pw" class="cc-input" type="password" autocomplete="new-password" minlength="12" required /></div>
            <button class="cc-btn cc-btn--primary cc-btn--block" type="submit">Update password</button>
          </form>
        </div>

        <div class="cc-card">
          <h2>2-step sign-in (authenticator app)</h2>
          ${
            res.owner.mfaEnabled
              ? `<p>2-step sign-in is protecting your account.</p>
                 <form id="sec-mfa-disable" class="cc-form">
                   <div class="cc-field"><label for="mfa-dis-pw">Confirm password to turn it off</label><input id="mfa-dis-pw" class="cc-input" type="password" required /></div>
                   <button class="cc-btn cc-btn--danger" type="submit">Turn off 2-step sign-in</button>
                 </form>`
              : `<p class="cc-fine">Protect customer records with an authenticator app (Google Authenticator, Authy, 1Password) plus 8 one-time recovery codes.</p>
                 <button id="sec-mfa-begin" type="button" class="cc-btn cc-btn--navy">Set up 2-step sign-in</button>
                 <div id="sec-mfa-box" hidden></div>`
          }
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card__head">
          <h2>Activity log (${res.auditLogs.length})</h2>
          ${res.auditLogs.length ? `<button id="sec-clear-logs" type="button" class="cc-btn cc-btn--sm cc-btn--danger">${ico('trash')}Clear log</button>` : ''}
        </div>
        ${table(
          H,
          res.auditLogs
            .map((a) => tr(H, [esc(fmtChicago(a.created_at)), esc(a.actor_email || 'system'), `<code>${esc(a.action)}</code>`, `${esc(a.entity_type)} ${esc(a.entity_id || '')}`]))
            .join('')
        )}
      </div>`;

    workspace.querySelectorAll('[data-revoke-sess]').forEach((btn) =>
      bindClick(btn, async () => {
        const isCurrent = btn.dataset.revokeCurrent === '1';
        if (isCurrent && !confirm('Sign out on this device now?')) return;
        const out = await api(`/api/owner/security/sessions/${encodeURIComponent(btn.dataset.revokeSess)}`, { method: 'DELETE' });
        if (out.signedOutCurrent) {
          window.location.replace(ownerUrl('/owner/login/'));
          return;
        }
        toast('Device signed out');
        renderSecurity(state.navSeq);
      })
    );

    bindClick(document.getElementById('sec-clear-logs'), async () => {
      if (!confirm('Clear the security activity log and old login attempts?')) return;
      const out = await api('/api/owner/security/audit-logs', { method: 'DELETE' });
      toast(`Cleared ${out.deleted || 0} log row(s)`);
      renderSecurity(state.navSeq);
    });

    bindClick(document.getElementById('sec-revoke-btn'), async () => {
      await api('/api/owner/security/revoke-sessions', { method: 'POST' });
      toast('Other devices signed out');
      renderSecurity(state.navSeq);
    });

    bindForm('sec-pw-form', async () => {
      await api('/api/owner/security/password', {
        method: 'POST',
        body: { currentPassword: document.getElementById('sec-cur-pw').value, newPassword: document.getElementById('sec-new-pw').value }
      });
      toast('Password updated');
      document.getElementById('sec-pw-form').reset();
    });

    const beginBtn = document.getElementById('sec-mfa-begin');
    bindClick(beginBtn, async () => {
      const enroll = await api('/api/owner/security/mfa/begin', { method: 'POST' });
      const box = document.getElementById('sec-mfa-box');
      box.hidden = false;
      box.innerHTML = `
        <div class="cc-alert cc-alert--ok">
          <div><strong>Setup key:</strong> <code>${esc(enroll.secret)}</code></div>
          <div class="cc-break">URI: <code>${esc(enroll.otpauthUri)}</code></div>
        </div>
        <form id="sec-mfa-confirm" class="cc-form">
          <div class="cc-field"><label for="mfa-code">6-digit code from your app</label><input id="mfa-code" class="cc-input" type="text" inputmode="numeric" autocomplete="one-time-code" required /></div>
          <button class="cc-btn cc-btn--primary" type="submit">Verify &amp; turn on</button>
        </form>`;
      bindForm('sec-mfa-confirm', async () => {
        const done = await api('/api/owner/security/mfa/confirm', {
          method: 'POST',
          body: { code: document.getElementById('mfa-code').value.trim() }
        });
        openModal('Save your recovery codes', `<p>Keep these 8 one-time codes somewhere safe:</p><pre class="cc-log">${esc((done.recoveryCodes || []).join('\n'))}</pre>`);
        renderSecurity(state.navSeq);
      });
    });

    bindForm('sec-mfa-disable', async () => {
      await api('/api/owner/security/mfa/disable', { method: 'POST', body: { password: document.getElementById('mfa-dis-pw').value } });
      toast('2-step sign-in turned off');
      renderSecurity(state.navSeq);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* ROUTER & BOOTSTRAP                                                     */
  /* ---------------------------------------------------------------------- */
  const ROUTES = {
    '/owner/command-center/': ['today', renderToday],
    '/owner/stats/': ['more', renderStats],
    '/owner/leads/': ['leads', renderLeads],
    '/owner/map/': ['map', renderMap],
    '/owner/calendar/': ['calendar', renderCalendar],
    '/owner/pipeline/': ['more', renderPipeline],
    '/owner/customers/': ['more', renderCustomers],
    '/owner/media/': ['more', renderMedia],
    '/owner/analytics/': ['more', renderAnalytics],
    '/owner/search-performance/': ['more', renderSearchPerformance],
    '/owner/locations/': ['more', renderLocations],
    '/owner/seo-pages/': ['more', renderSeoPages],
    '/owner/reports/': ['more', renderReports],
    '/owner/settings/': ['more', renderSettings],
    '/owner/security/': ['more', renderSecurity]
  };

  async function route({ keepScroll = false } = {}) {
    const seq = ++state.navSeq;
    const p = currentPath();
    const isDetail = p.startsWith('/owner/leads/') && p !== '/owner/leads/';
    const entry = ROUTES[p] || (isDetail ? ['leads', null] : null);

    if (!entry) {
      history.replaceState(null, '', ownerUrl('/owner/command-center/'));
      return route();
    }

    destroyMaps();
    document.querySelectorAll('.cc-nav__link').forEach((link) => {
      const r = link.getAttribute('data-route');
      const on = p === r || (r === '/owner/leads/' && isDetail);
      link.classList.toggle('is-active', on);
      if (on) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.querySelectorAll('.cc-tab').forEach((t) => {
      const on = t.dataset.tab === entry[0];
      t.classList.toggle('is-active', on);
      if (t.tagName === 'A') {
        if (on) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      }
    });
    const title = isDetail ? 'Request' : PAGE_TITLES[p] || 'Command Center';
    document.getElementById('cc-greeting').textContent = title;
    document.title = `${title} · Zoiris Command Center`;
    document.body.dataset.view = isDetail ? 'detail' : entry[0] === 'more' ? p.split('/')[2] : entry[0];

    if (!keepScroll) window.scrollTo(0, 0);
    try {
      if (isDetail) {
        const seg = decodeURIComponent(stripBase(window.location.pathname).slice('/owner/leads/'.length).replace(/\/+$/, ''));
        await renderLeadDetail(seg, seq);
      } else {
        await entry[1](seq);
      }
    } catch (err) {
      if (seq !== state.navSeq) return;
      workspace.innerHTML = `<div class="cc-alert cc-alert--error" role="alert">${ico('alert')}Couldn’t load this screen: ${esc(err.message)}
        <button type="button" class="cc-btn cc-btn--sm cc-btn--ghost" id="cc-retry">Try again</button></div>`;
      document.getElementById('cc-retry')?.addEventListener('click', () => route());
    }
  }

  function startClock() {
    const el = document.getElementById('cc-clock');
    const tick = () => {
      el.textContent = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date());
    };
    tick();
    setInterval(tick, 30000);
  }

  async function init() {
    const st = await api('/api/auth/status');
    if (!st.authenticated) {
      window.location.replace(ownerUrl('/owner/login/'));
      return;
    }
    state.owner = st.owner;
    state.csrfToken = st.csrfToken;
    state.sessionId = st.sessionId || null;
    state.currentDevice = st.currentDevice || '';
    state.deviceKind = st.deviceKind || 'desktop';
    state.activeDeviceCount = Number(st.activeDeviceCount || 1);
    updateDeviceIndicators();
    try {
      const justSignedIn = sessionStorage.getItem('zoiris_just_signed_in');
      if (justSignedIn) {
        sessionStorage.removeItem('zoiris_just_signed_in');
        toast(`Logged in from ${justSignedIn}`);
      }
      if (sessionStorage.getItem('zoiris_just_paired_push') === '1') {
        sessionStorage.removeItem('zoiris_just_paired_push');
        toast('24/7 encrypted website form & phone alerts paired!');
      }
      if (sessionStorage.getItem('zoiris_just_connected_cloud') === '1') {
        sessionStorage.removeItem('zoiris_just_connected_cloud');
        toast('Live real-time lead sync connected!');
      }
    } catch {}
    try {
      const ghSpaPath = sessionStorage.getItem('zoiris_gh_spa_path');
      if (ghSpaPath) {
        sessionStorage.removeItem('zoiris_gh_spa_path');
        history.replaceState(null, '', ghSpaPath);
      }
    } catch {}
    startClock();
    connectRealtime();
    refreshNotifications();
    api('/api/owner/push/sync-relay', { method: 'POST' })
      .then((r) => {
        if (r?.imported > 0) {
          refreshNotifications();
          refreshUnreadLeadBadge();
          softRefresh();
        }
      })
      .catch(() => {});
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      getDetailedPushStatus()
        .then((ps) => {
          if (ps?.supported && ps.cloudConnected && ps.vapidPublicKey && !ps.thisDeviceSubscribed) {
            return subscribeDeviceWebPush(ps.vapidPublicKey, { sendWelcome: false });
          }
          return null;
        })
        .catch(() => {});
    }
    await route();
  }

  init().catch(() => window.location.replace(ownerUrl('/owner/login/')));
})();
