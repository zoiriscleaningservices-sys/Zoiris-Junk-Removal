/**
 * server/geo.mjs
 * Real-address search + verification for the public Pickup Request form.
 *
 *  - Suggestions:  OpenStreetMap data via the Photon geocoder (photon.komoot.io), biased and
 *                  filtered to Mobile County + Baldwin County, Alabama.
 *  - Verification: U.S. Census Bureau Geocoder (TIGER address ranges — official, free, no key).
 *                  Falls back to an OpenStreetMap house-number match when the Census range
 *                  database does not know a brand-new address.
 *  - Tokens:       A verified result is returned with a short-lived HMAC token so the inquiry
 *                  endpoint can trust the canonical address + coordinates without re-geocoding.
 *
 * Honest limits: the Census geocoder confirms the house number falls inside a real address range
 * on a real street (and returns its county + coordinates); it does not prove someone lives there.
 * The owner still sees the pin, aerial photo, and Street View link in the Command Center.
 *
 * ZOIRIS_GEOCODER=mock switches to a deterministic offline fixture for automated tests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SERVICE_COUNTIES = {
  '01097': 'Mobile County',
  '01003': 'Baldwin County'
};

// [minLon, minLat, maxLon, maxLat] — generous box around Mobile + Baldwin counties
const SERVICE_BBOX = [-88.48, 30.13, -87.36, 31.34];
const UA = 'ZoirisJunkRemoval/2.0 (+https://www.zoirisjunkremoval.com; pickup address verification)';
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const STATE_ABBR = { alabama: 'AL', mississippi: 'MS', florida: 'FL', georgia: 'GA', tennessee: 'TN', louisiana: 'LA' };

function titleWord(w) {
  const up = w.toUpperCase();
  if (DIRECTIONALS.has(up)) return up;
  if (/^\d/.test(w)) return w.toUpperCase();
  return up.charAt(0) + up.slice(1).toLowerCase();
}

export function titleCaseAddress(s = '') {
  return String(s)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(titleWord)
    .join(' ');
}

function cleanText(v, max = 200) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function countyFromName(name = '') {
  const n = String(name).toLowerCase();
  if (n.startsWith('mobile')) return { fips: '01097', name: 'Mobile County' };
  if (n.startsWith('baldwin')) return { fips: '01003', name: 'Baldwin County' };
  return null;
}

function inBbox(lat, lng) {
  return lng >= SERVICE_BBOX[0] && lng <= SERVICE_BBOX[2] && lat >= SERVICE_BBOX[1] && lat <= SERVICE_BBOX[3];
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------------ */
/* Deterministic offline fixture (ZOIRIS_GEOCODER=mock)                     */
/* ------------------------------------------------------------------------ */
const MOCK_CITIES = {
  mobile: { zip: '36604', county: '01097', lat: 30.6809, lng: -88.0712 },
  daphne: { zip: '36526', county: '01003', lat: 30.6035, lng: -87.9036 },
  fairhope: { zip: '36532', county: '01003', lat: 30.5227, lng: -87.9033 },
  'spanish fort': { zip: '36527', county: '01003', lat: 30.6749, lng: -87.9153 },
  saraland: { zip: '36571', county: '01097', lat: 30.8207, lng: -88.0706 },
  atlanta: { zip: '30303', county: '13121', lat: 33.749, lng: -84.388, state: 'GA', countyName: 'Fulton County' }
};

function mockParse(text) {
  const t = cleanText(text, 240);
  const m = t.match(/^(\d{1,6})\s+([^,]+?)(?:,\s*([^,]+?))?(?:,\s*([A-Za-z]{2}))?(?:,?\s*(\d{5}))?$/);
  if (!m) return null;
  const cityKey = (m[3] || 'Mobile').toLowerCase().trim();
  const city = MOCK_CITIES[cityKey] ? cityKey : null;
  return { number: m[1], street: m[2], cityKey: city, zip: m[5] || '' };
}

