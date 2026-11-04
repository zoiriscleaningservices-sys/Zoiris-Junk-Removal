#!/usr/bin/env node
/**
 * tests/lighthouse/run-lighthouse.mjs
 * Runs real Lighthouse Mobile & Desktop audits in headless Chrome against the built
 * static site in dist/ across 6 representative routes and writes docs/reports/lighthouse-report.md.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import lighthouse from 'lighthouse';
import { DIST_DIR, ROOT } from '../../scripts/lib/load-data.mjs';

const ROUTES = [
  '/',
  '/junk-removal-mobile-al/',
  '/e-waste/',
  '/items/refrigerator-removal/',
  '/areas/mobile-al/',
  '/guides/prepare-computer-for-recycling/',
  '/request-pickup/'
];

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const chromePath = CHROME_PATHS.find((p) => existsSync(p));
if (!chromePath) {
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
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
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
      const ext = extname(file);
      const cache = url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/fonts/')
        ? 'public, max-age=31536000, immutable'
        : ext === '.html'
          ? 'public, max-age=0, must-revalidate'
          : 'public, max-age=604800';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function launchDebugChrome(port, profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const proc = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions'
    ],
    { stdio: 'ignore' }
  );
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(endpoint);
      if (r.ok) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('Failed to connect to headless Chrome remote debugging port.');
}

const debugPort = 9333;
const profileDir = join(ROOT, 'tests', 'lighthouse', '.tmp', `chrome-${Date.now()}`);
const { server, url } = await startServer(DIST_DIR);
const chromeProc = await launchDebugChrome(debugPort, profileDir);
const results = [];

try {
  for (const preset of ['mobile', 'desktop']) {
    for (const route of ROUTES) {
      const targetUrl = `${url}${route}`;
      const config = {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
          formFactor: preset,
          ...(preset === 'desktop'
            ? {
                throttling: {
                  rttMs: 40,
                  throughputKbps: 10240,
                  cpuSlowdownMultiplier: 1,
                  requestLatencyMs: 0,
                  downloadThroughputKbps: 0,
                  uploadThroughputKbps: 0
                },
                screenEmulation: {
                  mobile: false,
                  width: 1350,
                  height: 940,
                  deviceScaleFactor: 1,
                  disabled: false
                }
              }
            : {})
        }
      };

      const runnerResult = await lighthouse(targetUrl, { port: debugPort, logLevel: 'error', output: 'json' }, config);
      const lhr = runnerResult.lhr;
      const score = (k) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
      const lcpMs = Math.round(lhr.audits['largest-contentful-paint']?.numericValue ?? 0);
      const cls = Number((lhr.audits['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3));
      const tbtMs = Math.round(lhr.audits['total-blocking-time']?.numericValue ?? 0);
      const fcpMs = Math.round(lhr.audits['first-contentful-paint']?.numericValue ?? 0);

      // Collect non-passing accessibility/SEO/performance audits for inspection
      const warnings = [];
      for (const cat of ['accessibility', 'seo', 'best-practices', 'performance']) {
        for (const ref of lhr.categories[cat]?.auditRefs ?? []) {
          const a = lhr.audits[ref.id];
          if (a && a.score !== null && a.score < 0.9 && (ref.weight > 0 || cat !== 'performance')) {
            warnings.push(`[${cat}:${ref.id}] ${a.title} (${a.displayValue || a.score})`);
          }
        }
      }

      const row = { route, preset, perf: score('performance'), a11y: score('accessibility'), bp: score('best-practices'), seo: score('seo'), lcpMs, cls, tbtMs, fcpMs, warnings };
      results.push(row);
      console.log(`  [${preset.padEnd(7)}] ${route.padEnd(40)} Perf ${row.perf} | A11y ${row.a11y} | BP ${row.bp} | SEO ${row.seo} | LCP ${(lcpMs / 1000).toFixed(2)}s | CLS ${cls} | TBT ${tbtMs}ms`);
      for (const w of warnings) console.log(`      ⚠ ${w}`);
    }
  }

  mkdirSync(join(ROOT, 'docs', 'reports'), { recursive: true });
  const md = [
    '# Zoiris Junk Removal — Lighthouse Performance & Accessibility Report',
    '',
    `Generated ${new Date().toISOString()} against production \`dist/\` build via headless Chrome + Lighthouse.`,
    '',
    '| Mode | Route | Perf | A11y | Best Practices | SEO | LCP | CLS | TBT | FCP |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(
      (r) =>
        `| ${r.preset} | \`${r.route}\` | **${r.perf}** | **${r.a11y}** | **${r.bp}** | **${r.seo}** | ${(r.lcpMs / 1000).toFixed(2)}s | ${r.cls} | ${r.tbtMs}ms | ${(r.fcpMs / 1000).toFixed(2)}s |`
    ),
    ''
  ];
  const allWarnings = results.flatMap((r) => r.warnings.map((w) => `- \`${r.preset} ${r.route}\`: ${w}`));
  if (allWarnings.length) {
    md.push('## Flagged Audits Investigated', '', ...allWarnings, '');
  } else {
    md.push('## Flagged Audits', '', 'None — all weighted audits scored ≥ 90%.', '');
  }
  writeFileSync(join(ROOT, 'docs', 'reports', 'lighthouse-report.md'), md.join('\n'));
  writeFileSync(join(ROOT, 'tests', 'lighthouse', 'latest-summary.json'), JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.perf < 90 || r.a11y < 95 || r.bp < 95 || r.seo < 95 || r.cls > 0.1 || r.lcpMs > 2500);
  if (failed.length) {
    console.error(`\n✖ ${failed.length} audit(s) missed strict thresholds.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✔ All ${results.length} Mobile + Desktop Lighthouse audits passed strict CWV & quality thresholds.`);
  }
} finally {
  chromeProc.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 400));
  try {
    rmSync(join(ROOT, 'tests', 'lighthouse', '.tmp'), { recursive: true, force: true });
  } catch {}
}
