# Zoiris Junk Removal — Deployment, Security & Operations Guide

This guide covers deploying and operating both components of the Zoiris Junk Removal platform:
1. **Public Static Website (`dist/`)** — Fast, static HTML/CSS/AVIF pages for Google indexing and customer conversion.
2. **Private `ZOIRIS COMMAND CENTER` & Built-In CRM (`server/` + `command-center/` or `supabase/`)** — Authenticated owner workspace, customer pickup intake API, private photo/video vault, real-time notifications, and analytics.

---

## 1. Deployment Topologies

### Option A: Static CDN + Self-Hosted / VPS Node 24 Server (Zero Monthly SaaS Fees)
1. **Public Website (`dist/`):** Deploy `dist/` to **Cloudflare Pages**, **Netlify**, or **GitHub Pages** with:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Build environment variable: `PUBLIC_API_BASE=https://crm.zoirisjunkremoval.com` (and `SITE_URL=https://zoirisjunkremoval.com`)
2. **Private Command Center (`crm.zoirisjunkremoval.com`):** Run `node server/index.mjs` (`npm run crm`) behind Caddy or Nginx with automatic TLS on a small Linux VPS or private host:
   - Set `SERVE_PUBLIC_DIST=0` if the server only serves `/owner/*` and `/api/*`, or leave default (`1`) if serving both the static website and `/owner/*` from a single domain (`zoirisjunkremoval.com`).
   - Mount `.zoiris-private/` (`ZOIRIS_DATA_DIR`) on persistent encrypted disk storage outside any public web root.
   - Optionally set `STORAGE_PROVIDER=r2` to offload customer photos and walkthrough videos to a private **Cloudflare R2** bucket (`10 GB/month` free, **$0 egress fees**).

### Option B: Static CDN + Supabase Cloud (PostgreSQL + RLS + Edge Functions)
1. Apply the production PostgreSQL schema and Row-Level Security policies in `supabase/migrations/20261104000001_zoiris_command_center.sql`.
2. Deploy the write-only public Edge Functions in `supabase/functions/submit-inquiry/index.ts` and `supabase/functions/upload-media/index.ts`.
3. Configure `STORAGE_PROVIDER=supabase` (or `r2`), `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`.

---

## 2. Provisioning Owner Access & Two-Factor Authentication

No default usernames or passwords exist anywhere in the codebase.

### Provision via CLI (Recommended)
```bash
npm run owner:provision -- \
  --email owner@zoirisjunkremoval.com \
  --name "Zoiris Owner" \
  --password "Replace-With-Strong-12+Char-Passphrase"
```

### Provision via First-Run Browser Setup
If CLI access is unavailable during initial deployment:
1. Set `OWNER_SETUP_SECRET` (minimum 16 random characters) in the server environment.
2. Visit `https://<your-host>/owner/login/` and complete the one-time Initial Owner Setup form using `OWNER_SETUP_SECRET`.
3. Once the first owner exists, `/api/auth/setup` permanently locks itself (`403 Forbidden`) and `OWNER_SETUP_SECRET` can be removed.

### Enabling Authenticator MFA (RFC 6238 TOTP)
1. Sign in at `/owner/login/` and open **Security & Audit** (`/owner/security/`).
2. Click **Begin Two-Factor Setup**, add the secret key or `otpauth://` URI to Google Authenticator, 1Password, or Authy, and enter the 6-digit code.
3. Store the **8 one-time recovery codes** in a password manager.

### Emergency Password Recovery
- **With Email Provider Configured:** Click **Account Recovery** on `/owner/login/` to email a single-use 15-minute recovery token to the registered owner address (tokens are never returned in HTTP responses).
- **Via Server CLI:**
  ```bash
  npm run owner:provision -- --recover owner@zoirisjunkremoval.com
  ```

---

## 3. Private Customer Media Security Architecture

Customer photos and walkthrough videos often depict home interiors, garages, license plates, or office equipment. Every upload is protected by six layers:
1. **Write-Only Scoped Upload Tokens:** Submitting `/api/public/inquiries` mints a short-lived (`45 min`) SHA-256 hashed `file_upload_sessions` token scoped strictly to that single `lead_id`. Upload tokens cannot read any lead, customer, or attachment.
2. **OWASP Binary Signature Verification (`server/storage.mjs`):** Files are inspected by raw magic bytes (`JPEG`, `PNG`, `WebP`, `HEIC`, `MP4`, `MOV`, `WebM`). Executables and scripts (`MZ`, `ELF`, `PK`, `<!doctype`, `<html`, `<script`, `<svg`, `<?php`) disguised with image extensions are rejected with `415 Unsupported Media Type`.
3. **Private Vault Isolation:** Files are stored under random UUID keys (`YYYY/MM/<leadId>/<uuid>.<ext>`) inside `.zoiris-private/media/` (or private Supabase / R2 buckets) — never inside `public/` or `dist/`.
4. **EXIF-Stripped Previews + Original Evidence Preservation:** Photos automatically generate an EXIF-stripped `480px` WebP preview via `sharp` for fast dashboard browsing while preserving the untouched original file for zoom/download (`preserve_original_uploads = true`).
5. **Short-Lived HMAC-Signed Streaming (`5 min` TTL):** Owners view photos and stream videos (`HTTP 206 Partial Content` byte-range support) via `/api/media/stream/:id?kind=...&disposition=...&exp=...&sig=...`. Expired or tampered URLs return `403 Forbidden`.
6. **Hard Quota Safeguard:** If media storage reaches `100%` of the configured quota, customer text lead details are **always saved** first while media uploads return `507 Insufficient Storage` with an immediate owner alert and `251-930-8621` fallback.

