#!/usr/bin/env node
/**
 * generate-brand-assets — builds raster brand assets from source files:
 *   public/favicon-32.png, public/apple-touch-icon.png, public/brand/zoiris-logo-512.png
 *   public/brand/og-default.jpg (1200×630 social card, rendered with headless Chrome)
 *
 * Requires Chrome or Edge locally (set CHROME_PATH to override). Run after
 * changing the logo, palette, or hero illustration:  node scripts/generate-brand-assets.mjs
 */
import sharp from 'sharp';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/load-data.mjs';

const pub = join(ROOT, 'public');
const brand = join(pub, 'brand');
mkdirSync(brand, { recursive: true });
const mark = readFileSync(join(pub, 'favicon.svg'));

await sharp(mark, { density: 600 }).resize(32, 32).png().toFile(join(pub, 'favicon-32.png'));
await sharp(mark, { density: 600 }).resize(512, 512).png().toFile(join(brand, 'zoiris-logo-512.png'));
// Apple touch icon: full-bleed navy background (iOS applies its own rounding).
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#0E1A2B' } })
  .composite([{ input: await sharp(mark, { density: 600 }).resize(180, 180).png().toBuffer() }])
  .png()
  .toFile(join(pub, 'apple-touch-icon.png'));
console.log('✔ favicons and logo PNG');

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
  console.warn('⚠ Chrome not found — skipped og-default.jpg. Set CHROME_PATH to generate it.');
  process.exit(0);
}

const { chromium } = await import('playwright-core');
// Inline assets as data URIs (file:// URLs are blocked from about:blank pages).
const heroUrl = `data:image/jpeg;base64,${(await sharp(join(ROOT, 'src/assets/illustrations/hero.jpg')).resize(1200).jpeg({ quality: 88 }).toBuffer()).toString('base64')}`;
const fontUrl = `data:font/woff2;base64,${readFileSync(join(pub, 'fonts/archivo-latin-var.woff2')).toString('base64')}`;
const markSvg = mark.toString().replace('<svg ', '<svg width="84" height="84" ');
const html = `<!doctype html><html><head><style>
@font-face{font-family:A;src:url('${fontUrl}') format('woff2');font-weight:100 900;font-stretch:62% 125%}
*{margin:0;box-sizing:border-box}body{width:1200px;height:630px;font-family:A,sans-serif;background:#0E1A2B;color:#fff;position:relative;overflow:hidden}
.bg{position:absolute;inset:0;background:url('${heroUrl}') 70% center/cover no-repeat}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,#0E1A2B 0%,rgba(14,26,43,.95) 40%,rgba(14,26,43,.45) 64%,rgba(14,26,43,0) 85%)}
.c{position:absolute;left:68px;top:56px;bottom:56px;width:660px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:18px}.n{font-weight:900;font-stretch:122%;font-size:40px;letter-spacing:.02em;line-height:1}.s{font-size:14px;font-weight:700;letter-spacing:.3em;color:#5EC4B6;margin-top:8px}
h1{margin-top:auto;font-size:58px;line-height:1.04;font-weight:800;font-stretch:104%;letter-spacing:-.02em}h1 span{color:#5EC4B6;display:block}
p{margin-top:18px;font-size:24px;color:#C8D3DF;font-weight:500}.ph{margin-top:34px;display:flex;gap:18px;align-items:center}
.pill{background:#F26B1D;color:#0B1522;font-weight:800;font-size:28px;padding:12px 26px;border-radius:999px}.loc{font-size:22px;color:#E6ECF3;font-weight:600}
</style></head><body><div class="bg"></div><div class="shade"></div>
<div class="c"><div class="brand">${markSvg}<div><div class="n">ZOIRIS</div><div class="s">JUNK REMOVAL</div></div></div>
<h1>Junk Gone. <span>Electronics Handled Responsibly.</span></h1><p>Junk removal &amp; electronics pickup for homes and businesses</p>
<div class="ph"><div class="pill">251-930-8621</div><div class="loc">Mobile, Alabama</div></div></div></body></html>`;

const browser = await chromium.launch({ executablePath, headless: true });
const pageObj = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await pageObj.setContent(html, { waitUntil: 'load' });
await pageObj.evaluate(() => document.fonts.ready);
const png = await pageObj.screenshot({ type: 'png' });
await browser.close();
await sharp(png).jpeg({ quality: 84, mozjpeg: true }).toFile(join(brand, 'og-default.jpg'));
console.log('✔ og-default.jpg');
