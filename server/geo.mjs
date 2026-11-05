/**
 * server/geo.mjs
 * Nationwide United States real-address search + rooftop verification for the Pickup Request form & CRM.
 *
 *  - Primary:   Esri ArcGIS World Geocoding Service (`suggest`, `findAddressCandidates`, `reverseGeocode`, `USA`)
 *               for rooftop parcel (`PointAddress` / `Subaddress`) & street-interpolated (`StreetAddress`) matches.
 *  - Secondary: Official U.S. Census Bureau Geocoder (TIGER address ranges + counties across all 50 states, DC & territories).
 *  - Tertiary:  OpenStreetMap Photon (`photon.komoot.io`, `countrycode=US`) house-number fallback.
 *  - Tokens:    A verified result is returned with a short-lived HMAC token so the inquiry endpoint can trust
 *               the canonical U.S. address + coordinates without re-geocoding.
 *
 * ZOIRIS_GEOCODER=mock switches to a deterministic offline fixture for automated tests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SERVICE_COUNTIES = {
  '01097': 'Mobile County',
  '01003': 'Baldwin County'
};

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida',
  GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa',
  MP: 'Northern Mariana Islands'
};

const US_STATE_BY_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr])
);

export function normalizeUsState(raw = '') {
  const clean = String(raw || '').replace(/\./g, '').trim();
  if (!clean) return '';
  const up = clean.toUpperCase();
  if (US_STATES[up]) return up;
  return US_STATE_BY_NAME[clean.toLowerCase()] || '';
}

const ARCGIS_BASE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const UA = 'ZoirisJunkRemoval/2.1 (+https://www.zoirisjunkremoval.com; US pickup address verification)';
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

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

function inferHomeCountyFips(stateAbbr, countyName = '') {
  if (stateAbbr !== 'AL') return '';
  const n = String(countyName || '').toLowerCase();
  if (n.startsWith('mobile')) return '01097';
  if (n.startsWith('baldwin')) return '01003';
  return '';
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseArcgisSuggestionText(text = '') {
  const parts = String(text)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  let idx = parts.length - 1;
  if (/^(USA|United States|US|PRI|VIR|GUM|ASM|MNP)$/i.test(parts[idx])) idx--;
  let zip = '';
  if (idx >= 2 && /^\d{5}(-\d{4})?$/.test(parts[idx])) {
    zip = parts[idx].slice(0, 5);
    idx--;
  }
  if (idx < 1) return null;
  let statePart = parts[idx];
  const stZipMatch = statePart.match(/^([A-Za-z .]+?)\s+(\d{5})(?:-\d{4})?$/);
  if (stZipMatch) {
    statePart = stZipMatch[1];
    if (!zip) zip = stZipMatch[2];
  }
  const state = normalizeUsState(statePart);
  if (!state) return null;
  idx--;
  if (idx < 1) return null;
  const city = parts[idx];
  const line = parts.slice(0, idx).join(', ');
  if (!/^\d/.test(line)) return null;
  return { line, city, state, zip };
}

function arcgisCandidateToAddress(cand) {
  const a = cand?.attributes || {};
  const loc = cand?.location;
  if (!loc || typeof loc.y !== 'number' || typeof loc.x !== 'number') return null;
  if (a.Country && !/^(USA|PRI|VIR|GUM|ASM|MNP)$/i.test(String(a.Country))) return null;
  const state = normalizeUsState(a.RegionAbbr || a.Region || '');
  if (!state) return null;
  const baseSt = String(a.StAddr || '').trim();
  const sub = String(a.SubAddr || '').trim();
  const rawLine =
    baseSt && sub && !baseSt.toLowerCase().includes(sub.toLowerCase())
      ? `${baseSt} ${sub}`
      : baseSt || String(cand.address || '').split(',')[0]?.trim() || '';
  if (!rawLine || !/^\d/.test(rawLine)) return null;
  const countyName = cleanText(a.Subregion || '', 80);
  const countyFips = inferHomeCountyFips(state, countyName);
  return {
    line: rawLine,
    city: cleanText(a.City || '', 80),
    state,
    zip: String(a.Postal || '').slice(0, 5),
    lat: Number(Number(loc.y).toFixed(6)),
    lng: Number(Number(loc.x).toFixed(6)),
    countyFips,
    countyName,
    addrType: String(a.Addr_type || ''),
    addNum: String(a.AddNum || ''),
    score: Number(cand.score || 0)
  };
}

/* ------------------------------------------------------------------------ */
/* Deterministic offline fixture (ZOIRIS_GEOCODER=mock)                     */
/* ------------------------------------------------------------------------ */
const MOCK_CITIES = {
  mobile: { zip: '36604', state: 'AL', county: '01097', countyName: 'Mobile County', lat: 30.6809, lng: -88.0712 },
  daphne: { zip: '36526', state: 'AL', county: '01003', countyName: 'Baldwin County', lat: 30.6035, lng: -87.9036 },
  fairhope: { zip: '36532', state: 'AL', county: '01003', countyName: 'Baldwin County', lat: 30.5227, lng: -87.9033 },
  'spanish fort': { zip: '36527', state: 'AL', county: '01003', countyName: 'Baldwin County', lat: 30.6749, lng: -87.9153 },
  saraland: { zip: '36571', state: 'AL', county: '01097', countyName: 'Mobile County', lat: 30.8207, lng: -88.0706 },
  atlanta: { zip: '30303', state: 'GA', county: '13121', countyName: 'Fulton County', lat: 33.749, lng: -84.388 },
  austin: { zip: '78701', state: 'TX', county: '48453', countyName: 'Travis County', lat: 30.2747, lng: -97.7404 },
  'new york': { zip: '10118', state: 'NY', county: '36061', countyName: 'New York County', lat: 40.7484, lng: -73.9857 },
  miami: { zip: '33132', state: 'FL', county: '12086', countyName: 'Miami-Dade County', lat: 25.7845, lng: -80.1887 },
  'los angeles': { zip: '90028', state: 'CA', county: '06037', countyName: 'Los Angeles County', lat: 34.1016, lng: -118.3387 },
  chicago: { zip: '60601', state: 'IL', county: '17031', countyName: 'Cook County', lat: 41.8853, lng: -87.6216 },
  seattle: { zip: '98101', state: 'WA', county: '53033', countyName: 'King County', lat: 47.6097, lng: -122.3331 },
  washington: { zip: '20500', state: 'DC', county: '11001', countyName: 'District of Columbia', lat: 38.8977, lng: -77.0365 }
};

