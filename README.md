# Zoiris Junk Removal — Regional SEO Platform, 5-Step Pickup Wizard & Private Owner Command Center

Complete digital platform for **Zoiris Junk Removal** serving **Mobile, Alabama** (`251-930-8621` / `tel:+12519308621`) with structured regional expansion across **Mobile County** and **Baldwin County**, a 5-step customer pickup request wizard with private multi-photo/video uploads, and the authenticated **ZOIRIS COMMAND CENTER** with a built-in CRM.

---

## Architecture Overview

1. **Public Static Website (`src/`, `public/`, `dist/`)**
   - **Astro 6** (`output: 'static'`, `trailingSlash: 'always'`) + **TypeScript** with zero heavy frontend framework runtime on public pages.
   - Regional SEO architecture covering **2 counties** (`Mobile County`, `Baldwin County`), **42 verified municipalities & unincorporated communities** (all 14 Baldwin County municipalities, 12 Baldwin unincorporated communities, and 16 Mobile County municipalities/communities), and **20 Mobile neighborhoods & districts** with a 5-tier `GeoClassification` and 6-state owner `CoverageStatus`.
   - Strict anti-doorway & honesty gates: only `active` and `published` pages passing all quality checks enter `dist/` and `sitemap.xml`; `research-only` locations never render as indexable service pages.
   - Mobile-first **5-Step Customer Pickup Request Wizard** (`src/components/QuoteForm.astro`): Contact & Address → Multi-select Furniture / Appliances / Electronics / Other → Volume, Stairs, Access & Timing → Multi-Photo (`≤12`, `15 MB`) & Multi-Video (`≤3`, `100 MB`) with camera capture, previews, XHR progress & per-file retry → Review Summary, Consent & persisted `ZJ-2026-XXXXXX` confirmation.

2. **Private `ZOIRIS COMMAND CENTER` & Built-In CRM (`server/`, `command-center/`, `supabase/`)**
   - Separate authenticated private web application at `/owner/*` (`ZOIRIS COMMAND CENTER`), completely invisible on the public website (`Disallow: /owner/` and `Disallow: /api/` in `robots.txt`, `X-Robots-Tag: noindex, nofollow, noarchive`, strict server-side session + CSRF enforcement).
   - **Relational Backend (`server/`):** Powered out-of-the-box by Node 24's native `node:sqlite` (`DatabaseSync` in WAL mode) inside `.zoiris-private/` (outside `dist/` and `public/`), plus production cloud migrations & Edge Functions in `supabase/` (`PostgreSQL + RLS + Storage`) and S3/Cloudflare R2 private object storage adapters in `server/storage.mjs`.
   - **14 Private Owner Routes:**
     - `/owner/login/` — Password + RFC 6238 TOTP MFA + recovery codes + brute-force rate limiting
     - `/owner/command-center/` — 15 live KPIs + 9 real-data visual charts + live SSE feed
     - `/owner/leads/` & `/owner/leads/[id]/` — Searchable inbox, customer/item/access breakdown, private signed photo/video viewer, estimate/priority controls, internal communication log, follow-up tasks, and chronological lead timeline
     - `/owner/pipeline/` — 12-stage Kanban pipeline (`New` → `Completed` / `Not Converted` / `Archived` / `Spam`)
     - `/owner/customers/` — Customer directory, automatic repeat-inquiry linking, manual confirmed duplicate merge, and privacy PII redaction
     - `/owner/calendar/` — Pickup scheduling calendar in `America/Chicago`
     - `/owner/media/` — Private customer photo/video vault (OWASP magic-byte inspection, EXIF-stripped WebP previews, untouched originals, short-lived HMAC-signed HTTP `206` Range streams)
     - `/owner/analytics/` — Privacy-safe first-party traffic, click-to-call taps, form starts, upload completions, and CRM conversion attribution
     - `/owner/search-performance/` — Google Search Console API + CSV import + regional location performance rollup
     - `/owner/locations/` — Live 6-status geographic coverage manager across Mobile & Baldwin Counties
     - `/owner/seo-pages/` — Service + location/neighborhood draft generator & one-click static site rebuild
     - `/owner/reports/` — Storage/DB/egress quota monitors (`70%` / `85%` / `95%` alerts), WAL-checkpointed SQLite backups, and CSV/JSON exports
     - `/owner/settings/` & `/owner/security/` — Live upload limits, notification channels, password change, TOTP 2FA enrollment, session revocation, and `admin_audit_logs`

