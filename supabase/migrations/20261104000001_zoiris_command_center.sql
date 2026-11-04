-- ============================================================================
-- Zoiris Junk Removal — Phase 2 Database Schema & Row Level Security (PostgreSQL / Supabase)
-- Migration: 20261104000001_zoiris_command_center.sql
--
-- Entities (24 tables):
--   owner_profiles, owner_sessions, admin_audit_logs, business_settings,
--   notification_preferences, notifications, integrations,
--   customers, leads, lead_items, file_upload_sessions, lead_attachments,
--   lead_notes, lead_events, lead_status_history, appointments, follow_up_tasks,
--   counties, municipalities, neighborhoods, service_areas,
--   page_registry, keyword_records, analytics_snapshots, web_events
-- ============================================================================

create extension if not exists pgcrypto;

-- Sequence for human-readable lead numbers: ZJ-2026-000001
create sequence if not exists public.zoiris_lead_seq start 1 increment 1;

create or replace function public.next_zoiris_lead_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  seq_val bigint;
  yr text;
begin
  seq_val := nextval('public.zoiris_lead_seq');
  yr := to_char(now() at time zone 'America/Chicago', 'YYYY');
  return 'ZJ-' || yr || '-' || lpad(seq_val::text, 6, '0');
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 1. Owner profiles (maps to auth.users in Supabase Auth; no public registration)
create table if not exists public.owner_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email text not null unique,
  display_name text not null,
  role text not null default 'owner' check (role in ('owner', 'admin', 'staff')),
  password_hash text,
  mfa_enabled boolean not null default false,
  mfa_secret_enc text,
  recovery_codes_json jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

--Helper function used by RLS policies to verify active owner/staff role
create or replace function public.is_authorized_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.owner_profiles op
    where op.auth_user_id = auth.uid()
      and op.is_active = true
      and op.role in ('owner', 'admin', 'staff')
  );
$$;

-- 2. Admin audit logs
create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.owner_profiles(id) on delete set null,
  actor_email text,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);

-- 3. Business settings (upload limits, storage quotas, timezone)
create table if not exists public.business_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.owner_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- 4. Notification preferences
create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.owner_profiles(id) on delete cascade,
  dashboard_enabled boolean not null default true,
  sound_enabled boolean not null default false,
  desktop_enabled boolean not null default false,
  email_enabled boolean not null default false,
  email_address text,
  sms_enabled boolean not null default false,
  sms_phone text,
  notify_on_new_lead boolean not null default true,
  notify_on_upload boolean not null default true,
  notify_on_appointment boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 5. Notifications (in-app & outbound delivery log with retry state)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid,
  channel text not null check (channel in ('dashboard', 'email', 'sms')),
  kind text not null,
  title text not null,
  body text not null,
  delivery_status text not null default 'recorded' check (delivery_status in ('recorded', 'queued', 'sent', 'failed', 'skipped_unconfigured')),
  provider_response text,
  retry_count integer not null default 0,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- 6. External integrations status (GA4, GSC, Email, SMS, Storage)
create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'unconfigured' check (status in ('connected', 'unconfigured', 'error')),
  config_public jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

-- 7. Customers
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  full_name text not null,
  phone_e164 text not null,
  phone_display text not null,
  email text,
  street_address text,
  city text,
  state text default 'AL',
  zip_code text,
  customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial')),
  preferred_contact text default 'phone' check (preferred_contact in ('phone', 'sms', 'email')),
  notes text not null default '',
  merged_into_id uuid references public.customers(id) on delete set null,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 8. Leads
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  lead_number text not null unique default public.next_zoiris_lead_number(),
  idempotency_key text unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'new' check (status in (
    'new', 'unread', 'contacted', 'awaiting_customer_info',
    'estimate_preparing', 'estimate_sent', 'pickup_scheduled',
    'pickup_in_progress', 'completed', 'not_converted', 'archived', 'spam'
  )),
  is_unread boolean not null default true,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  customer_first_name text not null,
  customer_last_name text not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  preferred_contact text not null default 'phone',
  customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial')),
  pickup_address text not null,
  city text not null,
  state text not null default 'AL',
  zip_code text not null,
  location_id text,
  requested_service text not null,
  has_ewaste boolean not null default false,
  item_categories jsonb not null default '[]'::jsonb,
  item_description text not null default '',
  estimated_quantity text,
  estimated_dimensions text,
  indoor_outdoor text,
  floor_level text,
  stairs_info text,
  elevator_available text,
  is_disassembled text,
  access_instructions text,
  preferred_date text,
  preferred_window text,
  customer_notes text,
  consent_given boolean not null default false,
  estimate_cents integer,
  scheduled_date text,
  follow_up_date text,
  job_completed_at timestamptz,
  source_url text,
  source_page_id text,
  service_page_slug text,
  location_page_slug text,
  referrer_url text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  device_category text check (device_category in ('mobile', 'tablet', 'desktop', 'unknown')),
  photo_count integer not null default 0,
  video_count integer not null default 0,
  pending_uploads integer not null default 0,
  opened_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 9. Lead items
