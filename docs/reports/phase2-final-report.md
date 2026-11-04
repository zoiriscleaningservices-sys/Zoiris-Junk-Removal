# Zoiris Junk Removal — Phase 2 Regional SEO Expansion, Private Command Center & Built-In CRM Report

**Business:** Zoiris Junk Removal  
**Primary Market:** Mobile, Alabama (`America/Chicago`)  
**Phone:** `251-930-8621` (`tel:+12519308621`)  
**Version:** `2.0.0`

---

## 1. Public Static Build & Regional Page Inventory
- **Static HTML documents emitted (`dist/`):** `50` pages (`49` indexable routes + `404.html`) plus `8` static redirect stubs (`119` total files in `dist/`).
- **Total structured page records (`src/data/pages/`):** `86` records (`49` published/indexable, `4` draft, `24` research, `9` idea, `0` archived).
- **Keywords registry (`src/data/keywords.json`):** `299` tracked keywords (`86` primary, `0` cannibalization collisions, `0` orphans).
- **Strict public/private isolation:** `dist/robots.txt` enforces `Disallow: /owner/` and `Disallow: /api/`. Zero `/owner/` links, `command-center` files, `.sqlite` files, or `.zoiris-private/` customer media exist in `dist/`.

## 2. Regional Geographic Database (`Mobile County` & `Baldwin County`)
- **Counties (`src/data/counties.json`):** `2` (`mobile-county-al`, `baldwin-county-al`).
- **Municipalities & unincorporated communities (`src/data/locations.json`):** `42` verified records (`16` in Mobile County; `26` in Baldwin County — all `14` incorporated Baldwin municipalities plus `12` unincorporated communities including Point Clear, Montrose, Belforest, Barnwell, Battles Wharf, Historic Marlow, Fish River, Perdido, Bon Secour, Lillian, Stapleton, and Stockton).
- **Mobile neighborhoods & local areas (`src/data/neighborhoods.json`):** `20` verified Mobile records classified across 5 geographic tiers (`municipality`, `official-neighborhood`, `recognized-community`, `local-area-name`, `unincorporated-area`).
- **Coverage governance (`6` states):** `Mobile, AL` (`mobile-al`) and verified in-city Mobile neighborhoods are `active`; border areas (`west-mobile`, `cottage-hill`) are `available-on-confirmation`; all unapproved Mobile & Baldwin municipalities/communities remain `research-only` and are blocked from public indexation until owner activation and local evidence (`2+` verified items) are added.

## 3. Private Owner Command Center (`/owner/*` — 14 Authenticated Routes)
1. `/owner/login/` — Owner sign-in, initial `OWNER_SETUP_SECRET` provisioning, RFC 6238 TOTP / recovery-code challenge, and password recovery.
2. `/owner/command-center/` — 15 live KPI cards, 9 SVG charts, live SSE indicator, recent inquiries, and chronological activity feed.
3. `/owner/leads/` — Searchable, filterable, sortable, paginated Leads Inbox with unread badges, e-waste pills, and media counts.
4. `/owner/leads/:id` — Full Lead Detail workspace with EXIF-stripped photo previews, HTTP 206 video player, signed downloads, pipeline stage selector, priority/estimate editor, appointment scheduler, follow-up tasks, internal communication log, JSON/CSV export, and chronological timeline.
5. `/owner/pipeline/` — 12-stage Kanban pipeline board (`New`, `Unread`, `Contacted`, `Awaiting Customer Information`, `Estimate Being Prepared`, `Estimate Sent`, `Pickup Scheduled`, `Pickup In Progress`, `Completed`, `Not Converted`, `Archived`, `Spam`).
6. `/owner/customers/` — Customer directory, repeat-inquiry linking, manual confirmed duplicate merge, and privacy PII redaction.
7. `/owner/calendar/` — `America/Chicago` monthly pickup schedule calendar and dispatch status controls.
8. `/owner/media/` — Private customer media vault with storage quota telemetry and permanent deletion.
9. `/owner/analytics/` — First-party privacy-safe traffic & conversion analytics with strict separation between sessions, `tel:` taps, and persisted CRM leads.
10. `/owner/search-performance/` — Google Search Console API + CSV snapshot importer and regional location rollup.
11. `/owner/locations/` — Live 6-state geographic coverage manager for all 42 municipalities/communities and 20 Mobile neighborhoods.
12. `/owner/seo-pages/` — 86-record SEO audit table, cannibalization-checked regional draft generator, and one-click static rebuild trigger.
13. `/owner/reports/` — Storage/DB/egress quota bars (`70%`, `85%`, `95%` alerts), WAL-checkpointed `.sqlite` backup snapshots, and bulk CSV exports.
14. `/owner/settings/` & `/owner/security/` — Editable upload limits/quotas, notification channel toggles, password rotation, TOTP 2FA enrollment + 8 recovery codes, session revocation, and `admin_audit_logs`.

## 4. Relational CRM Schema (`20` Tables)
Implemented in `server/migrations/001_initial.sql` (SQLite WAL) and mirrored in `supabase/migrations/20261104000001_zoiris_command_center.sql` (PostgreSQL + strict `DENY ALL` public RLS):
`owner_users`, `owner_sessions`, `auth_rate_limits`, `password_reset_tokens`, `customers`, `lead_seq`, `leads`, `lead_items`, `file_upload_sessions`, `lead_attachments`, `lead_notes`, `lead_status_history`, `lead_events`, `appointments`, `follow_up_tasks`, `notifications`, `notification_preferences`, `web_events`, `analytics_snapshots`, `counties`, `municipalities`, `neighborhoods`, `service_areas`, `page_registry`, `business_settings`, `integrations`, `admin_audit_logs`.

## 5. Verification Summary
- **`npm run check`:** `0 errors, 0 warnings, 0 hints` (`52` files).
- **`npm run build` (`validate:content` + `astro build` + `validate:dist`):** `50` HTML pages (`49` indexable), `100/100` editorial score, `0` errors, `0` warnings.
- **`npm test`:** `23/23` tests passing across `6` suites (`crm-security`, `forms`, `pages`, `admin`, `seo`, `workflow-e2e`).
- **`npm run test:responsive`:** `72/72` route × viewport checks (`320px–1920px`) passed with `0` horizontal overflow and `0` clipped controls.
- **`npm run test:lighthouse`:** `14/14` Mobile + Desktop audits passed (`100/100` Accessibility and `100/100` SEO across all 14 runs; `98–100` Mobile Performance; `93–100` Desktop Performance; `0` CLS everywhere).