---

## 4. Free-Tier Capacity & Upgrade Transparency

| Component | Free / Built-In Tier Limit | Warning Thresholds | Upgrade Path When Volume Grows |
|---|---|---|---|
| **Public Static Hosting** (Cloudflare Pages) | Unlimited static requests & bandwidth; 500 builds/month | N/A | Cloudflare Pages Pro ($20/mo) only if >500 builds/mo |
| **Local / VPS SQLite WAL CRM** (`node:sqlite`) | Limited only by disk; default monitor set to `500 MB` DB + `1 GB` Media | `70%`, `85%`, `95%` in `/owner/reports/` | Increase disk / adjust quota in `/owner/settings/` |
| **Supabase Free Plan** (Optional Cloud DB/Storage) | `500 MB` Postgres DB, `1 GB` Private Storage, `5 GB/mo` Egress, pauses after 7 days total inactivity | `70%` (`700 MB`), `85%` (`850 MB`), `95%` (`950 MB`) | Supabase Pro (`$25/mo`: `8 GB` DB, `100 GB` Storage, `250 GB` Egress, no pausing) |
| **Cloudflare R2** (Optional Cloud Media Vault) | **`10 GB/month` storage + $0 egress fees** | Configurable in `/owner/settings/` | `$0.015 / GB-month` above 10 GB ($0 egress) |
| **Resend Email Alerts** (Optional) | `100 emails/day` (`3,000/mo`) free | Logged in `notifications` table | Resend Pro (`$20/mo` for `50,000/mo`) |

---

## 5. Backups, Exports & Restore Procedure

- **One-Click Dashboard Backup:** Open `/owner/reports/` and click **Create SQLite Backup Now**. The server runs `PRAGMA wal_checkpoint(TRUNCATE)` and writes a consistent `.sqlite` snapshot into `.zoiris-private/backups/` ready for authenticated download.
- **CSV & JSON Exports:** Export all leads (`/api/owner/exports/leads.csv`), single lead JSON/CSV (`/api/owner/leads/:id/export?format=json|csv`), or page analytics CSV (`/api/owner/exports/analytics.csv`).
- **Restoring a Backup:**
  1. Stop the CRM server (`server/index.mjs`).
  2. Copy your snapshot file to `.zoiris-private/db/zoiris-crm.sqlite` (and remove any stale `-wal` / `-shm` files).
  3. Restart `npm run crm`.

---

## 6. Activating Regional Locations Safely

1. Open `/owner/locations/` to review all **42** Mobile & Baldwin County municipalities/communities and **20** Mobile neighborhoods.
2. Only switch a location from `research-only` to `active` when Zoiris Junk Removal is operationally ready to dispatch trucks there.
3. Open `/owner/seo-pages/` to generate a non-indexable `draft` service-location record (e.g., `/areas/daphne-al/junk-removal/`).
4. Add genuine local pickup notes, verify all quality gate checks pass (`0` cannibalization, `0` unverified claims), mark `published`, and click **Rebuild Public Static Website** (or trigger CI deployment).


## 7. Real-Address Verification & Anti-Scam Protection

The public Pickup Request form only lets genuine, in-area requests reach the Command Center.

| Layer | What it does | Source / cost |
|---|---|---|
| Address suggestions | As customers type, shows real addresses in Mobile & Baldwin counties; "Use my current location" finds the nearest house address | OpenStreetMap data via the Photon geocoder (free, no key) |
| Address verification | Confirms the house number sits in a real address range on a real street, returns the official county + map coordinates, and corrects the ZIP | U.S. Census Bureau Geocoder (free, official, no key) |
| Service-area check | Rejects addresses outside Mobile County (FIPS 01097) and Baldwin County (01003) with a friendly "please call" message | Census county result |
| Signed address token | A verified address is returned with a 2-hour HMAC token; the server trusts only untampered tokens and re-verifies anything else | `server/geo.mjs` |
| Phone screening | Rejects fictional (555-01xx), impossible (0/1 area codes or exchanges), repeated or sequential numbers | `server/spam-guard.mjs` |
| Email screening (optional field) | Rejects throwaway inboxes (Mailinator, 10-minute mail, …) and domains that cannot receive mail (DNS MX check) | `server/spam-guard.mjs` |
| Spam / bot screening | Scores links, SEO/marketing/crypto wording, names with URLs, and forms finished in under 5 seconds. Score ≥ 70 is blocked; 35–69 is saved but marked **Needs review** | `server/spam-guard.mjs` |
| Existing guards | Honeypot field, per-IP rate limits, idempotency keys | `server/crm.mjs`, `server/index.mjs` |

**Honest limits:** the Census check proves the address exists on a real street (and gives its location); it cannot prove the person lives there. If the free address services are temporarily unreachable, the request is still saved (no lost customers) and marked **Address not auto-verified** so you can confirm by phone. The owner Command Center shows each request's pin on a street map and USGS aerial photo, plus one-tap Google Street View and Directions links (no API key needed).

**Upgrades if you ever need them:** USPS Addresses API (deliverability check, free account required), SMS one-time codes via Twilio (verifies the phone belongs to the customer), or Cloudflare Turnstile (invisible bot challenge).

For automated tests set `ZOIRIS_GEOCODER=mock` to use the offline fixture instead of calling the Census/OpenStreetMap services.
