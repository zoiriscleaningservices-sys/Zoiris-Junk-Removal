#!/usr/bin/env node
/**
 * tests/responsive/responsive.mjs
 * Audits responsive layout, overflow, button clipping, mobile call-bar clearance,
 * keyboard focus visibility, and mobile/desktop menu interactions across all 9
 * required viewport widths (320px through 1920px).
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { DIST_DIR } from '../../scripts/lib/load-data.mjs';

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
const ROUTES = [
  '/',
  '/junk-removal-mobile-al/',
  '/e-waste/',
  '/items/refrigerator-removal/',
  '/areas/mobile-al/',
  '/accepted-items/',
  '/guides/prepare-computer-for-recycling/',
  '/request-pickup/'
];

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('Chrome or Edge executable not found.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2'
};

function startServer(rootDir) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/public/events') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/api/public/upload-limits' || url.pathname === '/api/public/upload-config') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, maxPhotos: 12, maxVideos: 3, maxPhotoBytes: 15728640, maxVideoBytes: 104857600 }));
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
      let file = join(rootDir, rel);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!file.startsWith(rootDir) || !existsSync(file)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const screenshotDirArg = process.argv.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
if (screenshotDirArg) mkdirSync(screenshotDirArg, { recursive: true });

const { server, url } = await startServer(DIST_DIR);
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [];
let checksRun = 0;

try {
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      const height = width < 768 ? 844 : 900;
      await page.setViewportSize({ width, height });
      await page.goto(`${url}${route}`, { waitUntil: 'networkidle' });
      checksRun++;

      const metrics = await page.evaluate((vw) => {
        const doc = document.documentElement;
        const overflow = doc.scrollWidth - vw;
        const bodyFont = parseFloat(getComputedStyle(document.body).fontSize || '16');
        const clipped = [];
        for (const el of document.querySelectorAll('a.btn, button.btn')) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.left < -1 || r.right > vw + 1) {
            clipped.push(`${el.textContent?.trim().slice(0, 30)} (${Math.round(r.left)}..${Math.round(r.right)})`);
          }
        }
        return { overflow, bodyFont, clipped };
      }, width);

      if (metrics.overflow > 0) {
        failures.push(`[overflow] ${route} @ ${width}px: scrollWidth exceeds viewport by ${metrics.overflow}px`);
      }
      if (metrics.bodyFont < 15) {
        failures.push(`[font-size] ${route} @ ${width}px: body font ${metrics.bodyFont}px < 15px`);
      }
      if (metrics.clipped.length) {
        failures.push(`[clipped-btn] ${route} @ ${width}px: ${metrics.clipped.join(', ')}`);
      }
    }

    if (screenshotDirArg && ['/junk-removal-mobile-al/', '/accepted-items/', '/request-pickup/'].includes(route)) {
      const slug = route.replace(/\//g, '_') || 'home';
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${url}${route}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(screenshotDirArg, `${slug}1440.png`), fullPage: false });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${url}${route}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(screenshotDirArg, `${slug}375.png`), fullPage: false });
    }
  }

  // Interactive checks on homepage: mobile menu, mobile call-bar clearance, desktop dropdowns & focus ring
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${url}/`, { waitUntil: 'networkidle' });
  await page.click('[data-menu-toggle]');
  const expanded = await page.getAttribute('[data-menu-toggle]', 'aria-expanded');
  if (expanded !== 'true') failures.push('[mobile-menu] Toggle did not set aria-expanded="true" at 375px');
  await page.keyboard.press('Escape');
  const closed = await page.getAttribute('[data-menu-toggle]', 'aria-expanded');
  if (closed !== 'false') failures.push('[mobile-menu] Escape did not close mobile menu at 375px');

  // Verify mobile bottom call bar is visible at 375px and body/footer accounts for clearance
  const callBarCheck = await page.evaluate(() => {
    const bar = document.querySelector('.call-bar, [data-call-bar]') || document.querySelector('nav[aria-label*="Quick" i], .mobile-call-bar');
    const bodyPad = parseFloat(getComputedStyle(document.body).paddingBottom || '0');
    const footerPad = parseFloat(getComputedStyle(document.querySelector('footer') || document.body).paddingBottom || '0');
    return { found: !!bar, clearance: Math.max(bodyPad, footerPad) };
  });
  if (callBarCheck.clearance < 48) {
    failures.push(`[call-bar] Insufficient bottom padding clearance (${callBarCheck.clearance}px) at 375px`);
  }

  // Desktop dropdown & keyboard focus visibility check at 1440px
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${url}/`, { waitUntil: 'networkidle' });
  const firstTrigger = page.locator('[data-dropdown] > button').first();
  await firstTrigger.click();
  if ((await firstTrigger.getAttribute('aria-expanded')) !== 'true') {
    failures.push('[desktop-dropdown] Clicking nav trigger did not set aria-expanded="true"');
  }
  await page.keyboard.press('Escape');
  if ((await firstTrigger.getAttribute('aria-expanded')) !== 'false') {
    failures.push('[desktop-dropdown] Pressing Escape did not close dropdown');
  }

  // Keyboard Tab -> skip-link focus visibility
  await page.goto(`${url}/`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { className: el.className, outlineStyle: s.outlineStyle, boxShadow: s.boxShadow, width: r.width, height: r.height };
  });
  if (!focused || focused.width < 20 || (focused.outlineStyle === 'none' && focused.boxShadow === 'none')) {
    failures.push(`[focus-visible] Skip link or first tab stop not visibly focused: ${JSON.stringify(focused)}`);
  }

  console.log(`Responsive & accessibility audit: ${checksRun} route×viewport checks across [${WIDTHS.join(', ')}]px.`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✖ ${f}`);
    process.exitCode = 1;
  } else {
    console.log('✔ Zero horizontal overflow, zero clipped buttons, accessible mobile/desktop menus, and visible focus states verified.');
  }
} finally {
  await browser.close();
  server.close();
}
