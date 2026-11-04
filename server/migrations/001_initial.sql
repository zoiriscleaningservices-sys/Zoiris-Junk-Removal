-- ============================================================================
-- Zoiris Command Center — Local / Self-Hosted Relational Schema (SQLite / WAL)
-- Mirrors supabase/migrations/20261104000001_zoiris_command_center.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS owner_profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'staff')),
  password_hash TEXT NOT NULL,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc TEXT,
  mfa_pending_secret_enc TEXT,
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_agent TEXT,
  ip_hint TEXT,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_token ON owner_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id);

CREATE TABLE IF NOT EXISTS owner_recovery_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  ip_bucket TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(identifier, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_bucket, attempted_at);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON admin_audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS business_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  owner_id TEXT PRIMARY KEY REFERENCES owner_profiles(id) ON DELETE CASCADE,
  in_app_enabled INTEGER NOT NULL DEFAULT 1,
  sound_enabled INTEGER NOT NULL DEFAULT 0,
  desktop_enabled INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  email_address TEXT,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  sms_phone TEXT,
  notify_new_lead INTEGER NOT NULL DEFAULT 1,
  notify_new_upload INTEGER NOT NULL DEFAULT 1,
  notify_storage_alert INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES owner_profiles(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'sms')),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'skipped_unconfigured', 'read', 'unread')),
  provider_message_id TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, channel);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'unconfigured', 'error', 'disabled')),
  config_summary_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  phone_display TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  primary_address TEXT,
  city TEXT,
  state TEXT DEFAULT 'AL',
  zip_code TEXT,
  customer_type TEXT NOT NULL DEFAULT 'residential' CHECK (customer_type IN ('residential', 'commercial')),
  preferred_contact TEXT DEFAULT 'phone',
  notes TEXT DEFAULT '',
  merged_into_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  total_inquiries INTEGER NOT NULL DEFAULT 0,
  completed_pickups INTEGER NOT NULL DEFAULT 0,
  last_contact_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_merged ON customers(merged_into_id);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  lead_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  assigned_owner_id TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN (
    'New',
    'Unread',
    'Contacted',
    'Awaiting Customer Information',
    'Estimate Being Prepared',
    'Estimate Sent',
    'Pickup Scheduled',
    'Pickup In Progress',
    'Completed',
    'Not Converted',
    'Archived',
    'Spam'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  is_unread INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  email TEXT,
  preferred_contact TEXT DEFAULT 'phone',
  customer_type TEXT NOT NULL DEFAULT 'residential' CHECK (customer_type IN ('residential', 'commercial')),
  pickup_address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'AL',
  zip_code TEXT NOT NULL,
  county_slug TEXT,
  location_slug TEXT,
  neighborhood_slug TEXT,
  requested_service TEXT NOT NULL,
  item_categories_json TEXT NOT NULL DEFAULT '[]',
  has_electronics INTEGER NOT NULL DEFAULT 0,
  item_description TEXT NOT NULL DEFAULT '',
  other_item_description TEXT DEFAULT '',
  estimated_quantity TEXT DEFAULT '',
  estimated_dimensions TEXT DEFAULT '',
  indoors_or_outdoors TEXT DEFAULT '',
  floor_level TEXT DEFAULT '',
  has_stairs TEXT DEFAULT '',
  elevator_available TEXT DEFAULT '',
  disassembled_status TEXT DEFAULT '',
  access_instructions TEXT DEFAULT '',
  preferred_date TEXT,
  preferred_window TEXT DEFAULT '',
  customer_notes TEXT DEFAULT '',
  consent_given INTEGER NOT NULL DEFAULT 0,
  estimate_cents INTEGER,
  estimate_notes TEXT DEFAULT '',
  follow_up_at TEXT,
  scheduled_pickup_at TEXT,
  completed_at TEXT,
  completion_status TEXT DEFAULT 'pending',
  photo_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  pending_upload_count INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'website_form',
  source_url TEXT DEFAULT '',
  source_page_path TEXT DEFAULT '',
  service_page_slug TEXT DEFAULT '',
  location_page_slug TEXT DEFAULT '',
  referrer_url TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  device_category TEXT DEFAULT 'unknown' CHECK (device_category IN ('mobile', 'tablet', 'desktop', 'unknown')),
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_unread ON leads(is_unread);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_city ON leads(city COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip_code);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_leads_service ON leads(requested_service);

CREATE TABLE IF NOT EXISTS lead_items (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  item_name TEXT NOT NULL,
  is_electronics INTEGER NOT NULL DEFAULT 0,
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  quantity_note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_items_lead ON lead_items(lead_id);

CREATE TABLE IF NOT EXISTS file_upload_sessions (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expected_files INTEGER NOT NULL DEFAULT 0,
  uploaded_photos INTEGER NOT NULL DEFAULT 0,
  uploaded_videos INTEGER NOT NULL DEFAULT 0,
  failed_uploads INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_token ON file_upload_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON file_upload_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS lead_attachments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  upload_session_id TEXT REFERENCES file_upload_sessions(id) ON DELETE SET NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('photo', 'video')),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_bucket TEXT NOT NULL DEFAULT 'customer-media',
  storage_key TEXT NOT NULL UNIQUE,
  preview_key TEXT,
  original_filename TEXT NOT NULL,
  safe_filename TEXT NOT NULL,
  validated_mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256_hex TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  processing_status TEXT NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('pending', 'processing', 'ready', 'failed')),
  deletion_status TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active', 'deleted')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_lead ON lead_attachments(lead_id, deletion_status);

CREATE TABLE IF NOT EXISTS lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'internal_note' CHECK (note_type IN (
    'internal_note',
    'phone_call',
    'text_interaction',
    'email_interaction',
    'estimate_note'
  )),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  changed_by_id TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  changed_by_name TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_history_lead ON lead_status_history(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  time_window TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  pickup_address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'AL',
  zip_code TEXT NOT NULL,
  instructions TEXT DEFAULT '',
  created_by TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_appointments_lead ON appointments(lead_id);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  notes TEXT DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_up_tasks(status, due_date);

CREATE TABLE IF NOT EXISTS counties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'AL',
  seat TEXT,
  coverage_status TEXT NOT NULL DEFAULT 'research-only',
  page_id TEXT,
  geo_reference TEXT DEFAULT '',
  solid_waste_notes TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  last_verified_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS municipalities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'AL',
  county_id TEXT NOT NULL REFERENCES counties(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,
  coverage_status TEXT NOT NULL DEFAULT 'research-only',
  zip_codes_json TEXT NOT NULL DEFAULT '[]',
  parent_area_id TEXT,
  geo_reference TEXT DEFAULT '',
  pickup_notes TEXT DEFAULT '',
  page_id TEXT,
  source_url TEXT DEFAULT '',
  last_verified_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_municipalities_county ON municipalities(county_id, coverage_status);

CREATE TABLE IF NOT EXISTS neighborhoods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  municipality_id TEXT NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
  county_id TEXT NOT NULL REFERENCES counties(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,
  coverage_status TEXT NOT NULL DEFAULT 'research-only',
  zip_codes_json TEXT NOT NULL DEFAULT '[]',
  geo_reference TEXT DEFAULT '',
  pickup_notes TEXT DEFAULT '',
  local_evidence_json TEXT NOT NULL DEFAULT '[]',
  page_id TEXT,
  source_url TEXT DEFAULT '',
  last_verified_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_neighborhoods_muni ON neighborhoods(municipality_id, coverage_status);

CREATE TABLE IF NOT EXISTS service_areas (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('county', 'municipality', 'neighborhood')),
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  county_id TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT REFERENCES owner_profiles(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_registry (
  id TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  primary_keyword TEXT DEFAULT '',
  service_id TEXT,
  location_id TEXT,
  neighborhood_id TEXT,
  county_id TEXT,
  robots_index INTEGER NOT NULL DEFAULT 0,
  quality_score INTEGER DEFAULT 0,
  passes_gate INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_records (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  intent TEXT NOT NULL,
  role TEXT NOT NULL,
  target_page_id TEXT,
  location_relevance TEXT DEFAULT '',
  priority TEXT DEFAULT 'medium',
  impressions INTEGER,
  clicks INTEGER,
  ctr REAL,
  avg_position REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'page_view',
    'form_start',
    'form_step',
    'upload_complete',
    'form_complete',
    'click_to_call',
    'cta_click'
  )),
  session_bucket TEXT NOT NULL,
  page_path TEXT NOT NULL,
  landing_path TEXT DEFAULT '',
  service_slug TEXT DEFAULT '',
  location_slug TEXT DEFAULT '',
  referrer_host TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'direct',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  device_category TEXT NOT NULL DEFAULT 'unknown',
  is_test_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_events_created ON web_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_events_type ON web_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_web_events_page ON web_events(page_path, event_type);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('first_party', 'ga4', 'gsc', 'gsc_csv')),
  snapshot_date TEXT NOT NULL,
  dimension_kind TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  secondary_key TEXT DEFAULT '',
  metrics_json TEXT NOT NULL,
  is_test_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON analytics_snapshots(source, snapshot_date, dimension_kind);