function mockLookup(text) {
  const p = mockParse(text);
  if (!p || /fake|nowhere|test street|asdf/i.test(p.street) || Number(p.number) > 90000) return null;
  const c = MOCK_CITIES[p.cityKey || 'mobile'];
  const seed = [...(p.number + p.street)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 100000, 7);
  return {
    line: `${p.number} ${titleCaseAddress(p.street)}`,
    city: titleCaseAddress(p.cityKey || 'mobile'),
    state: c.state || 'AL',
    zip: p.zip || c.zip,
    lat: Number((c.lat + ((seed % 200) - 100) / 20000).toFixed(6)),
    lng: Number((c.lng + ((Math.floor(seed / 200) % 200) - 100) / 20000).toFixed(6)),
    countyFips: c.county,
    countyName: c.countyName || SERVICE_COUNTIES[c.county] || ''
  };
}

/* ------------------------------------------------------------------------ */
/* Service factory                                                          */
/* ------------------------------------------------------------------------ */
export function createGeoService({ masterKey, fetchImpl = globalThis.fetch, mode = process.env.ZOIRIS_GEOCODER || 'live' } = {}) {
  const cache = new Map(); // key -> { at, value }
  const CACHE_TTL = 10 * 60 * 1000;

  function cacheGet(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    cache.delete(key);
    return undefined;
  }
  function cacheSet(key, value) {
    if (cache.size > 600) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }

  /* ---------------------------- suggestions ----------------------------- */
  async function suggest(rawQuery) {
    const q = cleanText(rawQuery, 120);
    if (q.length < 3) return { ok: true, suggestions: [], source: 'none' };
    const typedNumber = (q.match(/^\s*(\d{1,6})\b/) || [])[1] || '';

    if (mode === 'mock') {
      const hit = mockLookup(q.includes(',') ? q : `${q}, Mobile`);
      return {
        ok: true,
        source: 'mock',
        suggestions: hit
          ? [{ label: `${hit.line}, ${hit.city}, ${hit.state} ${hit.zip}`, line: hit.line, city: hit.city, state: hit.state, zip: hit.zip, lat: hit.lat, lng: hit.lng, precision: 'house' }]
          : []
      };
    }

    const key = `s:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const url =
      'https://photon.komoot.io/api/?' +
      new URLSearchParams({
        q: /mobile|baldwin|alabama|\bal\b/i.test(q) ? q : `${q}, Alabama`,
        limit: '10',
        lang: 'en',
        lat: '30.69',
        lon: '-88.04',
        bbox: SERVICE_BBOX.join(',')
      }).toString();

    let data;
    try {
      data = await fetchJson(fetchImpl, url, 5000);
    } catch {
      return { ok: true, suggestions: [], source: 'unavailable' };
    }

    const seen = new Set();
    const suggestions = [];
    for (const f of data.features || []) {
      const p = f.properties || {};
      const [lng, lat] = f.geometry?.coordinates || [];
      if (p.countrycode && p.countrycode !== 'US') continue;
      if (typeof lat !== 'number' || !inBbox(lat, lng)) continue;
      const county = countyFromName(p.county || '');
      if (!county) continue;
      const streetName = p.street || (p.osm_key === 'highway' || p.type === 'street' ? p.name : '');
      if (!streetName) continue;
      if (typedNumber && p.housenumber && String(p.housenumber) !== typedNumber) continue;
      const number = p.housenumber || typedNumber;
      if (!number) continue; // a pickup needs a house/building number
      const line = `${number} ${titleCaseAddress(streetName)}`;
      const city = p.city || p.locality || p.district || '';
      const state = STATE_ABBR[String(p.state || '').toLowerCase()] || 'AL';
      const zip = p.postcode && /^\d{5}/.test(p.postcode) ? p.postcode.slice(0, 5) : '';
      const label = [line, city, `${state}${zip ? ' ' + zip : ''}`].filter(Boolean).join(', ');
      const dedupe = `${line}|${city}`.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      suggestions.push({
        label,
        line,
        city,
        state,
        zip,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        precision: p.housenumber ? 'house' : 'street',
        countyName: county.name
      });
      if (suggestions.length >= 6) break;
    }
    const out = { ok: true, suggestions, source: 'openstreetmap' };
    cacheSet(key, out);
    return out;
  }

  /* ------------------------- reverse (use my location) ------------------ */
  async function reverse(rawLat, rawLng) {
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: true, suggestions: [], source: 'none' };
    if (!inBbox(lat, lng)) {
      return { ok: true, suggestions: [], source: 'outside', message: 'Your current location looks outside Mobile and Baldwin counties. Type the pickup address instead.' };
    }
    if (mode === 'mock') return suggest('1450 Government St, Mobile');
    let data;
    try {
      data = await fetchJson(
        fetchImpl,
        'https://photon.komoot.io/reverse?' + new URLSearchParams({ lat: String(lat), lon: String(lng), limit: '5', lang: 'en' }).toString(),
        5000
      );
    } catch {
      return { ok: true, suggestions: [], source: 'unavailable' };
    }
    const suggestions = [];
    const seen = new Set();
    for (const f of data.features || []) {
      const p = f.properties || {};
      const [flng, flat] = f.geometry?.coordinates || [];
      if (!p.housenumber || !(p.street || p.name)) continue;
      const county = countyFromName(p.county || '');
      if (!county) continue;
      const line = `${p.housenumber} ${titleCaseAddress(p.street || p.name)}`;
      const city = p.city || p.locality || p.district || '';
      const zip = p.postcode ? String(p.postcode).slice(0, 5) : '';
      const label = [line, city, `AL${zip ? ' ' + zip : ''}`].filter(Boolean).join(', ');
      if (seen.has(label)) continue;
      seen.add(label);
      suggestions.push({ label, line, city, state: 'AL', zip, lat: Number(flat.toFixed(6)), lng: Number(flng.toFixed(6)), precision: 'house', countyName: county.name });
    }
    return { ok: true, suggestions, source: 'openstreetmap' };
  }

  /* ---------------------------- verification ---------------------------- */
  function buildOneLine({ line, city, state, zip }) {
    const l = cleanText(line, 160);
    const c = cleanText(city, 80);
    const z = cleanText(zip, 10);
    if (!c && !z && !/\b(AL|Alabama)\b/i.test(l)) return `${l}, AL`;
    return [l, c, `${cleanText(state || 'AL', 4)} ${z}`.trim()].filter(Boolean).join(', ');
  }

  async function censusLookup(oneLine) {
    const url =
      'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?' +
      new URLSearchParams({
        address: oneLine,
        benchmark: 'Public_AR_Current',
        vintage: 'Current_Current',
        layers: 'Counties',
        format: 'json'
      }).toString();
    const data = await fetchJson(fetchImpl, url, 9000);
    const m = data?.result?.addressMatches?.[0];
    if (!m) return null;
    const c = m.addressComponents || {};
    const number = (String(m.matchedAddress || '').match(/^(\d+[A-Z]?)/i) || [])[1] || '';
    const streetParts = [c.preQualifier, c.preDirection, c.preType, c.streetName, c.suffixType, c.suffixDirection, c.suffixQualifier]
      .filter(Boolean)
      .join(' ');
    const county = m.geographies?.Counties?.[0] || {};
    return {
      line: titleCaseAddress(`${number} ${streetParts}`),
      city: titleCaseAddress(c.city || ''),
      state: (c.state || 'AL').toUpperCase(),
      zip: c.zip || '',
      lat: Number(Number(m.coordinates?.y).toFixed(6)),
      lng: Number(Number(m.coordinates?.x).toFixed(6)),
      countyFips: county.GEOID || '',
      countyName: county.NAME || ''
    };
  }

  async function osmHouseLookup(oneLine, typedNumber) {
    if (!typedNumber) return null;
    const url =
      'https://photon.komoot.io/api/?' +
      new URLSearchParams({ q: oneLine, limit: '5', lang: 'en', bbox: SERVICE_BBOX.join(',') }).toString();
    const data = await fetchJson(fetchImpl, url, 5000);
    for (const f of data.features || []) {
      const p = f.properties || {};
      const [lng, lat] = f.geometry?.coordinates || [];
      if (String(p.housenumber || '') !== typedNumber) continue;
      const county = countyFromName(p.county || '');
      if (!county || !inBbox(lat, lng)) continue;
      return {
        line: `${typedNumber} ${titleCaseAddress(p.street || p.name || '')}`,
        city: p.city || p.locality || '',
        state: 'AL',
        zip: p.postcode ? String(p.postcode).slice(0, 5) : '',
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        countyFips: county.fips,
        countyName: county.name
      };
    }
    return null;
  }

  function classify(hit, source) {
    if (!SERVICE_COUNTIES[hit.countyFips]) {
      return {
        status: 'outside-area',
        source,
        address: hit,
        message: `That address is in ${hit.countyName || 'an area'} outside Mobile and Baldwin counties. Please call 251-930-8621 and we'll tell you if we can help.`
      };
    }
    return { status: source === 'census' || source === 'mock' ? 'verified' : 'map-match', source, address: hit };
  }

  async function verify(input = {}) {
    const line = cleanText(input.line || input.street || '', 160);
    const typedNumber = (line.match(/^\s*(\d{1,6}[A-Za-z]?)\b/) || [])[1] || '';
    if (!typedNumber) {
      return { status: 'not-found', message: 'Please include the house or building number (for example 1450 Government St).' };
    }
    const oneLine = buildOneLine({ line, city: input.city, state: input.state, zip: input.zip });

    if (mode === 'mock') {
      const hit = mockLookup(oneLine);
      return hit ? withToken(classify(hit, 'mock')) : { status: 'not-found', message: notFoundMessage() };
    }

    const key = `v:${oneLine.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return withToken(cached);

    let censusFailed = false;
    let hit = null;
    try {
      hit = await censusLookup(oneLine);
    } catch {
      censusFailed = true;
    }
    if (hit) {
      const res = classify(hit, 'census');
      cacheSet(key, res);
      return withToken(res);
    }

    let osmFailed = false;
    try {
      hit = await osmHouseLookup(oneLine, typedNumber.replace(/[A-Za-z]$/, ''));
    } catch {
      osmFailed = true;
    }
    if (hit) {
      const res = classify(hit, 'openstreetmap');
      cacheSet(key, res);
      return withToken(res);
    }

    if (censusFailed && osmFailed) {
      return {
        status: 'unavailable',
        message: 'Address lookup is temporarily unavailable. You can still send your request — we will confirm the address with you.'
      };
    }
    const res = { status: 'not-found', message: notFoundMessage() };
    cacheSet(key, res);
    return res;
  }

  function notFoundMessage() {
    return "We couldn't find that address. Double-check the house number and street, or call 251-930-8621.";
  }

  /* ------------------------------ tokens -------------------------------- */
  function sign(payloadB64) {
    return createHmac('sha256', masterKey).update(`addr:${payloadB64}`).digest('base64url');
  }

  function withToken(res) {
    if (!masterKey || (res.status !== 'verified' && res.status !== 'map-match')) return res;
    const payload = { ...res.address, status: res.status, source: res.source, exp: Date.now() + TOKEN_TTL_MS };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { ...res, token: `${b64}.${sign(b64)}` };
  }

  function readToken(token) {
    if (!masterKey || typeof token !== 'string' || !token.includes('.')) return null;
    const [b64, sig] = token.split('.');
    const expected = sign(b64);
    const a = Buffer.from(sig || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (!payload.exp || payload.exp < Date.now()) return null;
      if (!SERVICE_COUNTIES[payload.countyFips]) return null;
      return {
        status: payload.status,
        source: payload.source,
        address: {
          line: payload.line,
          city: payload.city,
          state: payload.state,
          zip: payload.zip,
          lat: payload.lat,
          lng: payload.lng,
          countyFips: payload.countyFips,
          countyName: payload.countyName
        }
      };
    } catch {
      return null;
    }
  }

  return { suggest, reverse, verify, readToken, mode };
}