create table if not exists public.lead_items (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  category text not null,
  item_label text not null,
  is_ewaste boolean not null default false,
  requires_confirmation boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- 10. File upload sessions (short-lived authorization for customer media upload)
create table if not exists public.file_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  session_token_hash text not null unique,
  max_photos integer not null default 12,
  max_videos integer not null default 3,
  max_photo_bytes bigint not null default 15728640,
  max_video_bytes bigint not null default 104857600,
  uploaded_photos integer not null default 0,
  uploaded_videos integer not null default 0,
  status text not null default 'active' check (status in ('active', 'completed', 'expired', 'revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- 11. Lead attachments (private customer photos & videos)
create table if not exists public.lead_attachments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete restrict,
  upload_session_id uuid references public.file_upload_sessions(id) on delete set null,
  media_kind text not null check (media_kind in ('photo', 'video')),
  storage_provider text not null default 'supabase' check (storage_provider in ('local', 'supabase', 'r2')),
  storage_bucket text not null default 'customer-media',
  storage_key text not null unique,
  preview_key text,
  original_filename text not null,
  safe_filename text not null,
  validated_mime text not null,
  byte_size bigint not null check (byte_size > 0),
  sha256_hex text not null,
  width integer,
  height integer,
  processing_status text not null default 'ready' check (processing_status in ('pending', 'ready', 'failed')),
  deletion_status text not null default 'active' check (deletion_status in ('active', 'deleted')),
  deleted_at timestamptz,
  deleted_by uuid references public.owner_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 12. Lead notes & communication logs
create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  author_id uuid references public.owner_profiles(id) on delete set null,
  author_name text not null,
  interaction_type text not null default 'internal_note' check (interaction_type in (
    'internal_note', 'phone_call', 'sms_log', 'email_log', 'estimate_note'
  )),
  body text not null,
  created_at timestamptz not null default now()
);

-- 13. Lead timeline events
create table if not exists public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  event_type text not null,
  actor_name text not null,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 14. Lead status history
create table if not exists public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by uuid references public.owner_profiles(id) on delete set null,
  changed_by_name text not null,
  note text,
  created_at timestamptz not null default now()
);

-- 15. Pickup appointments (America/Chicago business timezone)
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  scheduled_date date not null,
  time_window text not null,
  timezone text not null default 'America/Chicago',
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  pickup_address text not null,
  city text not null,
  zip_code text not null,
  instructions text not null default '',
  created_by uuid references public.owner_profiles(id) on delete set null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 16. Follow-up tasks
create table if not exists public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  title text not null,
  due_date date not null,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  notes text not null default '',
  created_by uuid references public.owner_profiles(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 17. Counties
create table if not exists public.counties (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  state text not null default 'AL',
  county_seat text,
  coverage_status text not null default 'research-only' check (coverage_status in (
    'active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'
  )),
  geo_reference text,
  disposal_context text,
  source_url text,
  verified_at date,
  page_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 18. Municipalities & unincorporated communities
create table if not exists public.municipalities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  state text not null default 'AL',
  county_slug text not null references public.counties(slug) on delete restrict,
  classification text not null check (classification in (
    'incorporated-municipality', 'official-neighborhood', 'recognized-community', 'local-area-name', 'unincorporated-area'
  )),
  parent_area_slug text,
  zip_codes jsonb not null default '[]'::jsonb,
  geo_reference text,
  pickup_notes text,
  coverage_status text not null default 'research-only' check (coverage_status in (
    'active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'
  )),
  source_url text,
  verified_at date,
  page_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 19. Neighborhoods & districts
create table if not exists public.neighborhoods (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  municipality_slug text not null references public.municipalities(slug) on delete cascade,
  county_slug text not null references public.counties(slug) on delete restrict,
  classification text not null check (classification in (
    'incorporated-municipality', 'official-neighborhood', 'recognized-community', 'local-area-name', 'unincorporated-area'
  )),
  zip_codes jsonb not null default '[]'::jsonb,
  geo_reference text,
  pickup_notes text,
  local_evidence jsonb not null default '[]'::jsonb,
  coverage_status text not null default 'research-only' check (coverage_status in (
    'active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'
  )),
  source_url text,
  verified_at date,
  page_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 20. Service areas (coverage overrides & service availability matrix per area)
create table if not exists public.service_areas (
  id uuid primary key default gen_random_uuid(),
  area_kind text not null check (area_kind in ('county', 'municipality', 'neighborhood')),
  area_slug text not null unique,
  display_name text not null,
  county_slug text not null,
  coverage_status text not null default 'research-only' check (coverage_status in (
    'active', 'available-on-confirmation', 'limited', 'temporarily-unavailable', 'not-serviced', 'research-only'
  )),
  enabled_services jsonb not null default '[]'::jsonb,
  owner_notes text not null default '',
  updated_by uuid references public.owner_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- 21. Page registry mirror
create table if not exists public.page_registry (
  id uuid primary key default gen_random_uuid(),
  page_id text not null unique,
  canonical_path text not null unique,
  page_type text not null,
  status text not null,
  title text not null,
  primary_keyword text not null,
  location_slug text,
  neighborhood_slug text,
  service_slug text,
  quality_score integer not null default 0,
  passes_gate boolean not null default false,
  is_indexable boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 22. Keyword records & Search Console performance
create table if not exists public.keyword_records (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  role text not null check (role in ('primary', 'secondary')),
  intent text not null,
  target_page_id text,
  location_slug text,
  impressions integer,
  clicks integer,
  ctr numeric(6,3),
  avg_position numeric(6,2),
  source_label text,
  measured_period text,
  updated_at timestamptz not null default now()
);

-- 23. Aggregated analytics & Search Console snapshots
create table if not exists public.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  source text not null check (source in ('first_party', 'ga4', 'gsc')),
  dimension_kind text not null,
  dimension_key text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 24. Privacy-safe first-party web events (no raw IPs, no keystrokes, no fingerprinting)
create table if not exists public.web_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'page_view', 'form_start', 'form_step', 'upload_complete', 'form_complete', 'click_to_call', 'cta_click'
  )),
  session_bucket text not null,
  pathname text not null,
  location_slug text,
  service_slug text,
  referrer_host text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  device_category text not null default 'unknown' check (device_category in ('mobile', 'tablet', 'desktop', 'unknown')),
  created_at timestamptz not null default now()
);

-- Indexes for fast CRM search, pagination, calendar & analytics queries
create index if not exists idx_leads_status_created on public.leads(status, created_at desc);
create index if not exists idx_leads_unread on public.leads(is_unread) where is_unread = true;
create index if not exists idx_leads_city_zip on public.leads(city, zip_code);
create index if not exists idx_leads_customer on public.leads(customer_id);
create index if not exists idx_leads_number on public.leads(lead_number);
create index if not exists idx_customers_phone on public.customers(phone_e164);
create index if not exists idx_customers_email on public.customers(lower(email));
create index if not exists idx_attachments_lead on public.lead_attachments(lead_id) where deletion_status = 'active';
create index if not exists idx_appointments_date on public.appointments(scheduled_date, status);
create index if not exists idx_events_created_type on public.web_events(created_at desc, event_type);
create index if not exists idx_events_pathname on public.web_events(pathname, event_type);

-- Private Supabase Storage bucket for customer media (never public)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-media',
  'customer-media',
  false,
  104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']
)
on conflict (id) do update
set public = false;

-- ============================================================================
-- Row Level Security (RLS) — Deny all public/anon access; owner-only policies
-- ============================================================================
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'owner_profiles', 'admin_audit_logs', 'business_settings',
    'notification_preferences', 'notifications', 'integrations',
    'customers', 'leads', 'lead_items', 'file_upload_sessions',
    'lead_attachments', 'lead_notes', 'lead_events', 'lead_status_history',
    'appointments', 'follow_up_tasks', 'counties', 'municipalities',
    'neighborhoods', 'service_areas', 'page_registry', 'keyword_records',
    'analytics_snapshots', 'web_events'
  ] loop
    execute format('alter table public.%I enable row level security;', tbl);
    execute format('alter table public.%I force row level security;', tbl);
    execute format('drop policy if exists owner_full_access on public.%I;', tbl);
    execute format(
      'create policy owner_full_access on public.%I for all to authenticated using (public.is_authorized_owner()) with check (public.is_authorized_owner());',
      tbl
    );
  end loop;
end $$;

-- Storage RLS: Only authenticated owners can read/delete objects in private customer-media bucket.
-- Public customer uploads go exclusively through server-validated Edge Functions using short-lived signed upload URLs.
drop policy if exists owner_media_select on storage.objects;
create policy owner_media_select on storage.objects
  for select to authenticated
  using (bucket_id = 'customer-media' and public.is_authorized_owner());

drop policy if exists owner_media_delete on storage.objects;
create policy owner_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'customer-media' and public.is_authorized_owner());

-- Realtime publication: only broadcast to authenticated owner channel subscribers
alter publication supabase_realtime add table public.leads, public.lead_attachments, public.notifications, public.appointments;
