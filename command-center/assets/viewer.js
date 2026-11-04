/* command-center/assets/viewer.js
 * ZViewer — fullscreen photo & video viewer for customer media.
 *  - Black backdrop, original-quality photo (streamUrl) with preview placeholder
 *  - Swipe left/right, arrow keys, counter "2 / 3", download + close
 *  - Pinch / double-tap / wheel zoom and drag-to-pan for photos
 *  - Native <video controls playsinline> for videos
 */
(function () {
  let root = null;
  let items = [];
  let index = 0;
  let lastFocus = null;
  let zoom = { s: 1, x: 0, y: 0 };
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  const ICON = {
    close: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function escAttr(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function build() {
    root = document.createElement('div');
    root.className = 'zv';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Customer photo and video viewer');
    root.innerHTML = `
      <div class="zv__top">
        <span class="zv__count" aria-live="polite"></span>
        <span class="zv__name"></span>
        <a class="zv__btn zv__dl" href="#" download aria-label="Download original">${ICON.download}<span>Download</span></a>
        <button type="button" class="zv__btn zv__close" aria-label="Close viewer">${ICON.close}</button>
      </div>
      <div class="zv__stage"><div class="zv__slide"></div></div>
      <button type="button" class="zv__nav zv__nav--prev" aria-label="Previous">${ICON.prev}</button>
      <button type="button" class="zv__nav zv__nav--next" aria-label="Next">${ICON.next}</button>
      <div class="zv__hint">Pinch or double-tap to zoom · swipe for next</div>`;
    document.body.appendChild(root);

    root.querySelector('.zv__close').addEventListener('click', close);
    root.querySelector('.zv__nav--prev').addEventListener('click', () => go(-1));
    root.querySelector('.zv__nav--next').addEventListener('click', () => go(1));

    const stage = root.querySelector('.zv__stage');
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener(
      'wheel',
      (ev) => {
        if (current()?.kind !== 'photo') return;
        ev.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(zoom.s * (ev.deltaY < 0 ? 1.25 : 0.8), ev.clientX - r.left - r.width / 2, ev.clientY - r.top - r.height / 2);
      },
      { passive: false }
    );

    document.addEventListener('keydown', (ev) => {
      if (!root || root.hidden) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      } else if (ev.key === 'ArrowRight') {
        if (ev.target?.tagName === 'VIDEO') return;
        go(1);
      } else if (ev.key === 'ArrowLeft') {
        if (ev.target?.tagName === 'VIDEO') return;
        go(-1);
      } else if (ev.key === 'Tab') {
        const f = [...root.querySelectorAll('a[href],button:not([disabled]),video')].filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    });
  }

  const current = () => items[index];

  function applyZoom(animate) {
    const img = root.querySelector('.zv__img');
    if (!img) return;
    img.style.transition = animate ? 'transform 180ms ease' : 'none';
    img.style.transform = `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`;
    root.classList.toggle('is-zoomed', zoom.s > 1.01);
  }

  function zoomAt(ns, ax = 0, ay = 0, animate = false) {
    ns = Math.min(5, Math.max(1, ns));
    // keep the point (ax, ay) relative to stage centre fixed
    const k = ns / zoom.s;
    zoom.x = ax - (ax - zoom.x) * k;
    zoom.y = ay - (ay - zoom.y) * k;
    zoom.s = ns;
    if (ns === 1) zoom = { s: 1, x: 0, y: 0 };
    applyZoom(animate);
  }

  function render(dir = 0) {
    const it = current();
    if (!it) return;
    zoom = { s: 1, x: 0, y: 0 };
    root.classList.remove('is-zoomed');
    root.querySelector('.zv__count').textContent = `${index + 1} / ${items.length}`;
    root.querySelector('.zv__name').textContent = it.name || '';
    const dl = root.querySelector('.zv__dl');
    if (it.download) {
      dl.href = it.download;
      dl.setAttribute('download', it.name || '');
      dl.hidden = false;
    } else dl.hidden = true;
    root.querySelector('.zv__nav--prev').hidden = items.length < 2;
    root.querySelector('.zv__nav--next').hidden = items.length < 2;
    root.classList.toggle('is-video', it.kind === 'video');
    root.querySelector('.zv__hint').textContent =
      it.kind === 'video'
        ? items.length > 1
          ? 'Swipe or use arrows for next'
          : ''
        : 'Pinch or double-tap to zoom · swipe for next';

    const slide = root.querySelector('.zv__slide');
    slide.querySelectorAll('video').forEach((v) => {
      try {
        v.pause();
      } catch {}
    });
    if (it.kind === 'video') {
      slide.innerHTML = `<video class="zv__video" src="${escAttr(it.src)}" controls playsinline preload="metadata"></video>`;
    } else {
      slide.innerHTML = `<img class="zv__img" src="${escAttr(it.preview || it.src)}" alt="${escAttr(it.name || 'Customer photo')}" draggable="false" />
        <span class="zv__loading" aria-hidden="true"></span>`;
      if (it.src && it.src !== it.preview) {
        const hi = new Image();
        hi.onload = () => {
          const img = slide.querySelector('.zv__img');
          if (img && current() === it) img.src = it.src;
          slide.querySelector('.zv__loading')?.remove();
        };
        hi.onerror = () => slide.querySelector('.zv__loading')?.remove();
        hi.src = it.src;
      } else slide.querySelector('.zv__loading')?.remove();
    }
    slide.style.transition = 'none';
    slide.style.transform = dir ? `translate3d(${dir * 40}px,0,0)` : '';
    slide.style.opacity = dir ? '0.2' : '1';
    requestAnimationFrame(() => {
      slide.style.transition = 'transform 200ms ease, opacity 200ms ease';
      slide.style.transform = '';
      slide.style.opacity = '1';
    });
  }

  function go(d) {
    if (items.length < 2) return;
    index = (index + d + items.length) % items.length;
    render(d);
  }

  function onDown(ev) {
    if (ev.target.closest('video')) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {}
    const r = ev.currentTarget.getBoundingClientRect();
    if (pointers.size === 1) {
      gesture = { type: 'pan', sx: ev.clientX, sy: ev.clientY, zx: zoom.x, zy: zoom.y, moved: false, r };
    } else if (pointers.size === 2 && current()?.kind === 'photo') {
      const [a, b] = [...pointers.values()];
      gesture = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        s0: zoom.s,
        cx: (a.x + b.x) / 2 - r.left - r.width / 2,
        cy: (a.y + b.y) / 2 - r.top - r.height / 2,
        moved: true,
        r
      };
    }
  }

  function onMove(ev) {
    if (!pointers.has(ev.pointerId) || !gesture) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (gesture.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(gesture.s0 * (d / gesture.d0), gesture.cx, gesture.cy);
      return;
    }
    if (gesture.type !== 'pan') return;
    const dx = ev.clientX - gesture.sx;
    const dy = ev.clientY - gesture.sy;
    if (Math.hypot(dx, dy) > 6) gesture.moved = true;
    if (zoom.s > 1.01) {
      zoom.x = gesture.zx + dx;
      zoom.y = gesture.zy + dy;
      applyZoom(false);
    } else if (gesture.moved) {
      const slide = root.querySelector('.zv__slide');
      slide.style.transition = 'none';
      slide.style.transform = `translate3d(${dx}px,0,0)`;
      slide.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 600));
    }
  }

  function onUp(ev) {
    if (!pointers.has(ev.pointerId)) return;
    const g = gesture;
    pointers.delete(ev.pointerId);
    if (pointers.size > 0) {
      if (g && g.type === 'pinch') {
        const [p] = [...pointers.values()];
        gesture = { type: 'pan', sx: p.x, sy: p.y, zx: zoom.x, zy: zoom.y, moved: true, r: g.r };
      }
      return;
    }
    gesture = null;
    if (!g) return;
    if (g.type === 'pan' && zoom.s <= 1.01) {
      const dx = ev.clientX - g.sx;
      const slide = root.querySelector('.zv__slide');
      if (g.moved && Math.abs(dx) > 60 && items.length > 1) {
        go(dx < 0 ? 1 : -1);
        return;
      }
      slide.style.transition = 'transform 160ms ease, opacity 160ms ease';
      slide.style.transform = '';
      slide.style.opacity = '1';
    }
    if (!g.moved && current()?.kind === 'photo') {
      const now = Date.now();
      if (now - lastTap < 300) {
        lastTap = 0;
        const ax = ev.clientX - g.r.left - g.r.width / 2;
        const ay = ev.clientY - g.r.top - g.r.height / 2;
        if (zoom.s > 1.01) zoomAt(1, 0, 0, true);
        else zoomAt(2.5, ax, ay, true);
      } else lastTap = now;
    }
  }

  function open(list, start = 0) {
    if (!list || !list.length) return;
    if (!root) build();
    items = list;
    index = Math.min(Math.max(0, start), list.length - 1);
    lastFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('zv-open');
    render(0);
    root.querySelector('.zv__close').focus();
  }

  function close() {
    if (!root || root.hidden) return;
    root.querySelectorAll('video').forEach((v) => {
      try {
        v.pause();
      } catch {}
    });
    root.querySelector('.zv__slide').innerHTML = '';
    root.hidden = true;
    document.documentElement.classList.remove('zv-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  window.ZViewer = { open, close, isOpen: () => !!root && !root.hidden };
})();