function mockParse(text) {
  const t = cleanText(text, 240);
  const m = t.match(/^(\d{1,6}[A-Za-z]?)\s+([^,]+?)(?:,\s*([^,]+?))?(?:,\s*([A-Za-z .]+?))?(?:,?\s*(\d{5}|[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d))?$/);
  if (!m) return null;
  const rawCity = (m[3] || 'Mobile').trim();
  const rawState = (m[4] || '').trim();
  const rawZip = (m[5] || '').trim();
  return { number: m[1], street: m[2].trim(), rawCity, rawState, rawZip };
}

function mockLookup(text, explicitState = '') {
  const p = mockParse(text);
  if (!p) return null;
  if (/fake|nowhere|test street|asdf|forged/i.test(p.street)) return null;
  const numVal = parseInt(p.number, 10);
  if (!Number.isFinite(numVal) || numVal <= 0 || numVal > 90000) return null;

  const stateHint = explicitState || p.rawState;
  if (stateHint && !normalizeUsState(stateHint)) {
    return { outsideUs: true };
  }
  if (p.rawZip && !/^\d{5}$/.test(p.rawZip)) {
    return { outsideUs: true };
  }

  const cityKey = p.rawCity.toLowerCase();
  const known = MOCK_CITIES[cityKey];
  const state = normalizeUsState(stateHint) || known?.state || 'AL';
  const baseLat = known?.lat ?? 35.2271;
  const baseLng = known?.lng ?? -80.8431;
  const seed = [...(p.number + p.street + cityKey + state)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 100000, 7);

  return {
    line: `${p.number} ${titleCaseAddress(p.street)}`,
    city: known ? titleCaseAddress(cityKey) : titleCaseAddress(p.rawCity || 'Mobile'),
    state,
    zip: p.rawZip || known?.zip || '36604',
    lat: Number((baseLat + ((seed % 200) - 100) / 20000).toFixed(6)),
    lng: Number((baseLng + ((Math.floor(seed / 200) % 200) - 100) / 20000).toFixed(6)),
    countyFips: known?.county || '',
    countyName: known?.countyName || ''
  };
}

/* ------------------------------------------------------------------------ */
/* Service factory                                                          */
/* ------------------------------------------------------------------------ */
export function createGeoService({ masterKey, fetchImpl = globalThis.fetch, mode = process.env.ZOIRIS_GEOCODER || 'live' } = {}) {
  const cache = new Map();
  const CACHE_TTL = 10 * 60 * 1000;

  function cacheGet(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    cache.delete(key);
    return undefined;
  }
  function cacheSet(key, value) {
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }

  async function arcgisCandidates({ singleLine, magicKey = '', maxLocations = 6 }) {
    const params = new URLSearchParams({
      f: 'json',
      singleLine,
      countryCode: 'USA',
      category: 'Point Address,Street Address,Subaddress',
      outFields: 'Addr_type,Match_addr,StAddr,AddNum,City,Subregion,Region,RegionAbbr,Postal,Country',
      maxLocations: String(maxLocations)
    });
    if (magicKey) params.set('magicKey', magicKey);
    const data = await fetchJson(fetchImpl, `${ARCGIS_BASE}/findAddressCandidates?${params.toString()}`, 6000);
    return Array.isArray(data?.candidates) ? data.candidates : [];
  }

  /* ---------------------------- suggestions ----------------------------- */
  async function suggest(rawQuery) {
    const q = cleanText(rawQuery, 140);
    if (q.length < 3) return { ok: true, suggestions: [], source: 'none' };
    const typedNumber = (q.match(/^\s*(\d{1,6}[A-Za-z]?)\b/) || [])[1] || '';

    if (mode === 'mock') {
      const hit = mockLookup(q.includes(',') ? q : `${q}, Mobile, AL`);
      if (!hit || hit.outsideUs) return { ok: true, source: 'mock', suggestions: [] };
      return {
        ok: true,
        source: 'mock',
        suggestions: [
          {
            label: `${hit.line}, ${hit.city}, ${hit.state} ${hit.zip}`,
            line: hit.line,
            city: hit.city,
            state: hit.state,
            zip: hit.zip,
            lat: hit.lat,
            lng: hit.lng,
            precision: 'house',
            countyName: hit.countyName
          }
        ]
      };
    }

    const key = `s:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const seen = new Set();
    const suggestions = [];

    // 1. Primary: Esri ArcGIS nationwide U.S. autocomplete
    try {
      const sugUrl =
        `${ARCGIS_BASE}/suggest?` +
        new URLSearchParams({
          f: 'json',
          text: q,
          countryCode: 'USA',
          category: 'Point Address,Street Address,Subaddress',
          maxSuggestions: '8'
        }).toString();
      const data = await fetchJson(fetchImpl, sugUrl, 4500);
      for (const s of data?.suggestions || []) {
        if (s.isCollection) continue;
        const parsed = parseArcgisSuggestionText(s.text || '');
        if (!parsed) continue;
        const label = [parsed.line, parsed.city, `${parsed.state}${parsed.zip ? ' ' + parsed.zip : ''}`].filter(Boolean).join(', ');
        const dedupe = `${parsed.line}|${parsed.city}|${parsed.state}`.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        suggestions.push({
          label,
          line: parsed.line,
          city: parsed.city,
          state: parsed.state,
          zip: parsed.zip,
          precision: 'house',
          magicKey: s.magicKey || '',
          singleLine: s.text || label
        });
        if (suggestions.length >= 7) break;
      }
    } catch {}

    // 2. Highway / route alias fallback via ArcGIS findAddressCandidates
    if (!suggestions.length && typedNumber) {
      try {
        const cands = await arcgisCandidates({ singleLine: q, maxLocations: 6 });
        for (const c of cands) {
          if (Number(c.score || 0) < 82) continue;
          const addr = arcgisCandidateToAddress(c);
          if (!addr) continue;
          const label = [addr.line, addr.city, `${addr.state}${addr.zip ? ' ' + addr.zip : ''}`].filter(Boolean).join(', ');
          const dedupe = `${addr.line}|${addr.city}|${addr.state}`.toLowerCase();
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          suggestions.push({
            label,
            line: addr.line,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            lat: addr.lat,
            lng: addr.lng,
            precision: 'house',
            countyName: addr.countyName,
            singleLine: label
          });
        }
      } catch {}
    }

    if (suggestions.length) {
      const out = { ok: true, suggestions, source: 'arcgis' };
      cacheSet(key, out);
      return out;
    }

    // 3. Tertiary fallback: OpenStreetMap Photon across the United States
    try {
      const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({ q, limit: '10', lang: 'en' }).toString();
      const data = await fetchJson(fetchImpl, url, 5000);
      for (const f of data.features || []) {
        const p = f.properties || {};
        const [lng, lat] = f.geometry?.coordinates || [];
        if (String(p.countrycode || '').toUpperCase() !== 'US') continue;
        if (typeof lat !== 'number' || typeof lng !== 'number') continue;
        const streetName = p.street || (p.osm_key === 'highway' || p.type === 'street' ? p.name : '');
        if (!streetName) continue;
        const cleanNum = typedNumber.replace(/[A-Za-z]$/, '');
        if (cleanNum && p.housenumber && String(p.housenumber) !== cleanNum) continue;
        const number = p.housenumber || typedNumber;
        if (!number) continue;
        const state = normalizeUsState(p.state || '');
        if (!state) continue;
        const line = `${number} ${titleCaseAddress(streetName)}`;
        const city = p.city || p.locality || p.district || '';
        const zip = p.postcode && /^\d{5}/.test(p.postcode) ? p.postcode.slice(0, 5) : '';
        const label = [line, city, `${state}${zip ? ' ' + zip : ''}`].filter(Boolean).join(', ');
        const dedupe = `${line}|${city}|${state}`.toLowerCase();
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
          countyName: cleanText(p.county || '', 80)
        });
        if (suggestions.length >= 7) break;
      }
      const out = { ok: true, suggestions, source: 'openstreetmap' };
      cacheSet(key, out);
      return out;
    } catch {
      return { ok: true, suggestions: [], source: 'unavailable' };
    }
  }

  /* ------------------------- reverse (use my location) ------------------ */
  async function reverse(rawLat, rawLng) {
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: true, suggestions: [], source: 'none' };
    if (mode === 'mock') return suggest('1450 Government St, Mobile, AL');

    // 1. Primary: ArcGIS rooftop reverseGeocode
    try {
      const revUrl =
        `${ARCGIS_BASE}/reverseGeocode?` +
        new URLSearchParams({
          f: 'json',
          location: `${lng},${lat}`,
          featureTypes: 'PointAddress,StreetAddress,Subaddress',
          langCode: 'EN'
        }).toString();
      const data = await fetchJson(fetchImpl, revUrl, 5000);
      const a = data?.address || {};
      const loc = data?.location || { x: lng, y: lat };
      if (a.CountryCode && !/^(USA|PRI|VIR|GUM|ASM|MNP)$/i.test(String(a.CountryCode))) {
        return {
          ok: true,
          suggestions: [],
          source: 'outside',
          message: 'Your current location appears to be outside the United States. Please enter a U.S. pickup address.'
        };
      }
      const state = normalizeUsState(a.RegionAbbr || a.Region || '');
      const line = cleanText(a.Address || '', 140);
      if (state && line && /^\d/.test(line)) {
        const city = cleanText(a.City || '', 80);
        const zip = String(a.Postal || '').slice(0, 5);
        const label = [line, city, `${state}${zip ? ' ' + zip : ''}`].filter(Boolean).join(', ');
        return {
          ok: true,
          source: 'arcgis',
          suggestions: [
            {
              label,
              line,
              city,
              state,
              zip,
              lat: Number(Number(loc.y ?? lat).toFixed(6)),
              lng: Number(Number(loc.x ?? lng).toFixed(6)),
              precision: 'house',
              countyName: cleanText(a.Subregion || '', 80),
              singleLine: label
            }
          ]
        };
      }
    } catch {}

    // 2. Fallback: OpenStreetMap Photon reverse
    try {
      const data = await fetchJson(
        fetchImpl,
        'https://photon.komoot.io/reverse?' + new URLSearchParams({ lat: String(lat), lon: String(lng), limit: '5', lang: 'en' }).toString(),
        5000
      );
      const suggestions = [];
      const seen = new Set();
      for (const f of data.features || []) {
        const p = f.properties || {};
        const [flng, flat] = f.geometry?.coordinates || [];
        if (String(p.countrycode || '').toUpperCase() !== 'US') continue;
        if (!p.housenumber || !(p.street || p.name)) continue;
        const state = normalizeUsState(p.state || '');
        if (!state) continue;
        const line = `${p.housenumber} ${titleCaseAddress(p.street || p.name)}`;
        const city = p.city || p.locality || p.district || '';
        const zip = p.postcode ? String(p.postcode).slice(0, 5) : '';
        const label = [line, city, `${state}${zip ? ' ' + zip : ''}`].filter(Boolean).join(', ');
        if (seen.has(label)) continue;
        seen.add(label);
        suggestions.push({
          label,
          line,
          city,
          state,
          zip,
          lat: Number(flat.toFixed(6)),
          lng: Number(flng.toFixed(6)),
          precision: 'house',
          countyName: cleanText(p.county || '', 80)
        });
      }
      return { ok: true, suggestions, source: 'openstreetmap' };
    } catch {
      return { ok: true, suggestions: [], source: 'unavailable' };
    }
  }

  /* ---------------------------- verification ---------------------------- */
  function buildOneLine({ line, city, state, zip, singleLine }) {
    if (singleLine) return cleanText(singleLine, 220);
    const l = cleanText(line, 160);
    const c = cleanText(city, 80);
    const st = normalizeUsState(state || '') || cleanText(state || '', 20);
    const z = cleanText(zip, 10);
    return [l, c, `${st} ${z}`.trim()].filter(Boolean).join(', ');
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
    const data = await fetchJson(fetchImpl, url, 8500);
    const m = data?.result?.addressMatches?.[0];
    if (!m) return null;
    const c = m.addressComponents || {};
    const state = normalizeUsState(c.state || '');
    if (!state) return null;
    const number = (String(m.matchedAddress || '').match(/^(\d+[A-Z]?)/i) || [])[1] || '';
    const streetParts = [c.preQualifier, c.preDirection, c.preType, c.streetName, c.suffixType, c.suffixDirection, c.suffixQualifier]
      .filter(Boolean)
      .join(' ');
    const county = m.geographies?.Counties?.[0] || {};
    return {
      line: titleCaseAddress(`${number} ${streetParts}`),
      city: titleCaseAddress(c.city || ''),
      state,
      zip: c.zip || '',
      lat: Number(Number(m.coordinates?.y).toFixed(6)),
      lng: Number(Number(m.coordinates?.x).toFixed(6)),
      countyFips: county.GEOID || inferHomeCountyFips(state, county.NAME || ''),
      countyName: county.NAME || ''
    };
  }

  async function osmHouseLookup(oneLine, typedNumber) {
    if (!typedNumber) return null;
    const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({ q: oneLine, limit: '6', lang: 'en' }).toString();
    const data = await fetchJson(fetchImpl, url, 5000);
    for (const f of data.features || []) {
      const p = f.properties || {};
      const [lng, lat] = f.geometry?.coordinates || [];
      if (String(p.countrycode || '').toUpperCase() !== 'US') continue;
      if (String(p.housenumber || '') !== typedNumber) continue;
      const state = normalizeUsState(p.state || '');
      if (!state || typeof lat !== 'number' || typeof lng !== 'number') continue;
      const countyName = cleanText(p.county || '', 80);
      return {
        line: `${typedNumber} ${titleCaseAddress(p.street || p.name || '')}`,
        city: p.city || p.locality || '',
        state,
        zip: p.postcode ? String(p.postcode).slice(0, 5) : '',
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        countyFips: inferHomeCountyFips(state, countyName),
        countyName
      };
    }
    return null;
  }

  async function verify(input = {}) {
    const line = cleanText(input.line || input.street || '', 160);
    const typedNumber = (line.match(/^\s*(\d{1,6}[A-Za-z]?)\b/) || [])[1] || '';
    if (!typedNumber) {
      return { status: 'not-found', message: 'Please include the house or building number (for example 1450 Government St).' };
    }

    const explicitState = cleanText(input.state || '', 32);
    if (explicitState && !normalizeUsState(explicitState)) {
      return {
        status: 'outside-area',
        message: 'Please enter a valid pickup address within the United States (50 states, DC, or U.S. territories).'
      };
    }

    const oneLine = buildOneLine({
      line,
      city: input.city,
      state: explicitState,
      zip: input.zip,
      singleLine: input.singleLine
    });

    if (mode === 'mock') {
      const hit = mockLookup(oneLine, explicitState);
      if (hit?.outsideUs) {
        return {
          status: 'outside-area',
          message: 'Please enter a valid pickup address within the United States (50 states, DC, or U.S. territories).'
        };
      }
      return hit
        ? withToken({ status: 'verified', source: 'mock', address: hit })
        : { status: 'not-found', message: notFoundMessage() };
    }

    const magicKey = cleanText(input.magicKey || '', 260);
    const key = `v:${oneLine.toLowerCase()}|${magicKey}`;
    const cached = cacheGet(key);
    if (cached) return withToken(cached);

    const cleanTypedNum = typedNumber.replace(/[A-Za-z]$/, '');
    let arcgisFailed = false;
    try {
      const cands = await arcgisCandidates({ singleLine: oneLine, magicKey, maxLocations: 6 });
      const valid = [];
      for (const c of cands) {
        const t = String(c?.attributes?.Addr_type || '');
        if (!['PointAddress', 'Subaddress', 'StreetAddress'].includes(t)) continue;
        if (Number(c.score || 0) < 85) continue;
        const addNum = String(c?.attributes?.AddNum || '').replace(/[A-Za-z]$/, '');
        if (cleanTypedNum && addNum && addNum !== cleanTypedNum) continue;
        const addr = arcgisCandidateToAddress(c);
        if (addr) valid.push(addr);
      }

      if (valid.length > 0) {
        const hasLocationContext =
          Boolean(magicKey) ||
          Boolean(cleanText(input.city || '', 80)) ||
          Boolean(cleanText(input.zip || '', 10)) ||
          line.includes(',');
        if (!hasLocationContext && valid.length > 1) {
          const distinctCities = [...new Set(valid.map((v) => `${v.city}, ${v.state}`))];
          if (distinctCities.length > 1) {
            const examples = distinctCities.slice(0, 2).join(' or ');
            return {
              status: 'not-found',
              message: `Multiple U.S. cities match "${line}" (${examples}). Add the city and state or ZIP code to pin the exact address.`
            };
          }
        }
        const best = valid[0];
        const { addrType, addNum: _n, score: _s, ...address } = best;
        const res = {
          status: addrType === 'PointAddress' || addrType === 'Subaddress' ? 'verified' : 'map-match',
          source: 'arcgis',
          address
        };
        cacheSet(key, res);
        return withToken(res);
      }
    } catch {
      arcgisFailed = true;
    }

    let censusFailed = false;
    try {
      const hit = await censusLookup(oneLine);
      if (hit) {
        const res = { status: 'verified', source: 'census', address: hit };
        cacheSet(key, res);
        return withToken(res);
      }
    } catch {
      censusFailed = true;
    }

    let osmFailed = false;
    try {
      const hit = await osmHouseLookup(oneLine, cleanTypedNum);
      if (hit) {
        const res = { status: 'map-match', source: 'openstreetmap', address: hit };
        cacheSet(key, res);
        return withToken(res);
      }
    } catch {
      osmFailed = true;
    }

    if (arcgisFailed && censusFailed && osmFailed) {
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
    return "We couldn't find or verify that U.S. street address. Check the house number, street, city, and state/ZIP, or call 251-930-8621.";
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
      if (!normalizeUsState(payload.state || '')) return null;
      if (!Number.isFinite(Number(payload.lat)) || !Number.isFinite(Number(payload.lng))) return null;
      return {
        status: payload.status,
        source: payload.source,
        address: {
          line: payload.line,
          city: payload.city,
          state: normalizeUsState(payload.state),
          zip: payload.zip,
          lat: Number(payload.lat),
          lng: Number(payload.lng),
          countyFips: payload.countyFips || '',
          countyName: payload.countyName || ''
        }
      };
    } catch {
      return null;
    }
  }

  return { suggest, reverse, verify, readToken, mode };
}