---

## Quick Start

- **Node.js:** `>= 22.23.4` (tested on `v24.13.0`)
- **Package manager:** `npm`

```bash
# 1. Install dependencies
npm install

# 2. Build and validate the static public website (outputs to dist/)
npm run build

# 3. Provision your private Owner account (no credentials are ever hardcoded)
npm run owner:provision -- --email owner@zoirisjunkremoval.com --name "Zoiris Owner" --password "Choose-A-Strong-12+Char-Passphrase!"

# 4. Launch the Private CRM + Unified Static Preview Server (http://127.0.0.1:4500)
npm run crm
```

Once `npm run crm` is running:
- **Public Website:** `http://127.0.0.1:4500/`
- **5-Step Pickup Request Wizard:** `http://127.0.0.1:4500/request-pickup/`
- **Private Owner Command Center:** `http://127.0.0.1:4500/owner/command-center/` (redirects to `/owner/login/` until signed in; supports simultaneous 30-day multi-device sign-in across iPhone, Android, iPad, Mac, and Windows PC with live `Logged in from <Device>` identification and per-device sign-out in `/owner/security/`)

## GitHub CI, GitHub Pages & Cloud CRM Deployment

- **Automated CI (`.github/workflows/ci.yml`):** Runs `npm run check`, `npm run build`, `npm test` (unit + Playwright headless Chrome E2E), and `npm run test:responsive` (`320px–1920px`) on every push and pull request to `main`.
- **GitHub Pages (`.github/workflows/deploy-pages.yml`):** Builds the static website, writes `.nojekyll`, rewrites subpath asset/route URLs via `scripts/prepare-github-pages.mjs` (when hosted under `/Zoiris-Junk-Removal/`), and deploys automatically to GitHub Pages.
- **Full-Stack Cloud CRM (`Dockerfile` & `render.yaml`):** Deploys the Node 24 + SQLite Private Owner Command Center and public website together with a persistent private vault disk (`ZOIRIS_DATA_DIR=/var/data/zoiris-private`).

See [docs/deployment-and-setup.md](docs/deployment-and-setup.md) for full production deployment instructions (static CDN + Node/VPS or Supabase + Cloudflare R2), backup/restore workflows, and free-tier vs. paid storage quota comparisons.

---

## Validation & Automated Test Suite

| Command | Purpose |
|---|---|
| `npm run check` | Runs `astro check` strict TypeScript diagnostics across all `.astro` and `.ts` files |
| `npm run validate:content` | Audits all 86 page records, 299 keywords, geographic coverage rules, claims, and internal links |
| `npm run duplicate-check` | Checks duplicate canonicals, titles, descriptions, H1s, primary keywords, and 5-word shingle overlap |
| `npm run validate:dist` | Audits every generated HTML file in `dist/`, JSON-LD, images, `tel:` links, `sitemap.xml`, `robots.txt`, and verifies zero private `/owner/` or `.zoiris-private/` leakage |
| `npm test` | Runs all automated unit, SEO, security, and Playwright browser E2E suites (`seo.test.mjs`, `pages.test.mjs`, `forms.test.mjs`, `crm-security.test.mjs`, `workflow-e2e.test.mjs`) |
| `npm run test:crm` | Runs CRM security, media signature/HMAC protection, MFA, and full 10-step Customer + 15-step Owner Playwright E2E workflows |
| `npm run test:responsive` | Audits representative public templates across 9 viewports (`320px–1920px`) |
| `npm run test:lighthouse` | Runs Mobile + Desktop Lighthouse audits and updates `docs/reports/lighthouse-report.md` |
| `npm run report` | Regenerates `docs/reports/site-report.md` |
| `npm run verify` | Runs `npm run check && npm run build && npm test` |
