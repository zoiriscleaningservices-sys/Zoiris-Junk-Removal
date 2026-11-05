/* command-center/assets/map.js
 * ZMap — tiny dependency-free slippy map for the Zoiris Command Center.
 *  - Street tiles: OpenStreetMap (© OpenStreetMap contributors)
 *  - Satellite: USGS The National Map imagery (public domain), native to z16,
 *    over-zoomed (scaled parent tiles) for z17–19.
 *  - Drag / touch pan, pinch zoom, double-tap zoom, +/− buttons, keyboard,
 *    branded pins, fit-to-markers. No API keys, no external scripts.
 */
(function () {
  const TILE = 256;
  const LAYERS = {
    street: {
      label: 'Street',
      maxNative: 19,
      url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    },
    satellite: {
      label: 'Satellite',
      maxNative: 19,
      url: (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      attribution: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>'
    }
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const worldSize = (z) => TILE * Math.pow(2, z);

  function project(lat, lng, z) {
    const s = worldSize(z);
    const la = clamp(lat, -85.05112878, 85.05112878) * (Math.PI / 180);
    return {
      x: ((lng + 180) / 360) * s,
      y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * s
    };
  }

  function unproject(x, y, z) {
    const s = worldSize(z);
    const lng = (x / s) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / s;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  function pinSvg(color, glyph) {
    const g = glyph ? String(glyph).slice(0, 2).replace(/[<>&"]/g, '') : '';
    return `<svg viewBox="0 0 36 46" width="36" height="46" aria-hidden="true" focusable="false">
      <ellipse cx="18" cy="43.5" rx="7" ry="2.2" fill="rgba(11,21,34,.28)"/>
      <path d="M18 1.5C9.2 1.5 2.5 8.1 2.5 16.6c0 11.2 13.1 24 14.4 25.2a1.6 1.6 0 0 0 2.2 0C20.4 40.6 33.5 27.8 33.5 16.6 33.5 8.1 26.8 1.5 18 1.5Z" fill="${color}" stroke="#0b1522" stroke-width="2.4"/>
      <circle cx="18" cy="16.5" r="8.4" fill="#fbf8f2"/>
      ${g ? `<text x="18" y="20.4" text-anchor="middle" font-size="10.5" font-weight="800" font-family="system-ui,sans-serif" fill="#0b1522">${g}</text>` : `<circle cx="18" cy="16.5" r="3.6" fill="${color}"/>`}
    </svg>`;
  }

  function create(container, opts = {}) {
    const o = Object.assign(
      {
        center: [30.6954, -88.0399], // Mobile, AL
        zoom: 12,
        minZoom: 3,
        maxZoom: 19,
        layer: 'street',
        markers: [],
        wheel: false,
        fit: false,
        maxFitZoom: 16,
        onMarkerClick: null,
        onLayerChange: null
      },
      opts
    );

    let zoom = clamp(Math.round(o.zoom), o.minZoom, o.maxZoom);
    let center = project(o.center[0], o.center[1], zoom); // world px at current zoom
    let layer = LAYERS[o.layer] ? o.layer : 'street';
    let markers = [];
    const tiles = new Map();
    let selectedId = null;

    container.classList.add('zmap');
    container.setAttribute('tabindex', '0');
    container.setAttribute('role', 'application');
    container.setAttribute('aria-roledescription', 'map');
    if (!container.getAttribute('aria-label')) container.setAttribute('aria-label', 'Map. Use arrow keys to move, plus and minus to zoom.');
    container.innerHTML = `
      <div class="zmap__pane">
        <div class="zmap__tiles"></div>
        <div class="zmap__markers"></div>
      </div>
      <div class="zmap__ctrl zmap__ctrl--layer" role="group" aria-label="Map style">
        <button type="button" data-zlayer="street">Street</button>
        <button type="button" data-zlayer="satellite">Satellite</button>
      </div>
      <div class="zmap__ctrl zmap__ctrl--zoom">
        <button type="button" data-zoom="1" aria-label="Zoom in">+</button>
        <button type="button" data-zoom="-1" aria-label="Zoom out">&minus;</button>
        <button type="button" data-zfit hidden aria-label="Show all pins" title="Show all pins">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="zmap__attr"></div>`;

    const pane = container.querySelector('.zmap__pane');
    const tileLayer = container.querySelector('.zmap__tiles');
    const markerLayer = container.querySelector('.zmap__markers');
    const attrEl = container.querySelector('.zmap__attr');
    const fitBtn = container.querySelector('[data-zfit]');

    function size() {
      return { w: container.clientWidth || 300, h: container.clientHeight || 240 };
    }

    function syncLayerButtons() {
      container.querySelectorAll('[data-zlayer]').forEach((b) => {
        const on = b.dataset.zlayer === layer;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      attrEl.innerHTML = LAYERS[layer].attribution;
      container.classList.toggle('zmap--sat', layer === 'satellite');
    }

    function renderTiles() {
      const { w, h } = size();
      const L = LAYERS[layer];
      const tz = Math.min(zoom, L.maxNative);
      const ts = TILE * Math.pow(2, zoom - tz); // over-zoom tile size
      const n = Math.pow(2, tz);
      const tlx = center.x - w / 2;
      const tly = center.y - h / 2;
      const x0 = Math.floor(tlx / ts);
      const x1 = Math.floor((tlx + w) / ts);
      const y0 = Math.max(0, Math.floor(tly / ts));
      const y1 = Math.min(n - 1, Math.floor((tly + h) / ts));
      const wanted = new Set();
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const wx = ((tx % n) + n) % n;
          const key = `${layer}/${tz}/${tx}/${ty}`;
          wanted.add(key);
          let img = tiles.get(key);
          if (!img) {
            img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.referrerPolicy = 'strict-origin-when-cross-origin';
            img.className = 'zmap__tile';
            img.addEventListener('load', () => img.classList.add('is-loaded'));
            img.addEventListener('error', () => img.classList.add('is-failed'));
            img.src = L.url(tz, wx, ty);
            tiles.set(key, img);
            tileLayer.appendChild(img);
          }
          img.style.width = `${ts}px`;
          img.style.height = `${ts}px`;
          img.style.transform = `translate3d(${Math.round(tx * ts - tlx)}px, ${Math.round(ty * ts - tly)}px, 0)`;
        }
      }
      for (const [key, img] of tiles) {
        if (!wanted.has(key)) {
          img.remove();
          tiles.delete(key);
        }
      }
    }

    function renderMarkers() {
      const { w, h } = size();
      const tlx = center.x - w / 2;
      const tly = center.y - h / 2;
      const projected = markers.map((m) => ({ m, p: project(m.lat, m.lng, zoom) }));
      // Fan out co-located pins (e.g. Unit A & Unit B or repeat requests at the same address)
      const groups = new Map();
      for (const item of projected) {
        const key = `${Math.round(item.p.x / 8)}:${Math.round(item.p.y / 8)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const list of groups.values()) {
        list.forEach((item, idx) => {
          let fx = 0;
          let fy = 0;
          if (list.length > 1) {
            const angle = (idx / list.length) * Math.PI * 2;
            const radius = 22;
            fx = Math.round(Math.cos(angle) * radius);
            fy = Math.round(Math.sin(angle) * radius * 0.65);
          }
          const { m, p } = item;
          m.el.style.transform = `translate3d(${Math.round(p.x - tlx + fx)}px, ${Math.round(p.y - tly + fy)}px, 0)`;
          m.el.classList.toggle('is-selected', m.id != null && m.id === selectedId);
        });
      }
    }

    function render() {
      renderTiles();
      renderMarkers();
      container.querySelector('[data-zoom="1"]').disabled = zoom >= o.maxZoom;
      container.querySelector('[data-zoom="-1"]').disabled = zoom <= o.minZoom;
    }

    function setZoom(nz, anchor) {
      nz = clamp(Math.round(nz), o.minZoom, o.maxZoom);
      if (nz === zoom) return;
      const { w, h } = size();
      const ax = anchor ? anchor.x : w / 2;
      const ay = anchor ? anchor.y : h / 2;
      // world point under the anchor stays fixed
      const wx = center.x - w / 2 + ax;
      const wy = center.y - h / 2 + ay;
      const f = Math.pow(2, nz - zoom);
      center = { x: wx * f - ax + w / 2, y: wy * f - ay + h / 2 };
      zoom = nz;
      render();
    }

    function setView(lat, lng, z) {
      if (z != null) zoom = clamp(Math.round(z), o.minZoom, o.maxZoom);
      center = project(lat, lng, zoom);
      render();
    }

    function fitToMarkers() {
      if (!markers.length) return;
      const pad = typeof o.fitPadding === 'function' ? o.fitPadding() : o.fitPadding || {};
      const P = Object.assign({ top: 56, right: 60, bottom: 40, left: 40 }, pad);
      // Account for the 36x46px pin body anchored at its bottom tip so pins never slide under controls
      const L = P.left + 20;
      const R = P.right + 20;
      const T = P.top + 46;
      const B = P.bottom + 8;
      const { w, h } = size();
      const aw = Math.max(40, w - L - R);
      const ah = Math.max(40, h - T - B);
      const offX = (R - L) / 2;
      const offY = (B - T) / 2;
      if (markers.length === 1) {
        zoom = clamp(Math.min(o.maxFitZoom + 1, o.maxZoom), o.minZoom, o.maxZoom);
        const p = project(markers[0].lat, markers[0].lng, zoom);
        center = { x: p.x + offX, y: p.y + offY };
        render();
        return;
      }
      let best = o.minZoom;
      for (let z = Math.min(o.maxFitZoom, o.maxZoom); z >= o.minZoom; z--) {
        const pts = markers.map((m) => project(m.lat, m.lng, z));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        if (Math.max(...xs) - Math.min(...xs) <= aw && Math.max(...ys) - Math.min(...ys) <= ah) {
          best = z;
          break;
        }
      }
      zoom = best;
      const pts = markers.map((m) => project(m.lat, m.lng, zoom));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      center = { x: (Math.min(...xs) + Math.max(...xs)) / 2 + offX, y: (Math.min(...ys) + Math.max(...ys)) / 2 + offY };
      render();
    }

    function setMarkers(list) {
      markerLayer.innerHTML = '';
      markers = (list || [])
        .filter((m) => Number.isFinite(Number(m.lat)) && Number.isFinite(Number(m.lng)))
        .map((m) => {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'zmap__pin';
          el.innerHTML = pinSvg(m.color || '#f26b1d', m.glyph) + (m.label ? `<span class="zmap__pin-label">${m.label}</span>` : '');
          el.setAttribute('aria-label', m.title || 'Map pin');
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (moved) return;
            selectedId = m.id ?? null;
            renderMarkers();
            if (typeof o.onMarkerClick === 'function') o.onMarkerClick(m);
          });
          markerLayer.appendChild(el);
          return Object.assign({}, m, { lat: Number(m.lat), lng: Number(m.lng), el });
        });
      fitBtn.hidden = markers.length < 2;
      renderMarkers();
    }

    function setLayer(name) {
      if (!LAYERS[name] || name === layer) return;
      layer = name;
      for (const img of tiles.values()) img.remove();
      tiles.clear();
      syncLayerButtons();
      render();
      if (typeof o.onLayerChange === 'function') o.onLayerChange(layer);
    }

    /* ---------- Interaction: pointer pan + pinch ---------- */
    const pointers = new Map();
    let moved = false;
    let pinch = null;
    let lastTap = 0;

    function localXY(ev) {
      const r = container.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    pane.addEventListener('pointerdown', (ev) => {
      if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
      pointers.set(ev.pointerId, localXY(ev));
      // Pointer capture is deferred until real movement so taps on pins still fire `click`.
      if (pointers.size === 1) moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale: 1 };
      }
      container.classList.add('is-dragging');
    });

    pane.addEventListener('pointermove', (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      const prev = pointers.get(ev.pointerId);
      const cur = localXY(ev);
      pointers.set(ev.pointerId, cur);
      if (pointers.size === 1 && !pinch) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          if (!moved && Math.hypot(dx, dy) < 3) {
            pointers.set(ev.pointerId, prev);
            return;
          }
          if (!moved) {
            try {
              pane.setPointerCapture(ev.pointerId);
            } catch {}
          }
          moved = true;
          center = { x: center.x - dx, y: center.y - dy };
          render();
        }
      } else if (pointers.size === 2 && pinch) {
        moved = true;
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // pan with the midpoint
        center = { x: center.x - (mid.x - pinch.mid.x) / pinch.scale, y: center.y - (mid.y - pinch.mid.y) / pinch.scale };
        pinch.mid = mid;
        pinch.scale = clamp(d / pinch.d0, 0.25, 8);
        renderTiles();
        renderMarkers();
        pane.style.transformOrigin = `${mid.x}px ${mid.y}px`;
        pane.style.transform = `scale(${pinch.scale})`;
      }
    });

    function endPointer(ev) {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      if (pinch && pointers.size < 2) {
        const dz = Math.round(Math.log2(pinch.scale));
        const anchor = pinch.mid;
        pane.style.transform = '';
        pinch = null;
        if (dz) setZoom(zoom + dz, anchor);
        else render();
      }
      if (pointers.size === 0) {
        container.classList.remove('is-dragging');
        // double-tap / double-click zoom
        if (!moved && ev.type === 'pointerup' && !ev.target.closest('.zmap__pin')) {
          const now = Date.now();
          if (now - lastTap < 320) {
            setZoom(zoom + 1, localXY(ev));
            lastTap = 0;
          } else lastTap = now;
        }
        setTimeout(() => (moved = false), 0);
      }
    }
    pane.addEventListener('pointerup', endPointer);
    pane.addEventListener('pointercancel', endPointer);

    if (o.wheel) {
      let wheelLock = 0;
      container.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault();
          const now = Date.now();
          if (now - wheelLock < 180) return;
          wheelLock = now;
          setZoom(zoom + (ev.deltaY < 0 ? 1 : -1), localXY(ev));
        },
        { passive: false }
      );
    }

    container.addEventListener('keydown', (ev) => {
      if (ev.target !== container) return;
      const step = 80;
      const k = ev.key;
      if (k === 'ArrowLeft') center.x -= step;
      else if (k === 'ArrowRight') center.x += step;
      else if (k === 'ArrowUp') center.y -= step;
      else if (k === 'ArrowDown') center.y += step;
      else if (k === '+' || k === '=') return void (ev.preventDefault(), setZoom(zoom + 1));
      else if (k === '-' || k === '_') return void (ev.preventDefault(), setZoom(zoom - 1));
      else return;
      ev.preventDefault();
      render();
    });

    container.querySelectorAll('[data-zoom]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setZoom(zoom + Number(b.dataset.zoom));
      })
    );
    container.querySelectorAll('[data-zlayer]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setLayer(b.dataset.zlayer);
      })
    );
    fitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fitToMarkers();
    });

    let ro = null;
    if ('ResizeObserver' in window) {
      let last = '';
      ro = new ResizeObserver(() => {
        const { w, h } = size();
        const sig = `${w}x${h}`;
        if (sig !== last) {
          last = sig;
          render();
        }
      });
      ro.observe(container);
    }

    syncLayerButtons();
    setMarkers(o.markers);
    if (o.fit && markers.length) fitToMarkers();
    else render();

    return {
      setMarkers,
      setLayer,
      setView,
      fitToMarkers,
      select(id) {
        selectedId = id;
        renderMarkers();
      },
      zoomIn: () => setZoom(zoom + 1),
      zoomOut: () => setZoom(zoom - 1),
      getZoom: () => zoom,
      getLayer: () => layer,
      getCenter: () => unproject(center.x, center.y, zoom),
      destroy() {
        if (ro) ro.disconnect();
        container.innerHTML = '';
        container.classList.remove('zmap');
      }
    };
  }

  window.ZMap = { create, pinSvg, LAYERS };
})();
