/**
 * server/crm.mjs
 * Core CRM, Lead Pipeline, Customer Directory, Calendar Scheduling,
 * Private Media Upload Session handling, Capacity Safeguards, and Exports.
 */
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chicagoDate } from './db.mjs';
import { sha256Hex, signMediaAccess } from './crypto-totp.mjs';
import { buildStorageKey, generateSafePhotoPreview, inspectMediaBuffer } from './storage.mjs';
import { detectDeviceCategory } from './analytics.mjs';
import { screenSubmission } from './spam-guard.mjs';

export const PIPELINE_STATUSES = [
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
];

const PUBLIC_SUBMISSION_WINDOW_MS = 15 * 60 * 1000;
const publicIpBuckets = new Map(); // ipHash -> number[]

function checkPublicRateLimit(ipHash, limit = 20) {
  const now = Date.now();
  const recent = (publicIpBuckets.get(ipHash) || []).filter((t) => now - t < PUBLIC_SUBMISSION_WINDOW_MS);
  if (recent.length >= limit) return false;
  recent.push(now);
  publicIpBuckets.set(ipHash, recent);
  return true;
}

export function normalizePhone(raw = '') {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function formatPhoneDisplay(raw = '') {
  const d = normalizePhone(raw);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw).trim();
}

function clean(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function createCrmService({ ctx, storage, realtime, masterKey, geo = null }) {
  const { db, paths, getSettings, setSetting, nextLeadNumber, logAudit, dbSizeBytes, checkpointDatabase, compactDatabase } = ctx;

  function publicUploadLimits() {
    const s = getSettings();
    return {
      maxPhotos: Number(s.max_photos || 12),
      maxVideos: Number(s.max_videos || 3),
      maxPhotoBytes: Number(s.max_photo_bytes || 15 * 1024 * 1024),
      maxVideoBytes: Number(s.max_video_bytes || 100 * 1024 * 1024),
      preserveOriginalUploads: !!s.preserve_original_uploads,
      allowedPhotoTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
      allowedVideoTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
      businessPhone: '251-930-8621'
    };
  }

  async function submitCustomerInquiry(body = {}, reqMeta = {}) {
    if (body._gotcha) {
      const err = new Error('Invalid submission.');
      err.status = 400;
      throw err;
    }

    const ipHash = sha256Hex(`pub:${reqMeta.ip || 'local'}`).slice(0, 20);
    if (!checkPublicRateLimit(ipHash, 25)) {
      const err = new Error('Too many requests from this connection. Please wait a few minutes or call 251-930-8621.');
      err.status = 429;
      throw err;
    }

    // Optional simulated error hook strictly for automated negative testing when ZOIRIS_TEST_HOOKS=1
    if (process.env.ZOIRIS_TEST_HOOKS === '1' && body._simulateDbFailure === true) {
      const err = new Error('Database persistence unavailable.');
      err.status = 503;
      throw err;
    }

    const idempotencyKey = clean(body.idempotencyKey || reqMeta.idempotencyKey || '', 120) || null;
    if (idempotencyKey) {
      const existing = db.prepare('SELECT id, lead_number FROM leads WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        const rawTok = mintUploadSession(existing.id, Number(body.expectedFiles || 0));
        return {
          ok: true,
          deduplicated: true,
          leadId: existing.id,
          leadNumber: existing.lead_number,
          uploadToken: rawTok,
          limits: publicUploadLimits(),
          businessPhone: '251-930-8621'
        };
      }
    }

    const firstName = clean(body.firstName, 80);
    const lastName = clean(body.lastName, 80);
    const phoneNorm = normalizePhone(body.phone || '');
    const email = clean(body.email, 160).toLowerCase() || null;
    const preferredContact = ['phone', 'text', 'email'].includes(body.preferredContact) ? body.preferredContact : 'phone';
    const customerType = String(body.customerType || 'residential').toLowerCase() === 'commercial' ? 'commercial' : 'residential';
    let pickupAddress = clean(body.pickupAddress, 240);
    let city = clean(body.city, 100);
    let state = clean(body.state || 'AL', 10).toUpperCase() || 'AL';
    let zipCode = clean(body.zipCode, 15);
    const addressUnit = clean(body.addressUnit, 40);
    const requestedService = clean(body.requestedService || 'Junk Removal', 120);
    const consentGiven = body.consentGiven === true || body.consentGiven === 'true' || body.consentGiven === 'on';

    // Layer 1 — spam / fake-contact screening (phone, email, names, links, promo wording, bot timing)
    const screen = await screenSubmission(body);
    if (screen.blocked) {
      const err = new Error(screen.message);
      err.status = 422;
      throw err;
    }

    // Layer 2 — real-address verification (signed token from the form, trusted relay geo, or server-side lookup)
    let geoRes = reqMeta.preVerifiedGeo || (body.addressToken && geo ? geo.readToken(String(body.addressToken)) : null);
    const fieldErrors = {};
    if (!geoRes && geo && pickupAddress.length >= 3) {
      geoRes = await geo.verify({ line: pickupAddress, city, state, zip: zipCode });
    }
    if (geoRes && (geoRes.status === 'verified' || geoRes.status === 'map-match')) {
      pickupAddress = geoRes.address.line;
      city = geoRes.address.city || city;
      state = geoRes.address.state || state;
      zipCode = geoRes.address.zip || zipCode;
    } else if (geoRes && (geoRes.status === 'not-found' || geoRes.status === 'outside-area')) {
      fieldErrors.pickupAddress = geoRes.message;
    }
    const addressStatus = geoRes?.status === 'verified' || geoRes?.status === 'map-match' ? geoRes.status : 'unverified';
    if (addressStatus === 'unverified') screen.flags.push('Address not auto-verified');

    if (firstName.length < 1) fieldErrors.firstName = 'First name is required.';
    if (lastName.length < 1) fieldErrors.lastName = 'Last name is required.';
    if (phoneNorm.length < 10) fieldErrors.phone = 'Enter a 10-digit telephone number.';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = 'Enter a valid email address or leave blank.';
    if (pickupAddress.length < 3) fieldErrors.pickupAddress = 'Pickup street address is required.';
    if (city.length < 2) fieldErrors.city = 'City is required.';
    if (!/^\d{5}(-\d{4})?$/.test(zipCode)) fieldErrors.zipCode = 'Enter a valid 5-digit ZIP code.';
    if (!consentGiven) fieldErrors.consentGiven = 'Please confirm contact consent so we can respond to your request.';
    Object.assign(fieldErrors, screen.fieldErrors);

    const selectedItems = Array.isArray(body.selectedItems) ? body.selectedItems.slice(0, 60) : [];
    const itemDescription = clean(body.itemDescription, 2000);
    const otherItemDescription = clean(body.otherItemDescription, 1000);
    if (selectedItems.length === 0 && itemDescription.length < 3 && otherItemDescription.length < 3) {
      fieldErrors.items = 'Select at least one item or describe what needs to be picked up.';
    }

    if (Object.keys(fieldErrors).length > 0) {
      const err = new Error('Please review the highlighted fields and try again.');
      err.status = 400;
      err.fieldErrors = fieldErrors;
      throw err;
    }

    const fullName = `${firstName} ${lastName}`.trim();
    const phoneDisplay = formatPhoneDisplay(phoneNorm);
    const now = new Date().toISOString();

    // Associate repeat inquiry with existing customer ONLY when phone AND full name match
    // (if phone/email matches a different name, create separate customer so duplicate detector suggests manual merge!)
    let customer = db
      .prepare('SELECT * FROM customers WHERE phone_normalized = ? AND lower(full_name) = lower(?) AND merged_into_id IS NULL LIMIT 1')
      .get(phoneNorm, fullName);

    if (!customer) {
      const custId = randomUUID();
      db.prepare(
        `INSERT INTO customers (
          id, first_name, last_name, full_name, phone_normalized, phone_display, email,
          primary_address, city, state, zip_code, customer_type, preferred_contact,
          total_inquiries, completed_pickups, last_contact_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`
      ).run(
        custId,
        firstName,
        lastName,
        fullName,
        phoneNorm,
        phoneDisplay,
        email,
        pickupAddress,
        city,
        state,
        zipCode,
        customerType,
        preferredContact,
        now,
        now,
        now
      );
      customer = { id: custId };
    } else {
      db.prepare(
        `UPDATE customers
         SET total_inquiries = total_inquiries + 1,
             email = COALESCE(?, email),
             primary_address = ?,
             city = ?,
             state = ?,
             zip_code = ?,
             last_contact_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(email, pickupAddress, city, state, zipCode, now, now, customer.id);
    }

    const categoriesSet = new Set();
    let hasElectronics = 0;
    for (const rawItem of selectedItems) {
      const cat = clean(rawItem?.category || 'Other', 60);
      categoriesSet.add(cat);
      if (cat.toLowerCase() === 'electronics' || rawItem?.isElectronics) hasElectronics = 1;
    }
    if (/electronics|e-waste|computer|tv|monitor|printer|laptop|server/i.test(requestedService + ' ' + itemDescription)) {
      hasElectronics = 1;
    }
    const categories = [...categoriesSet];
    const expectedFiles = Math.max(0, Math.min(20, Number(body.expectedFiles || 0)));

    // Infer matching municipality / county slug when possible
    const matchedMuni = db
      .prepare('SELECT id, county_id FROM municipalities WHERE lower(name) = lower(?) LIMIT 1')
      .get(city);

    const leadId = randomUUID();
    const prefNum = /^ZJ-\d{4}-[A-Z0-9]{5,8}$/.test(String(reqMeta.preferredLeadNumber || '')) ? String(reqMeta.preferredLeadNumber) : '';
    const leadNumber =
      prefNum && !db.prepare('SELECT 1 FROM leads WHERE lead_number = ?').get(prefNum) ? prefNum : nextLeadNumber();
    const deviceCategory = detectDeviceCategory(body.deviceCategory, reqMeta.userAgent);
    const sourcePagePath = clean(body.sourcePagePath || body.page || '', 180);

    db.prepare(
      `INSERT INTO leads (
        id, lead_number, idempotency_key, customer_id, status, priority, is_unread,
        first_name, last_name, full_name, phone, phone_normalized, email, preferred_contact, customer_type,
        pickup_address, city, state, zip_code, county_slug, location_slug, neighborhood_slug,
        requested_service, item_categories_json, has_electronics, item_description, other_item_description,
        estimated_quantity, estimated_dimensions, indoors_or_outdoors, floor_level, has_stairs,
        elevator_available, disassembled_status, access_instructions, preferred_date, preferred_window,
        customer_notes, consent_given, pending_upload_count,
        source_type, source_url, source_page_path, service_page_slug, location_page_slug,
        referrer_url, utm_source, utm_medium, utm_campaign, device_category,
        last_activity_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'New', 'normal', 1,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, 1, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )`
    ).run(
      leadId,
      leadNumber,
      idempotencyKey,
      customer.id,
      firstName,
      lastName,
      fullName,
      phoneDisplay,
      phoneNorm,
      email,
      preferredContact,
      customerType,
      pickupAddress,
      city,
      state,
      zipCode,
      clean(body.countySlug || matchedMuni?.county_id || '', 80) || null,
      clean(body.locationSlug || matchedMuni?.id || '', 80) || null,
      clean(body.neighborhoodSlug || '', 80) || null,
      requestedService,
      JSON.stringify(categories),
      hasElectronics,
      itemDescription,
      otherItemDescription,
      clean(body.estimatedQuantity, 80),
      clean(body.estimatedDimensions, 120),
      clean(body.indoorsOrOutdoors, 60),
      clean(body.floorLevel, 60),
      clean(body.hasStairs, 60),
      clean(body.elevatorAvailable, 60),
      clean(body.disassembledStatus, 80),
      clean(body.accessInstructions, 1000),
      clean(body.preferredDate, 30) || null,
      clean(body.preferredWindow, 80),
      clean(body.customerNotes, 1500),
      expectedFiles,
      clean(body.sourceType || 'website_form', 60),
      clean(body.sourceUrl, 300),
      sourcePagePath,
      clean(body.servicePageSlug, 100),
      clean(body.locationPageSlug, 100),
      clean(body.referrerUrl, 300),
      clean(body.utmSource, 80),
      clean(body.utmMedium, 80),
      clean(body.utmCampaign, 100),
      deviceCategory,
      now,
      now,
      now
    );

    const insItem = db.prepare(
      `INSERT INTO lead_items (id, lead_id, category, item_name, is_electronics, requires_confirmation, quantity_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.prepare(
      `UPDATE leads
       SET address_unit = ?, address_status = ?, address_source = ?, matched_address = ?,
           geo_lat = ?, geo_lng = ?, county_fips = ?, county_name = ?, spam_score = ?, spam_flags_json = ?,
           county_slug = COALESCE(?, county_slug)
       WHERE id = ?`
    ).run(
      addressUnit,
      addressStatus,
      addressStatus === 'unverified' ? '' : geoRes.source || '',
      addressStatus === 'unverified' ? '' : `${geoRes.address.line}, ${geoRes.address.city}, ${geoRes.address.state} ${geoRes.address.zip}`,
      addressStatus === 'unverified' ? null : Number(geoRes.address.lat),
      addressStatus === 'unverified' ? null : Number(geoRes.address.lng),
      addressStatus === 'unverified' ? '' : geoRes.address.countyFips || '',
      addressStatus === 'unverified' ? '' : geoRes.address.countyName || '',
      screen.score,
      JSON.stringify(screen.flags),
      addressStatus === 'unverified' ? null : geoRes.address.countyFips === '01003' ? 'baldwin-county-al' : 'mobile-county-al',
      leadId
    );
    for (const rawItem of selectedItems) {
      const cat = clean(rawItem?.category || 'Other', 60);
      const name = clean(rawItem?.name || rawItem, 120);
      if (!name) continue;
      const isElec = cat.toLowerCase() === 'electronics' || rawItem?.isElectronics ? 1 : 0;
      const reqConf = /battery|batteries|construction|refrigerator|freezer/i.test(name) || rawItem?.requiresConfirmation ? 1 : 0;
      insItem.run(randomUUID(), leadId, cat, name, isElec, reqConf, clean(rawItem?.quantityNote || '', 80), now);
    }
    if (otherItemDescription) {
      insItem.run(randomUUID(), leadId, 'Other', `Other: ${otherItemDescription.slice(0, 110)}`, 0, 1, '', now);
    }

    recordLeadEvent({
      leadId,
      actorId: null,
      actorLabel: 'Customer Website Inquiry',
      eventType: 'inquiry_received',
      summary: `Pickup request ${leadNumber} received from ${fullName} (${city}, ${state} ${zipCode}) for ${requestedService}.`,
      metadata: { sourcePagePath, expectedFiles, itemCount: selectedItems.length }
    });

    db.prepare(
      `INSERT INTO lead_status_history (id, lead_id, previous_status, new_status, changed_by_id, changed_by_name, note, created_at)
       VALUES (?, ?, NULL, 'New', NULL, 'System', 'Initial website pickup inquiry saved', ?)`
    ).run(randomUUID(), leadId, now);

    const uploadToken = mintUploadSession(leadId, expectedFiles);

    realtime.broadcast('lead.created', {
      id: leadId,
      leadNumber,
      fullName,
      city,
      state,
      requestedService,
      sourcePagePath,
      createdAt: now
    });

    // Dispatch owner notifications asynchronously — never block or fail customer persistence
    realtime
      .notifyOwners({
        kind: 'new_lead',
        title: `New Pickup Request ${leadNumber}`,
        body: `${fullName} (${city}, ${state}) requested ${requestedService}.`,
        leadId
      })
      .catch(() => {});

    return {
      ok: true,
      deduplicated: false,
      leadId,
      leadNumber,
      uploadToken,
      limits: publicUploadLimits(),
      businessPhone: '251-930-8621'
    };
  }

  function mintUploadSession(leadId, expectedFiles = 0) {
    const s = getSettings();
    const ttlMin = Math.max(10, Number(s.upload_session_ttl_minutes || 45));
    const rawToken = randomBytes(28).toString('hex');
    const now = Date.now();
    db.prepare(
      `INSERT INTO file_upload_sessions (id, lead_id, token_hash, expected_files, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
    ).run(
      randomUUID(),
      leadId,
      sha256Hex(rawToken),
      expectedFiles,
      new Date(now + ttlMin * 60000).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString()
    );
    return rawToken;
  }

  async function uploadCustomerMedia({ uploadToken, buffer, filename, reqMeta = {} }) {
    if (!uploadToken) {
      const err = new Error('Missing upload authorization token.');
      err.status = 401;
      throw err;
    }

    const ipHash = sha256Hex(`up:${reqMeta.ip || 'local'}`).slice(0, 20);
    if (!checkPublicRateLimit(ipHash, 60)) {
      const err = new Error('Upload rate limit exceeded. Please wait a moment and retry.');
      err.status = 429;
      throw err;
    }

    const session = db
      .prepare('SELECT * FROM file_upload_sessions WHERE token_hash = ?')
      .get(sha256Hex(String(uploadToken)));

    if (!session || session.status !== 'open' || Date.parse(session.expires_at) <= Date.now()) {
      const err = new Error('Upload session expired or invalid. Your pickup request was already saved — call 251-930-8621 if you need help sending media.');
      err.status = 401;
      throw err;
    }

    const inspected = inspectMediaBuffer(buffer, filename);
    if (!inspected.ok) {
      db.prepare('UPDATE file_upload_sessions SET failed_uploads = failed_uploads + 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        session.id
      );
      const err = new Error(inspected.error);
      err.status = inspected.status || 415;
      throw err;
    }

    const settings = getSettings();
    const maxPhotos = Number(settings.max_photos || 12);
    const maxVideos = Number(settings.max_videos || 3);
    const maxPhotoBytes = Number(settings.max_photo_bytes || 15 * 1024 * 1024);
    const maxVideoBytes = Number(settings.max_video_bytes || 100 * 1024 * 1024);
    const storageQuotaBytes = Number(settings.storage_quota_bytes || 1024 * 1024 * 1024);

    if (inspected.kind === 'photo' && inspected.byteSize > maxPhotoBytes) {
      db.prepare('UPDATE file_upload_sessions SET failed_uploads = failed_uploads + 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        session.id
      );
      const err = new Error(`Photo "${inspected.safeFilename}" exceeds the ${(maxPhotoBytes / (1024 * 1024)).toFixed(0)} MB maximum per photo.`);
      err.status = 413;
      throw err;
    }
    if (inspected.kind === 'video' && inspected.byteSize > maxVideoBytes) {
      db.prepare('UPDATE file_upload_sessions SET failed_uploads = failed_uploads + 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        session.id
      );
      const err = new Error(`Video "${inspected.safeFilename}" exceeds the ${(maxVideoBytes / (1024 * 1024)).toFixed(0)} MB maximum per video.`);
      err.status = 413;
      throw err;
    }

    // Count active attachments already stored on this lead
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN media_kind = 'photo' THEN 1 ELSE 0 END) AS photos,
           SUM(CASE WHEN media_kind = 'video' THEN 1 ELSE 0 END) AS videos
         FROM lead_attachments
         WHERE lead_id = ? AND deletion_status = 'active'`
      )
      .get(session.lead_id);

    if (inspected.kind === 'photo' && Number(counts.photos || 0) >= maxPhotos) {
      const err = new Error(`Maximum of ${maxPhotos} photos reached for this pickup request.`);
      err.status = 400;
      throw err;
    }
    if (inspected.kind === 'video' && Number(counts.videos || 0) >= maxVideos) {
      const err = new Error(`Maximum of ${maxVideos} videos reached for this pickup request.`);
      err.status = 400;
      throw err;
    }

    // Hard storage quota check — never lose data silently
    const currentUsedBytes = totalActiveMediaBytes();
    if (currentUsedBytes + inspected.byteSize > storageQuotaBytes) {
      realtime
        .notifyOwners({
          kind: 'storage_alert',
          title: 'Storage Quota Reached (100%)',
          body: `Customer media upload rejected safely because storage reached ${(currentUsedBytes / (1024 * 1024)).toFixed(1)} MB of ${(storageQuotaBytes / (1024 * 1024)).toFixed(1)} MB quota. Lead record is preserved.`,
          leadId: session.lead_id
        })
        .catch(() => {});
      const err = new Error(
        'Our media vault is temporarily full, so this file could not be attached. Your pickup request details are already saved — please call 251-930-8621.'
      );
      err.status = 507;
      throw err;
    }

    const storageKey = buildStorageKey(session.lead_id, inspected.ext);
    await storage.putOriginal(storageKey, buffer, inspected.mime);

    let previewKey = null;
    let width = null;
    let height = null;
    if (inspected.kind === 'photo') {
      const prev = await generateSafePhotoPreview(buffer, inspected.mime);
      if (prev) {
        previewKey = storageKey.replace(/\.[^.]+$/, '.preview.webp');
        await storage.putPreview(previewKey, prev.previewBuffer);
        width = prev.width;
        height = prev.height;
      }
    }

    const attachmentId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO lead_attachments (
        id, lead_id, upload_session_id, media_kind, storage_provider, storage_bucket,
        storage_key, preview_key, original_filename, safe_filename, validated_mime,
        byte_size, sha256_hex, width, height, processing_status, deletion_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'active', ?)`
    ).run(
      attachmentId,
      session.lead_id,
      session.id,
      inspected.kind,
      storage.name,
      storage.bucket,
      storageKey,
      previewKey,
      inspected.originalFilename,
      inspected.safeFilename,
      inspected.mime,
      inspected.byteSize,
      inspected.sha256,
      width,
      height,
      now
    );

    db.prepare(
      `UPDATE file_upload_sessions
       SET uploaded_photos = uploaded_photos + ?,
           uploaded_videos = uploaded_videos + ?,
           total_bytes = total_bytes + ?,
           updated_at = ?
       WHERE id = ?`
    ).run(inspected.kind === 'photo' ? 1 : 0, inspected.kind === 'video' ? 1 : 0, inspected.byteSize, now, session.id);

    db.prepare(
      `UPDATE leads
       SET photo_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'photo' AND deletion_status = 'active'),
           video_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'video' AND deletion_status = 'active'),
           pending_upload_count = CASE WHEN pending_upload_count > 0 THEN pending_upload_count - 1 ELSE 0 END,
           last_activity_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(session.lead_id, session.lead_id, now, now, session.lead_id);

    recordLeadEvent({
      leadId: session.lead_id,
      actorId: null,
      actorLabel: 'Customer Upload',
      eventType: 'attachment_uploaded',
      summary: `Uploaded ${inspected.kind} "${inspected.safeFilename}" (${formatBytes(inspected.byteSize)}).`,
      metadata: { attachmentId, mediaKind: inspected.kind, mime: inspected.mime, byteSize: inspected.byteSize }
    });

    await checkStorageAlertThresholds(currentUsedBytes + inspected.byteSize, storageQuotaBytes, settings);

    realtime.broadcast('attachment.uploaded', {
      leadId: session.lead_id,
      attachmentId,
      mediaKind: inspected.kind,
      safeFilename: inspected.safeFilename,
      byteSize: inspected.byteSize
    });

    return {
      ok: true,
      attachmentId,
      mediaKind: inspected.kind,
      mime: inspected.mime,
      byteSize: inspected.byteSize,
      safeFilename: inspected.safeFilename
    };
  }

  function completeUploadSession(uploadToken) {
    if (!uploadToken) return { ok: true };
    const now = new Date().toISOString();
    const session = db.prepare('SELECT * FROM file_upload_sessions WHERE token_hash = ?').get(sha256Hex(String(uploadToken)));
    if (session) {
      db.prepare("UPDATE file_upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(now, session.id);
      db.prepare('UPDATE leads SET pending_upload_count = 0, updated_at = ? WHERE id = ?').run(now, session.lead_id);
    }
    return { ok: true };
  }

  function cleanupExpiredUploadSessions() {
    const now = new Date().toISOString();
    const expired = db
      .prepare("SELECT id, lead_id FROM file_upload_sessions WHERE status = 'open' AND expires_at <= ?")
      .all(now);
    for (const s of expired) {
      db.prepare("UPDATE file_upload_sessions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, s.id);
      db.prepare('UPDATE leads SET pending_upload_count = 0 WHERE id = ?').run(s.lead_id);
    }
    return expired.length;
  }

  async function checkStorageAlertThresholds(usedBytes, quotaBytes, settings) {
    if (!quotaBytes) return;
    const pct = (usedBytes / quotaBytes) * 100;
    const thresholds = [
      Number(settings.quota_warn_95 || 95),
      Number(settings.quota_warn_85 || 85),
      Number(settings.quota_warn_70 || 70)
    ].sort((a, b) => b - a);
    for (const t of thresholds) {
      if (pct >= t) {
        const lastAlerted = Number(settings.last_storage_alert_threshold || 0);
        if (lastAlerted < t) {
          setSetting('last_storage_alert_threshold', t, null);
          realtime.broadcast('storage.alert', { thresholdPct: t, usedBytes, quotaBytes });
          await realtime.notifyOwners({
            kind: 'storage_alert',
            title: `Media Storage Alert: ${t}% Capacity Reached`,
            body: `Private customer media storage is at ${pct.toFixed(1)}% (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)}).`
          });
        }
        break;
      }
    }
  }

  function totalActiveMediaBytes() {
    const row = db
      .prepare("SELECT COALESCE(SUM(byte_size), 0) AS total FROM lead_attachments WHERE deletion_status = 'active'")
      .get();
    return Number(row.total || 0);
  }

  function mintSignedMediaUrl(attachmentId, { kind = 'original', disposition = 'inline', ttlSeconds = null } = {}) {
    const settings = getSettings();
    const ttl = ttlSeconds !== null ? Number(ttlSeconds) : Math.max(30, Number(settings.signed_url_ttl_seconds || 300));
    const expiresAtUnix = Math.floor(Date.now() / 1000) + ttl;
    const sig = signMediaAccess({ attachmentId, kind, disposition, expiresAtUnix }, masterKey);
    const params = new URLSearchParams({
      kind,
      disposition,
      exp: String(expiresAtUnix),
      sig
    });
    return `/api/media/stream/${encodeURIComponent(attachmentId)}?${params.toString()}`;
  }

  function decorateAttachmentForOwner(att) {
    const hasPreview = !!att.preview_key;
    return {
      id: att.id,
      leadId: att.lead_id,
      mediaKind: att.media_kind,
      storageProvider: att.storage_provider,
      originalFilename: att.original_filename,
      safeFilename: att.safe_filename,
      validatedMime: att.validated_mime,
      byteSize: att.byte_size,
      width: att.width,
      height: att.height,
      processingStatus: att.processing_status,
      deletionStatus: att.deletion_status,
      createdAt: att.created_at,
      previewUrl: att.deletion_status === 'active' ? mintSignedMediaUrl(att.id, { kind: hasPreview ? 'preview' : 'original', disposition: 'inline' }) : null,
      streamUrl: att.deletion_status === 'active' ? mintSignedMediaUrl(att.id, { kind: 'original', disposition: 'inline' }) : null,
      downloadUrl: att.deletion_status === 'active' ? mintSignedMediaUrl(att.id, { kind: 'original', disposition: 'attachment' }) : null
    };
  }

  function refreshStorageAlertBaseline() {
    const s = getSettings();
    const quota = Number(s.storage_quota_bytes || 1024 * 1024 * 1024);
    if (!quota) return;
    const pct = (totalActiveMediaBytes() / quota) * 100;
    const warn70 = Number(s.quota_warn_70 || 70);
    if (pct < warn70 && Number(s.last_storage_alert_threshold || 0) > 0) {
      setSetting('last_storage_alert_threshold', 0, null);
    }
  }

  function sweepOrphanMedia() {
    const softDeleted = db
      .prepare("SELECT id, storage_key, preview_key FROM lead_attachments WHERE deletion_status != 'active'")
      .all();
    let rowsRemoved = 0;
    if (softDeleted.length) {
      db.prepare("DELETE FROM lead_attachments WHERE deletion_status != 'active'").run();
      rowsRemoved = softDeleted.length;
    }
    const activeRows = db
      .prepare("SELECT storage_key, preview_key FROM lead_attachments WHERE deletion_status = 'active'")
      .all();
    const activeOrig = new Set(activeRows.map((r) => String(r.storage_key || '').replace(/\\/g, '/')).filter(Boolean));
    const activePrev = new Set(activeRows.map((r) => String(r.preview_key || '').replace(/\\/g, '/')).filter(Boolean));
    const swept = storage.sweepOrphans ? storage.sweepOrphans(activeOrig, activePrev) : { filesDeleted: 0, bytesFreed: 0, dirsRemoved: 0 };
    return { ...swept, softDeletedRowsPurged: rowsRemoved };
  }

  async function deleteLeadAttachment(attachmentId, owner, { skipCheckpoint = false } = {}) {
    const att = db.prepare('SELECT * FROM lead_attachments WHERE id = ?').get(attachmentId);
    if (!att) {
      const err = new Error('Attachment not found.');
      err.status = 404;
      throw err;
    }

    await storage.deleteObject(att.storage_key, att.preview_key);
    db.prepare('DELETE FROM lead_attachments WHERE id = ?').run(attachmentId);

    const now = new Date().toISOString();
    const leadExists = db.prepare('SELECT id FROM leads WHERE id = ?').get(att.lead_id);
    if (leadExists) {
      db.prepare(
        `UPDATE leads
         SET photo_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'photo' AND deletion_status = 'active'),
             video_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'video' AND deletion_status = 'active'),
             last_activity_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(att.lead_id, att.lead_id, now, now, att.lead_id);

      recordLeadEvent({
        leadId: att.lead_id,
        actorId: owner?.id || null,
        actorLabel: owner?.displayName || 'Owner',
        eventType: 'attachment_deleted',
        summary: `Deleted ${att.media_kind} attachment "${att.safe_filename}" (${formatBytes(att.byte_size)}).`,
        metadata: { attachmentId, byteSize: att.byte_size }
      });
    }

    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'attachment.deleted',
      entityType: 'lead_attachment',
      entityId: attachmentId,
      metadata: { leadId: att.lead_id, filename: att.safe_filename, byteSize: att.byte_size }
    });

    refreshStorageAlertBaseline();
    if (!skipCheckpoint && checkpointDatabase) checkpointDatabase();
    realtime.broadcast('lead.updated', { leadId: att.lead_id });
    return { ok: true, byteSize: Number(att.byte_size || 0) };
  }

  async function deleteAllLeadMedia(idOrNumber, owner) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ? LIMIT 1').get(idOrNumber, idOrNumber);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }
    const atts = db.prepare('SELECT * FROM lead_attachments WHERE lead_id = ?').all(lead.id);
    let bytesFreed = 0;
    for (const att of atts) {
      await storage.deleteObject(att.storage_key, att.preview_key);
      bytesFreed += Number(att.byte_size || 0);
    }
    db.prepare('DELETE FROM lead_attachments WHERE lead_id = ?').run(lead.id);
    const now = new Date().toISOString();
    db.prepare('UPDATE leads SET photo_count = 0, video_count = 0, pending_upload_count = 0, last_activity_at = ?, updated_at = ? WHERE id = ?').run(
      now,
      now,
      lead.id
    );
    if (atts.length) {
      recordLeadEvent({
        leadId: lead.id,
        actorId: owner?.id || null,
        actorLabel: owner?.displayName || 'Owner',
        eventType: 'attachment_deleted',
        summary: `Deleted all ${atts.length} attached file(s) (${formatBytes(bytesFreed)} freed).`,
        metadata: { deletedCount: atts.length, bytesFreed }
      });
      logAudit({
        actorId: owner?.id || null,
        actorEmail: owner?.email || null,
        action: 'lead.media_cleared',
        entityType: 'lead',
        entityId: lead.id,
        metadata: { leadNumber: lead.lead_number, deletedCount: atts.length, bytesFreed }
      });
    }
    refreshStorageAlertBaseline();
    const compact = compactDatabase ? compactDatabase() : { reclaimedBytes: 0 };
    realtime.broadcast('lead.updated', { leadId: lead.id });
    return { ok: true, deletedCount: atts.length, bytesFreed, reclaimedDbBytes: compact.reclaimedBytes };
  }

  async function bulkDeleteMedia({ attachmentIds = [], filter = '', owner }) {
    let rows = [];
    if (filter === 'all') {
      rows = db.prepare('SELECT * FROM lead_attachments').all();
    } else if (filter === 'closed_leads') {
      rows = db
        .prepare(
          `SELECT a.* FROM lead_attachments a
           JOIN leads l ON l.id = a.lead_id
           WHERE l.status IN ('Completed', 'Not Converted', 'Archived', 'Spam')`
        )
        .all();
    } else if (Array.isArray(attachmentIds) && attachmentIds.length) {
      const placeholders = attachmentIds.map(() => '?').join(',');
      rows = db.prepare(`SELECT * FROM lead_attachments WHERE id IN (${placeholders})`).all(...attachmentIds);
    }

    let bytesFreed = 0;
    const touchedLeadIds = new Set();
    for (const att of rows) {
      await storage.deleteObject(att.storage_key, att.preview_key);
      db.prepare('DELETE FROM lead_attachments WHERE id = ?').run(att.id);
      bytesFreed += Number(att.byte_size || 0);
      touchedLeadIds.add(att.lead_id);
    }

    const now = new Date().toISOString();
    for (const lid of touchedLeadIds) {
      db.prepare(
        `UPDATE leads
         SET photo_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'photo' AND deletion_status = 'active'),
             video_count = (SELECT COUNT(*) FROM lead_attachments WHERE lead_id = ? AND media_kind = 'video' AND deletion_status = 'active'),
             updated_at = ?
         WHERE id = ?`
      ).run(lid, lid, now, lid);
    }

    const orphan = sweepOrphanMedia();
    refreshStorageAlertBaseline();
    const compact = compactDatabase ? compactDatabase() : { reclaimedBytes: 0 };

    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'media.bulk_deleted',
      entityType: 'lead_attachment',
      metadata: { filter: filter || 'ids', deletedCount: rows.length, bytesFreed: bytesFreed + orphan.bytesFreed }
    });
    realtime.broadcast('media.deleted', { deletedCount: rows.length });
    return {
      ok: true,
      deletedCount: rows.length + orphan.filesDeleted,
      bytesFreed: bytesFreed + orphan.bytesFreed,
      reclaimedDbBytes: compact.reclaimedBytes
    };
  }

  function listLeads({
    q = '',
    status = '',
    priority = '',
    unreadOnly = false,
    city = '',
    service = '',
    dateFrom = '',
    dateTo = '',
    includeArchived = false,
    sort = 'newest',
    page = 1,
    pageSize = 25
  } = {}) {
    const clauses = ['1=1'];
    const params = [];

    if (q) {
      const term = `%${String(q).trim()}%`;
      const phoneTerm = `%${normalizePhone(q)}%`;
      clauses.push(
        `(full_name LIKE ? OR phone LIKE ? OR (length(?) > 2 AND phone_normalized LIKE ?) OR email LIKE ? OR city LIKE ? OR zip_code LIKE ? OR lead_number LIKE ? OR requested_service LIKE ?)`
      );
      params.push(term, term, normalizePhone(q), phoneTerm, term, term, term, term, term);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    } else if (!includeArchived && !q) {
      clauses.push("status NOT IN ('Archived', 'Spam')");
    }
    if (priority) {
      clauses.push('priority = ?');
      params.push(priority);
    }
    if (unreadOnly) {
      clauses.push('is_unread = 1');
    }
    if (city) {
      clauses.push('lower(city) = lower(?)');
      params.push(city);
    }
    if (service) {
      clauses.push('requested_service = ?');
      params.push(service);
    }
    if (dateFrom) {
      clauses.push('created_at >= ?');
      params.push(`${dateFrom}T00:00:00.000Z`);
    }
    if (dateTo) {
      clauses.push('created_at <= ?');
      params.push(`${dateTo}T23:59:59.999Z`);
    }

    const orderSql =
      sort === 'oldest'
        ? 'created_at ASC'
        : sort === 'activity'
          ? 'last_activity_at DESC'
          : sort === 'priority'
            ? "CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END ASC, created_at DESC"
            : 'created_at DESC';

    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(100, Math.max(1, Number(pageSize || 25)));
    const offset = (safePage - 1) * safeLimit;

    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${clauses.join(' AND ')}`).get(...params).n);
    const rows = db
      .prepare(`SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, offset);

    return {
      total,
      page: safePage,
      pageSize: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      leads: rows.map(mapLeadSummary)
    };
  }

  function getPipelineBoard() {
    const rows = db.prepare('SELECT * FROM leads ORDER BY last_activity_at DESC').all();
    const columns = {};
    for (const st of PIPELINE_STATUSES) columns[st] = [];
    for (const r of rows) {
      const s = columns[r.status] ? r.status : 'New';
      columns[s].push(mapLeadSummary(r));
    }
    return { statuses: PIPELINE_STATUSES, columns };
  }

  function getLeadDetail(idOrNumber, owner, { markOpened = true } = {}) {
    const lead = db
      .prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ? LIMIT 1')
      .get(idOrNumber, idOrNumber);
    if (!lead) {
      const err = new Error('Lead record not found.');
      err.status = 404;
      throw err;
    }

    if (markOpened && lead.is_unread) {
      const now = new Date().toISOString();
      db.prepare('UPDATE leads SET is_unread = 0, opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?').run(
        now,
        now,
        lead.id
      );
      lead.is_unread = 0;
      lead.opened_at = lead.opened_at || now;
      if (owner) {
        recordLeadEvent({
          leadId: lead.id,
          actorId: owner.id,
          actorLabel: owner.displayName,
          eventType: 'lead_opened',
          summary: `Lead opened by ${owner.displayName}.`
        });
      }
      realtime.broadcast('lead.updated', { leadId: lead.id, isUnread: false });
    }

    const items = db.prepare('SELECT * FROM lead_items WHERE lead_id = ? ORDER BY created_at ASC').all(lead.id);
    const attachments = db
      .prepare("SELECT * FROM lead_attachments WHERE lead_id = ? AND deletion_status = 'active' ORDER BY created_at ASC")
      .all(lead.id)
      .map(decorateAttachmentForOwner);
    const notes = db.prepare('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id);
    const statusHistory = db.prepare('SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id);
    const timeline = db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id);
    const appointments = db.prepare('SELECT * FROM appointments WHERE lead_id = ? ORDER BY scheduled_date DESC').all(lead.id);
    const followUps = db.prepare('SELECT * FROM follow_up_tasks WHERE lead_id = ? ORDER BY due_date ASC').all(lead.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(lead.customer_id);

    return {
      lead: mapLeadFull(lead),
      customer,
      items,
      attachments,
      notes,
      statusHistory,
      timeline: timeline.map((e) => ({ ...e, metadata: safeParseJson(e.metadata_json, {}) })),
      appointments,
      followUps
    };
  }

  function updateLeadStatus({ leadId, newStatus, note = '', owner }) {
    if (!PIPELINE_STATUSES.includes(newStatus)) {
      const err = new Error(`Invalid pipeline status: ${newStatus}`);
      err.status = 400;
      throw err;
    }
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ?').get(leadId, leadId);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }

    const prev = lead.status;
    const now = new Date().toISOString();
    const isUnread = newStatus === 'Unread' ? 1 : 0;
    const completedAt = newStatus === 'Completed' ? lead.completed_at || now : lead.completed_at;
    const completionStatus = newStatus === 'Completed' ? 'completed' : lead.completion_status;

    db.prepare(
      `UPDATE leads
       SET status = ?, is_unread = ?, completed_at = ?, completion_status = ?, last_activity_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(newStatus, isUnread, completedAt, completionStatus, now, now, lead.id);

    if (newStatus === 'Completed' && prev !== 'Completed') {
      db.prepare('UPDATE customers SET completed_pickups = completed_pickups + 1, updated_at = ? WHERE id = ?').run(now, lead.customer_id);
    }

    db.prepare(
      `INSERT INTO lead_status_history (id, lead_id, previous_status, new_status, changed_by_id, changed_by_name, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), lead.id, prev, newStatus, owner.id, owner.displayName, clean(note, 500), now);

    const eventType =
      newStatus === 'Contacted'
        ? 'customer_contacted'
        : newStatus === 'Estimate Being Prepared'
          ? 'estimate_prepared'
          : newStatus === 'Estimate Sent'
            ? 'estimate_sent'
            : newStatus === 'Pickup Scheduled'
              ? 'pickup_scheduled'
              : newStatus === 'Completed'
                ? 'job_completed'
                : 'status_updated';

    recordLeadEvent({
      leadId: lead.id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType,
      summary: `Status changed from "${prev}" to "${newStatus}"${note ? ` — ${clean(note, 200)}` : ''}.`,
      metadata: { previousStatus: prev, newStatus, note: clean(note, 500) }
    });

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: lead.id,
      metadata: { leadNumber: lead.lead_number, previousStatus: prev, newStatus }
    });

    realtime.broadcast('lead.status_changed', {
      leadId: lead.id,
      leadNumber: lead.lead_number,
      previousStatus: prev,
      newStatus
    });

    return getLeadDetail(lead.id, owner, { markOpened: false });
  }

  function updateLeadFields({ leadId, patch = {}, owner }) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ?').get(leadId, leadId);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const priority = patch.priority && ['low', 'normal', 'high', 'urgent'].includes(patch.priority) ? patch.priority : lead.priority;
    const estimateCents =
      patch.estimateDollars !== undefined
        ? patch.estimateDollars === '' || patch.estimateDollars === null
          ? null
          : Math.round(Number(patch.estimateDollars) * 100)
        : patch.estimateCents !== undefined
          ? patch.estimateCents
          : lead.estimate_cents;
    const estimateNotes = patch.estimateNotes !== undefined ? clean(patch.estimateNotes, 1000) : lead.estimate_notes;
    const followUpAt = patch.followUpAt !== undefined ? clean(patch.followUpAt, 40) || null : lead.follow_up_at;
    const scheduledPickupAt =
      patch.scheduledPickupAt !== undefined ? clean(patch.scheduledPickupAt, 40) || null : lead.scheduled_pickup_at;
    const completionStatus =
      patch.completionStatus !== undefined ? clean(patch.completionStatus, 60) : lead.completion_status;

    db.prepare(
      `UPDATE leads
       SET priority = ?, estimate_cents = ?, estimate_notes = ?, follow_up_at = ?,
           scheduled_pickup_at = ?, completion_status = ?, last_activity_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(priority, estimateCents, estimateNotes, followUpAt, scheduledPickupAt, completionStatus, now, now, lead.id);

    const changes = [];
    if (priority !== lead.priority) changes.push(`priority → ${priority}`);
    if (estimateCents !== lead.estimate_cents) {
      changes.push(estimateCents !== null ? `estimate → $${(estimateCents / 100).toFixed(2)}` : 'estimate cleared');
    }
    if (followUpAt !== lead.follow_up_at) changes.push(`follow-up → ${followUpAt || 'none'}`);
    if (scheduledPickupAt !== lead.scheduled_pickup_at) changes.push(`scheduled pickup → ${scheduledPickupAt || 'none'}`);
    if (completionStatus !== lead.completion_status) changes.push(`completion → ${completionStatus}`);

    if (changes.length) {
      recordLeadEvent({
        leadId: lead.id,
        actorId: owner.id,
        actorLabel: owner.displayName,
        eventType: estimateCents !== lead.estimate_cents ? 'estimate_prepared' : 'lead_updated',
        summary: `Updated CRM details: ${changes.join(', ')}.`,
        metadata: { changes }
      });
      logAudit({
        actorId: owner.id,
        actorEmail: owner.email,
        action: 'lead.updated',
        entityType: 'lead',
        entityId: lead.id,
        metadata: { leadNumber: lead.lead_number, changes }
      });
      realtime.broadcast('lead.updated', { leadId: lead.id, changes });
    }

    return getLeadDetail(lead.id, owner, { markOpened: false });
  }

  function addLeadNote({ leadId, noteType = 'internal_note', body, owner }) {
    const allowedTypes = ['internal_note', 'phone_call', 'text_interaction', 'email_interaction', 'estimate_note'];
    const safeType = allowedTypes.includes(noteType) ? noteType : 'internal_note';
    const text = clean(body, 4000);
    if (!text) {
      const err = new Error('Note text cannot be empty.');
      err.status = 400;
      throw err;
    }

    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ?').get(leadId, leadId);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const noteId = randomUUID();
    db.prepare(
      `INSERT INTO lead_notes (id, lead_id, author_id, author_name, note_type, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(noteId, lead.id, owner.id, owner.displayName, safeType, text, now);

    db.prepare('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(now, now, lead.id);
    if (['phone_call', 'text_interaction', 'email_interaction'].includes(safeType)) {
      db.prepare('UPDATE customers SET last_contact_at = ?, updated_at = ? WHERE id = ?').run(now, now, lead.customer_id);
    }

    const labels = {
      internal_note: 'Internal note added',
      phone_call: 'Recorded phone call log (internal record)',
      text_interaction: 'Recorded text-message interaction (internal record)',
      email_interaction: 'Recorded email interaction (internal record)',
      estimate_note: 'Recorded estimate details'
    };

    recordLeadEvent({
      leadId: lead.id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType: safeType === 'internal_note' ? 'note_added' : 'customer_contacted',
      summary: `${labels[safeType]}: "${text.slice(0, 140)}${text.length > 140 ? '…' : ''}"`,
      metadata: { noteId, noteType: safeType }
    });

    realtime.broadcast('lead.note_added', { leadId: lead.id, noteId, noteType: safeType });
    return getLeadDetail(lead.id, owner, { markOpened: false });
  }

  function deleteLeadNote(noteId, owner) {
    const note = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(noteId);
    if (!note) {
      const err = new Error('Note not found.');
      err.status = 404;
      throw err;
    }
    db.prepare('DELETE FROM lead_notes WHERE id = ?').run(noteId);
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'lead_note.deleted',
      entityType: 'lead_note',
      entityId: noteId,
      metadata: { leadId: note.lead_id }
    });
    if (checkpointDatabase) checkpointDatabase();
    realtime.broadcast('lead.updated', { leadId: note.lead_id });
    return { ok: true, leadId: note.lead_id };
  }

  function createFollowUpTask({ leadId, title, dueDate, notes = '', owner }) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ?').get(leadId, leadId);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }
    const cleanTitle = clean(title, 200);
    const cleanDue = clean(dueDate, 30);
    if (!cleanTitle || !cleanDue) {
      const err = new Error('Follow-up title and due date are required.');
      err.status = 400;
      throw err;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO follow_up_tasks (id, lead_id, assigned_to, title, due_date, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
    ).run(id, lead.id, owner.id, cleanTitle, cleanDue, clean(notes, 1000), now, now);

    db.prepare('UPDATE leads SET follow_up_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?').run(
      cleanDue,
      now,
      now,
      lead.id
    );

    recordLeadEvent({
      leadId: lead.id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType: 'follow_up_created',
      summary: `Follow-up scheduled for ${cleanDue}: ${cleanTitle}`,
      metadata: { taskId: id, dueDate: cleanDue }
    });

    realtime.broadcast('lead.updated', { leadId: lead.id });
    return { id, leadId: lead.id, title: cleanTitle, dueDate: cleanDue };
  }

  function updateFollowUpTask({ taskId, status, owner }) {
    const task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = new Error('Follow-up task not found.');
      err.status = 404;
      throw err;
    }
    const now = new Date().toISOString();
    const safeStatus = ['open', 'completed', 'cancelled'].includes(status) ? status : 'completed';
    db.prepare('UPDATE follow_up_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
      safeStatus,
      safeStatus === 'completed' ? now : null,
      now,
      taskId
    );
    recordLeadEvent({
      leadId: task.lead_id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType: 'follow_up_updated',
      summary: `Follow-up "${task.title}" marked ${safeStatus}.`
    });
    return { ok: true };
  }

  function deleteFollowUpTask(taskId, owner) {
    const task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = new Error('Follow-up task not found.');
      err.status = 404;
      throw err;
    }
    db.prepare('DELETE FROM follow_up_tasks WHERE id = ?').run(taskId);
    const nextOpen = db
      .prepare("SELECT due_date FROM follow_up_tasks WHERE lead_id = ? AND status = 'open' ORDER BY due_date ASC LIMIT 1")
      .get(task.lead_id);
    db.prepare('UPDATE leads SET follow_up_at = ?, updated_at = ? WHERE id = ?').run(
      nextOpen?.due_date || null,
      new Date().toISOString(),
      task.lead_id
    );
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'follow_up.deleted',
      entityType: 'follow_up_task',
      entityId: taskId,
      metadata: { leadId: task.lead_id, title: task.title }
    });
    if (checkpointDatabase) checkpointDatabase();
    realtime.broadcast('lead.updated', { leadId: task.lead_id });
    return { ok: true, leadId: task.lead_id };
  }

  function listAppointments({ fromDate = '', toDate = '', status = '' } = {}) {
    const clauses = ['1=1'];
    const params = [];
    if (fromDate) {
      clauses.push('a.scheduled_date >= ?');
      params.push(fromDate);
    }
    if (toDate) {
      clauses.push('a.scheduled_date <= ?');
      params.push(toDate);
    }
    if (status) {
      clauses.push('a.status = ?');
      params.push(status);
    }
    return db
      .prepare(
        `SELECT a.*, l.lead_number, l.full_name AS customer_name, l.phone AS customer_phone, l.requested_service
         FROM appointments a
         JOIN leads l ON l.id = a.lead_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY a.scheduled_date ASC, a.time_window ASC`
      )
      .all(...params);
  }

  function createAppointment({ leadId, scheduledDate, timeWindow, instructions = '', title = '', owner }) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ?').get(leadId, leadId);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }
    const cleanDate = clean(scheduledDate, 20);
    const cleanWin = clean(timeWindow || '8:00 AM – 12:00 PM', 80);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      const err = new Error('Scheduled pickup date (YYYY-MM-DD) is required.');
      err.status = 400;
      throw err;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const apptTitle = clean(title, 160) || `${lead.requested_service} — ${lead.full_name}`;

    db.prepare(
      `INSERT INTO appointments (
        id, lead_id, customer_id, title, scheduled_date, time_window, timezone, status,
        pickup_address, city, state, zip_code, instructions, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'America/Chicago', 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      lead.id,
      lead.customer_id,
      apptTitle,
      cleanDate,
      cleanWin,
      lead.pickup_address,
      lead.city,
      lead.state,
      lead.zip_code,
      clean(instructions, 1000),
      owner.id,
      now,
      now
    );

    const prevStatus = lead.status;
    db.prepare(
      `UPDATE leads
       SET scheduled_pickup_at = ?,
           status = CASE WHEN status IN ('New', 'Unread', 'Contacted', 'Awaiting Customer Information', 'Estimate Being Prepared', 'Estimate Sent') THEN 'Pickup Scheduled' ELSE status END,
           is_unread = 0,
           last_activity_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(`${cleanDate} (${cleanWin} CT)`, now, now, lead.id);

    const updatedLead = db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id);
    if (updatedLead.status !== prevStatus) {
      db.prepare(
        `INSERT INTO lead_status_history (id, lead_id, previous_status, new_status, changed_by_id, changed_by_name, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), lead.id, prevStatus, updatedLead.status, owner.id, owner.displayName, `Appointment scheduled for ${cleanDate}`, now);
    }

    recordLeadEvent({
      leadId: lead.id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType: 'pickup_scheduled',
      summary: `Pickup appointment scheduled for ${cleanDate} (${cleanWin} America/Chicago).`,
      metadata: { appointmentId: id, scheduledDate: cleanDate, timeWindow: cleanWin }
    });

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'appointment.created',
      entityType: 'appointment',
      entityId: id,
      metadata: { leadId: lead.id, leadNumber: lead.lead_number, scheduledDate: cleanDate }
    });

    realtime.broadcast('appointment.updated', { appointmentId: id, leadId: lead.id, status: 'scheduled' });
    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  }

  function updateAppointment({ appointmentId, patch = {}, owner }) {
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) {
      const err = new Error('Appointment not found.');
      err.status = 404;
      throw err;
    }
    const now = new Date().toISOString();
    const newDate = patch.scheduledDate ? clean(patch.scheduledDate, 20) : appt.scheduled_date;
    const newWin = patch.timeWindow ? clean(patch.timeWindow, 80) : appt.time_window;
    const newInstr = patch.instructions !== undefined ? clean(patch.instructions, 1000) : appt.instructions;
    const newStatus =
      patch.status && ['scheduled', 'in_progress', 'completed', 'cancelled'].includes(patch.status)
        ? patch.status
        : appt.status;

    db.prepare(
      `UPDATE appointments
       SET scheduled_date = ?, time_window = ?, instructions = ?, status = ?,
           completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
           cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) ELSE cancelled_at END,
           updated_at = ?
       WHERE id = ?`
    ).run(newDate, newWin, newInstr, newStatus, newStatus, now, newStatus, now, now, appointmentId);

    if (newStatus === 'completed') {
      updateLeadStatus({ leadId: appt.lead_id, newStatus: 'Completed', note: 'Pickup appointment marked completed', owner });
    } else {
      db.prepare('UPDATE leads SET scheduled_pickup_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?').run(
        newStatus === 'cancelled' ? null : `${newDate} (${newWin} CT)`,
        now,
        now,
        appt.lead_id
      );
      recordLeadEvent({
        leadId: appt.lead_id,
        actorId: owner.id,
        actorLabel: owner.displayName,
        eventType: 'appointment_updated',
        summary: `Pickup appointment updated (${newDate}, ${newWin}, status: ${newStatus}).`
      });
    }

    realtime.broadcast('appointment.updated', { appointmentId, leadId: appt.lead_id, status: newStatus });
    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  }

  function deleteAppointment(appointmentId, owner) {
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) {
      const err = new Error('Appointment not found.');
      err.status = 404;
      throw err;
    }
    db.prepare('DELETE FROM appointments WHERE id = ?').run(appointmentId);
    const nextActive = db
      .prepare(
        "SELECT scheduled_date, time_window FROM appointments WHERE lead_id = ? AND status IN ('scheduled', 'in_progress') ORDER BY scheduled_date ASC LIMIT 1"
      )
      .get(appt.lead_id);
    const now = new Date().toISOString();
    db.prepare('UPDATE leads SET scheduled_pickup_at = ?, updated_at = ? WHERE id = ?').run(
      nextActive ? `${nextActive.scheduled_date} (${nextActive.time_window} CT)` : null,
      now,
      appt.lead_id
    );
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'appointment.deleted',
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: { leadId: appt.lead_id, scheduledDate: appt.scheduled_date }
    });
    if (checkpointDatabase) checkpointDatabase();
    realtime.broadcast('appointment.deleted', { appointmentId, leadId: appt.lead_id });
    return { ok: true, leadId: appt.lead_id };
  }

  function listCustomers({ q = '', page = 1, pageSize = 30 } = {}) {
    const clauses = ['merged_into_id IS NULL'];
    const params = [];
    if (q) {
      const t = `%${String(q).trim()}%`;
      clauses.push('(full_name LIKE ? OR phone_display LIKE ? OR email LIKE ? OR city LIKE ? OR primary_address LIKE ?)');
      params.push(t, t, t, t, t);
    }
    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(100, Math.max(1, Number(pageSize || 30)));
    const offset = (safePage - 1) * safeLimit;

    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${clauses.join(' AND ')}`).get(...params).n);
    const customers = db
      .prepare(`SELECT * FROM customers WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, offset)
      .map((c) => {
        const svcs = db
          .prepare('SELECT DISTINCT requested_service FROM leads WHERE customer_id = ?')
          .all(c.id)
          .map((r) => r.requested_service);
        return { ...c, previousServices: svcs };
      });

    return {
      total,
      page: safePage,
      pageSize: safeLimit,
      customers,
      duplicateSuggestions: findDuplicateSuggestions()
    };
  }

  function findDuplicateSuggestions() {
    const active = db.prepare('SELECT * FROM customers WHERE merged_into_id IS NULL ORDER BY created_at ASC').all();
    const suggestions = [];
    const seenPairs = new Set();

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const reasons = [];
        if (a.phone_normalized && a.phone_normalized === b.phone_normalized) reasons.push('Matching telephone number');
        if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) reasons.push('Matching email address');
        if (
          a.primary_address &&
          b.primary_address &&
          a.primary_address.toLowerCase() === b.primary_address.toLowerCase() &&
          a.zip_code === b.zip_code
        ) {
          reasons.push('Matching pickup street address');
        }
        if (reasons.length > 0) {
          const key = `${a.id}:${b.id}`;
          if (!seenPairs.has(key)) {
            seenPairs.add(key);
            suggestions.push({ primary: a, duplicate: b, reasons });
          }
        }
      }
    }
    return suggestions;
  }

  function getCustomerDetail(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      const err = new Error('Customer not found.');
      err.status = 404;
      throw err;
    }
    const leads = db.prepare('SELECT * FROM leads WHERE customer_id = ? ORDER BY created_at DESC').all(customerId).map(mapLeadSummary);
    const appointments = db.prepare('SELECT * FROM appointments WHERE customer_id = ? ORDER BY scheduled_date DESC').all(customerId);
    return { customer, leads, appointments };
  }

  function updateCustomerRecord({ customerId, patch = {}, owner }) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      const err = new Error('Customer not found.');
      err.status = 404;
      throw err;
    }
    const now = new Date().toISOString();
    const firstName = patch.firstName !== undefined ? clean(patch.firstName, 80) : customer.first_name;
    const lastName = patch.lastName !== undefined ? clean(patch.lastName, 80) : customer.last_name;
    const fullName = `${firstName} ${lastName}`.trim() || customer.full_name;
    const phoneNorm = patch.phone !== undefined ? normalizePhone(patch.phone) : customer.phone_normalized;
    const phoneDisp = patch.phone !== undefined ? formatPhoneDisplay(phoneNorm) : customer.phone_display;
    const email = patch.email !== undefined ? clean(patch.email, 160).toLowerCase() || null : customer.email;
    const address = patch.primaryAddress !== undefined ? clean(patch.primaryAddress, 240) : customer.primary_address;
    const city = patch.city !== undefined ? clean(patch.city, 100) : customer.city;
    const state = patch.state !== undefined ? clean(patch.state, 10) : customer.state;
    const zipCode = patch.zipCode !== undefined ? clean(patch.zipCode, 15) : customer.zip_code;
    const notes = patch.notes !== undefined ? clean(patch.notes, 2000) : customer.notes;

    db.prepare(
      `UPDATE customers
       SET first_name = ?, last_name = ?, full_name = ?, phone_normalized = ?, phone_display = ?,
           email = ?, primary_address = ?, city = ?, state = ?, zip_code = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(firstName, lastName, fullName, phoneNorm, phoneDisp, email, address, city, state, zipCode, notes, now, customerId);

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: customerId
    });
    realtime.broadcast('customer.updated', { customerId });
    return getCustomerDetail(customerId);
  }

  function mergeCustomers({ targetCustomerId, sourceCustomerId, confirmed, owner }) {
    if (!confirmed) {
      const err = new Error('Manual customer merge requires explicit owner confirmation (`confirmed: true`).');
      err.status = 400;
      throw err;
    }
    if (targetCustomerId === sourceCustomerId) {
      const err = new Error('Cannot merge a customer record into itself.');
      err.status = 400;
      throw err;
    }
    const target = db.prepare('SELECT * FROM customers WHERE id = ? AND merged_into_id IS NULL').get(targetCustomerId);
    const source = db.prepare('SELECT * FROM customers WHERE id = ? AND merged_into_id IS NULL').get(sourceCustomerId);
    if (!target || !source) {
      const err = new Error('Both customer records must exist and be active.');
      err.status = 404;
      throw err;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE leads SET customer_id = ?, updated_at = ? WHERE customer_id = ?').run(target.id, now, source.id);
    db.prepare('UPDATE appointments SET customer_id = ?, updated_at = ? WHERE customer_id = ?').run(target.id, now, source.id);
    db.prepare('UPDATE customers SET merged_into_id = ?, updated_at = ? WHERE id = ?').run(target.id, now, source.id);

    const totalInq = Number(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE customer_id = ?').get(target.id).n);
    const compCount = Number(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE customer_id = ? AND status = 'Completed'").get(target.id).n);
    const mergedNotes = [target.notes, source.notes ? `[Merged from ${source.full_name}]: ${source.notes}` : ''].filter(Boolean).join('\n');

    db.prepare(
      `UPDATE customers
       SET email = COALESCE(email, ?),
           total_inquiries = ?,
           completed_pickups = ?,
           notes = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(source.email, totalInq, compCount, mergedNotes, now, target.id);

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'customer.merged',
      entityType: 'customer',
      entityId: target.id,
      metadata: { mergedSourceId: source.id, sourceName: source.full_name }
    });

    realtime.broadcast('customer.updated', { customerId: target.id, mergedSourceId: source.id });
    return getCustomerDetail(target.id);
  }

  async function deleteLead(idOrNumber, owner, { skipCompact = false } = {}) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? OR lead_number = ? LIMIT 1').get(idOrNumber, idOrNumber);
    if (!lead) {
      const err = new Error('Lead not found.');
      err.status = 404;
      throw err;
    }

    const atts = db.prepare('SELECT * FROM lead_attachments WHERE lead_id = ?').all(lead.id);
    let mediaBytesFreed = 0;
    for (const att of atts) {
      await storage.deleteObject(att.storage_key, att.preview_key);
      mediaBytesFreed += Number(att.byte_size || 0);
    }

    db.prepare('DELETE FROM notifications WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);

    // Clean up or recalculate parent customer record
    let customerDeleted = false;
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(lead.customer_id);
    if (cust) {
      const remainingLeads = Number(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE customer_id = ?').get(cust.id).n);
      if (remainingLeads === 0) {
        db.prepare('DELETE FROM appointments WHERE customer_id = ?').run(cust.id);
        db.prepare('DELETE FROM customers WHERE merged_into_id = ?').run(cust.id);
        db.prepare('DELETE FROM customers WHERE id = ?').run(cust.id);
        customerDeleted = true;
      } else {
        const compCount = Number(
          db.prepare("SELECT COUNT(*) AS n FROM leads WHERE customer_id = ? AND status = 'Completed'").get(cust.id).n
        );
        db.prepare('UPDATE customers SET total_inquiries = ?, completed_pickups = ?, updated_at = ? WHERE id = ?').run(
          remainingLeads,
          compCount,
          new Date().toISOString(),
          cust.id
        );
      }
    }

    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'lead.deleted',
      entityType: 'lead',
      entityId: lead.id,
      metadata: {
        leadNumber: lead.lead_number,
        fullName: lead.full_name,
        mediaFilesDeleted: atts.length,
        mediaBytesFreed,
        customerDeleted
      }
    });

    let reclaimedDbBytes = 0;
    if (!skipCompact) {
      sweepOrphanMedia();
      refreshStorageAlertBaseline();
      if (compactDatabase) reclaimedDbBytes = compactDatabase().reclaimedBytes;
    }

    realtime.broadcast('lead.deleted', { leadId: lead.id, leadNumber: lead.lead_number });
    return {
      ok: true,
      leadId: lead.id,
      leadNumber: lead.lead_number,
      mediaFilesDeleted: atts.length,
      mediaBytesFreed,
      customerDeleted,
      reclaimedDbBytes
    };
  }

  async function bulkDeleteLeads({ leadIds = [], statuses = [], all = false, owner }) {
    let targetRows = [];
    if (all === true) {
      targetRows = db.prepare('SELECT id FROM leads').all();
    } else if (Array.isArray(statuses) && statuses.length > 0) {
      const validStatuses = statuses.filter((s) => PIPELINE_STATUSES.includes(s));
      if (validStatuses.length) {
        const ph = validStatuses.map(() => '?').join(',');
        targetRows = db.prepare(`SELECT id FROM leads WHERE status IN (${ph})`).all(...validStatuses);
      }
    } else if (Array.isArray(leadIds) && leadIds.length > 0) {
      const ph = leadIds.map(() => '?').join(',');
      targetRows = db
        .prepare(`SELECT id FROM leads WHERE id IN (${ph}) OR lead_number IN (${ph})`)
        .all(...leadIds, ...leadIds);
    }

    let deletedLeads = 0;
    let mediaFilesDeleted = 0;
    let mediaBytesFreed = 0;
    let customersDeleted = 0;

    for (const r of targetRows) {
      const res = await deleteLead(r.id, owner, { skipCompact: true });
      deletedLeads++;
      mediaFilesDeleted += res.mediaFilesDeleted;
      mediaBytesFreed += res.mediaBytesFreed;
      if (res.customerDeleted) customersDeleted++;
    }

    if (all === true) {
      db.prepare('DELETE FROM appointments').run();
      const extraCust = db.prepare('DELETE FROM customers').run();
      customersDeleted += Number(extraCust?.changes || 0);
    }

    db.prepare('DELETE FROM lead_seq WHERE id < (SELECT MAX(id) FROM lead_seq)').run();
    const orphan = sweepOrphanMedia();
    refreshStorageAlertBaseline();
    const compact = compactDatabase ? compactDatabase() : { reclaimedBytes: 0 };

    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'leads.bulk_deleted',
      entityType: 'lead',
      metadata: {
        deletedLeads,
        customersDeleted,
        mediaFilesDeleted: mediaFilesDeleted + orphan.filesDeleted,
        mediaBytesFreed: mediaBytesFreed + orphan.bytesFreed
      }
    });
    realtime.broadcast('lead.deleted', { bulk: true, deletedLeads });

    return {
      ok: true,
      deletedLeads,
      customersDeleted,
      mediaFilesDeleted: mediaFilesDeleted + orphan.filesDeleted,
      mediaBytesFreed: mediaBytesFreed + orphan.bytesFreed,
      reclaimedDbBytes: compact.reclaimedBytes
    };
  }

  async function deleteCustomer({ customerId, confirmed, owner }) {
    if (!confirmed) {
      const err = new Error('Customer deletion requires explicit confirmation.');
      err.status = 400;
      throw err;
    }
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!cust) {
      const err = new Error('Customer not found.');
      err.status = 404;
      throw err;
    }

    const custLeads = db.prepare('SELECT id FROM leads WHERE customer_id = ?').all(customerId);
    let mediaFilesDeleted = 0;
    let mediaBytesFreed = 0;
    for (const l of custLeads) {
      const res = await deleteLead(l.id, owner, { skipCompact: true });
      mediaFilesDeleted += res.mediaFilesDeleted;
      mediaBytesFreed += res.mediaBytesFreed;
    }

    // Remove customer and any merged-source rows if not already removed by deleteLead
    db.prepare('DELETE FROM appointments WHERE customer_id = ?').run(customerId);
    db.prepare('DELETE FROM customers WHERE merged_into_id = ?').run(customerId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);

    const orphan = sweepOrphanMedia();
    refreshStorageAlertBaseline();
    const compact = compactDatabase ? compactDatabase() : { reclaimedBytes: 0 };

    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'customer.deleted',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        fullName: cust.full_name,
        deletedLeads: custLeads.length,
        mediaFilesDeleted: mediaFilesDeleted + orphan.filesDeleted,
        mediaBytesFreed: mediaBytesFreed + orphan.bytesFreed
      }
    });
    realtime.broadcast('customer.deleted', { customerId });

    return {
      ok: true,
      customerId,
      deletedLeads: custLeads.length,
      mediaFilesDeleted: mediaFilesDeleted + orphan.filesDeleted,
      mediaBytesFreed: mediaBytesFreed + orphan.bytesFreed,
      reclaimedDbBytes: compact.reclaimedBytes
    };
  }

  async function deleteCustomerPii({ customerId, confirmed, owner }) {
    if (!confirmed) {
      const err = new Error('Customer deletion/redaction requires explicit confirmation.');
      err.status = 400;
      throw err;
    }
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!cust) {
      const err = new Error('Customer not found.');
      err.status = 404;
      throw err;
    }
    const custLeads = db.prepare('SELECT id FROM leads WHERE customer_id = ?').all(customerId);
    for (const l of custLeads) {
      const atts = db.prepare('SELECT * FROM lead_attachments WHERE lead_id = ?').all(l.id);
      for (const att of atts) {
        await storage.deleteObject(att.storage_key, att.preview_key);
      }
      db.prepare('DELETE FROM lead_attachments WHERE lead_id = ?').run(l.id);
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE customers
       SET first_name = 'Redacted', last_name = 'Customer', full_name = 'Redacted Customer',
           phone_normalized = '0000000000', phone_display = 'Redacted', email = NULL,
           primary_address = 'Redacted per privacy request', notes = '', updated_at = ?
       WHERE id = ?`
    ).run(now, customerId);
    db.prepare(
      `UPDATE leads
       SET first_name = 'Redacted', last_name = 'Customer', full_name = 'Redacted Customer',
           phone = 'Redacted', phone_normalized = '0000000000', email = NULL,
           pickup_address = 'Redacted per privacy request', matched_address = '', address_unit = '',
           geo_lat = NULL, geo_lng = NULL, access_instructions = '', customer_notes = '',
           photo_count = 0, video_count = 0, pending_upload_count = 0,
           status = 'Archived', updated_at = ?
       WHERE customer_id = ?`
    ).run(now, customerId);

    refreshStorageAlertBaseline();
    if (compactDatabase) compactDatabase();

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'customer.privacy_redacted',
      entityType: 'customer',
      entityId: customerId
    });
    return { ok: true };
  }

  function getDashboardOverview() {
    cleanupExpiredUploadSessions();
    const todayStr = chicagoDate();
    const weekAgoStr = chicagoDate(new Date(Date.now() - 6 * 86400000));
    const monthPrefix = todayStr.slice(0, 7);

    const kpis = {
      totalLeads: countSql("SELECT COUNT(*) AS n FROM leads WHERE status != 'Spam'"),
      newLeads: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'New'"),
      unreadLeads: countSql("SELECT COUNT(*) AS n FROM leads WHERE is_unread = 1 AND status NOT IN ('Spam', 'Archived')"),
      leadsAwaitingContact: countSql("SELECT COUNT(*) AS n FROM leads WHERE status IN ('New', 'Unread')"),
      quotesAwaitingResponse: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Estimate Sent'"),
      scheduledPickups: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Pickup Scheduled'"),
      inProgressJobs: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Pickup In Progress'"),
      completedJobs: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Completed'"),
      lostOpportunities: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Not Converted'"),
      leadsToday: countSql('SELECT COUNT(*) AS n FROM leads WHERE substr(created_at, 1, 10) = ?', todayStr),
      leadsThisWeek: countSql('SELECT COUNT(*) AS n FROM leads WHERE substr(created_at, 1, 10) >= ?', weekAgoStr),
      leadsThisMonth: countSql('SELECT COUNT(*) AS n FROM leads WHERE substr(created_at, 1, 7) = ?', monthPrefix),
      pendingCustomerUploads: countSql("SELECT COUNT(*) AS n FROM file_upload_sessions WHERE status = 'open'"),
      totalRegisteredCustomers: countSql('SELECT COUNT(*) AS n FROM customers WHERE merged_into_id IS NULL'),
      activeServiceAreas: countSql("SELECT COUNT(*) AS n FROM municipalities WHERE coverage_status = 'active'")
    };

    const thirtyDaysAgo = chicagoDate(new Date(Date.now() - 29 * 86400000));
    const leadsOverTime = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS label, COUNT(*) AS value
         FROM leads
         WHERE substr(created_at, 1, 10) >= ?
         GROUP BY substr(created_at, 1, 10)
         ORDER BY label ASC`
      )
      .all(thirtyDaysAgo);

    const leadSources = db
      .prepare(
        `SELECT
           CASE
             WHEN utm_source != '' THEN 'Campaign: ' || utm_source
             WHEN source_page_path != '' THEN source_page_path
             ELSE source_type
           END AS label,
           COUNT(*) AS value
         FROM leads
         GROUP BY label
         ORDER BY value DESC
         LIMIT 8`
      )
      .all();

    const submissionsByLocation = db
      .prepare(
        `SELECT (city || ', ' || state) AS label, COUNT(*) AS value
         FROM leads
         GROUP BY city, state
         ORDER BY value DESC
         LIMIT 10`
      )
      .all();

    const serviceRequests = db
      .prepare(
        `SELECT requested_service AS label, COUNT(*) AS value
         FROM leads
         GROUP BY requested_service
         ORDER BY value DESC
         LIMIT 10`
      )
      .all();

    const residentialVsCommercial = db
      .prepare(
        `SELECT customer_type AS label, COUNT(*) AS value
         FROM leads
         GROUP BY customer_type`
      )
      .all();

    const electronicsVsGeneralJunk = db
      .prepare(
        `SELECT CASE WHEN has_electronics = 1 THEN 'Includes Electronics / E-Waste' ELSE 'General Junk & Cleanout Only' END AS label,
                COUNT(*) AS value
         FROM leads
         GROUP BY has_electronics`
      )
      .all();

    const newVsCompleted = [
      { label: 'New / Awaiting Action', value: kpis.leadsAwaitingContact },
      { label: 'In Pipeline', value: Math.max(0, kpis.totalLeads - kpis.leadsAwaitingContact - kpis.completedJobs - kpis.lostOpportunities) },
      { label: 'Completed Jobs', value: kpis.completedJobs },
      { label: 'Not Converted', value: kpis.lostOpportunities }
    ].filter((x) => x.value > 0);

    const mobileVsDesktop = db
      .prepare(
        `SELECT device_category AS label, COUNT(*) AS value
         FROM leads
         GROUP BY device_category`
      )
      .all();

    const totalSessions30d = countSql(
      "SELECT COUNT(DISTINCT session_bucket) AS n FROM web_events WHERE substr(created_at, 1, 10) >= ? AND is_test_data = 0",
      thirtyDaysAgo
    );
    const leads30d = countSql('SELECT COUNT(*) AS n FROM leads WHERE substr(created_at, 1, 10) >= ?', thirtyDaysAgo);
    const conversionRates = [
      {
        label: 'Visitor-to-Lead (30d)',
        value: totalSessions30d > 0 ? Number(((leads30d / totalSessions30d) * 100).toFixed(2)) : 0,
        denominator: totalSessions30d
      },
      {
        label: 'Lead-to-Estimate Sent',
        value:
          kpis.totalLeads > 0
            ? Number(
                (
                  (countSql(
                    "SELECT COUNT(*) AS n FROM leads WHERE status IN ('Estimate Sent', 'Pickup Scheduled', 'Pickup In Progress', 'Completed')"
                  ) /
                    kpis.totalLeads) *
                  100
                ).toFixed(1)
              )
            : 0,
        denominator: kpis.totalLeads
      },
      {
        label: 'Lead-to-Completed Job',
        value: kpis.totalLeads > 0 ? Number(((kpis.completedJobs / kpis.totalLeads) * 100).toFixed(1)) : 0,
        denominator: kpis.totalLeads
      }
    ];

    const recentLeads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 8').all().map(mapLeadSummary);
    const recentActivity = db
      .prepare(
        `SELECT e.*, l.lead_number
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         ORDER BY e.created_at DESC
         LIMIT 12`
      )
      .all();

    return {
      generatedAt: new Date().toISOString(),
      timezone: 'America/Chicago',
      kpis,
      charts: {
        leadsOverTime,
        leadSources,
        submissionsByLocation,
        serviceRequests,
        residentialVsCommercial,
        electronicsVsGeneralJunk,
        newVsCompleted,
        mobileVsDesktop,
        conversionRates
      },
      recentLeads,
      recentActivity
    };
  }

  function listBackupsSummary() {
    if (!existsSync(paths.backupsDir)) return { count: 0, totalBytes: 0, files: [] };
    const files = readdirSync(paths.backupsDir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => {
        const st = statSync(join(paths.backupsDir, f));
        return { filename: f, byteSize: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const totalBytes = files.reduce((sum, f) => sum + f.byteSize, 0);
    return { count: files.length, totalBytes, files };
  }

  function getCapacityStatus() {
    const s = getSettings();
    const mediaBytes = totalActiveMediaBytes();
    const diskBytes = storage.totalDiskBytes();
    const databaseBytes = dbSizeBytes();
    const backupsInfo = listBackupsSummary();
    const storageQuota = Number(s.storage_quota_bytes || 1024 * 1024 * 1024);
    const dbQuota = Number(s.db_quota_bytes || 500 * 1024 * 1024);
    const egressQuota = Number(s.egress_quota_bytes || 5 * 1024 * 1024 * 1024);
    const monthlyEgress = Number(s.monthly_egress_bytes || 0);

    const activeAttachments = countSql("SELECT COUNT(*) AS n FROM lead_attachments WHERE deletion_status = 'active'");
    const failedUploads = countSql('SELECT COALESCE(SUM(failed_uploads), 0) AS n FROM file_upload_sessions');
    const pendingUploads = countSql("SELECT COUNT(*) AS n FROM file_upload_sessions WHERE status = 'open'");
    const notificationErrors = countSql("SELECT COUNT(*) AS n FROM notifications WHERE delivery_status = 'failed'");

    const closedMediaRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(a.byte_size), 0) AS bytes
         FROM lead_attachments a
         JOIN leads l ON l.id = a.lead_id
         WHERE a.deletion_status = 'active'
           AND l.status IN ('Completed', 'Not Converted', 'Archived', 'Spam')`
      )
      .get();

    const breakdown = {
      totalVaultBytes: (diskBytes || mediaBytes) + databaseBytes + backupsInfo.totalBytes,
      backupsCount: backupsInfo.count,
      backupsBytes: backupsInfo.totalBytes,
      allLeadsCount: countSql('SELECT COUNT(*) AS n FROM leads'),
      trashLeadsCount: countSql("SELECT COUNT(*) AS n FROM leads WHERE status IN ('Spam', 'Archived', 'Not Converted')"),
      completedLeadsCount: countSql("SELECT COUNT(*) AS n FROM leads WHERE status = 'Completed'"),
      customersCount: countSql('SELECT COUNT(*) AS n FROM customers WHERE merged_into_id IS NULL'),
      closedMediaCount: Number(closedMediaRow?.cnt || 0),
      closedMediaBytes: Number(closedMediaRow?.bytes || 0),
      webEventsCount: countSql('SELECT COUNT(*) AS n FROM web_events'),
      searchSnapshotsCount: countSql('SELECT COUNT(*) AS n FROM analytics_snapshots'),
      notificationsCount: countSql('SELECT COUNT(*) AS n FROM notifications'),
      auditLogsCount: countSql('SELECT COUNT(*) AS n FROM admin_audit_logs'),
      softDeletedMediaCount: countSql("SELECT COUNT(*) AS n FROM lead_attachments WHERE deletion_status != 'active'")
    };

    const storagePct = storageQuota > 0 ? Number(((mediaBytes / storageQuota) * 100).toFixed(2)) : 0;
    const dbPct = dbQuota > 0 ? Number(((databaseBytes / dbQuota) * 100).toFixed(2)) : 0;
    const egressPct = egressQuota > 0 ? Number(((monthlyEgress / egressQuota) * 100).toFixed(2)) : 0;

    let alertLevel = 'healthy';
    if (storagePct >= Number(s.quota_warn_95 || 95)) alertLevel = 'critical_95';
    else if (storagePct >= Number(s.quota_warn_85 || 85)) alertLevel = 'high_85';
    else if (storagePct >= Number(s.quota_warn_70 || 70)) alertLevel = 'warning_70';

    return {
      storageProvider: storage.name,
      storageBucket: storage.bucket,
      alertLevel,
      thresholds: {
        warn70: Number(s.quota_warn_70 || 70),
        warn85: Number(s.quota_warn_85 || 85),
        warn95: Number(s.quota_warn_95 || 95)
      },
      database: {
        usedBytes: databaseBytes,
        quotaBytes: dbQuota,
        usedPct: dbPct,
        remainingBytes: Math.max(0, dbQuota - databaseBytes)
      },
      mediaStorage: {
        activeOriginalBytes: mediaBytes,
        totalVaultBytesIncludingPreviews: diskBytes || mediaBytes,
        quotaBytes: storageQuota,
        usedPct: storagePct,
        remainingBytes: Math.max(0, storageQuota - mediaBytes),
        activeAttachmentCount: activeAttachments
      },
      egress: {
        period: s.egress_period,
        monthlyEgressBytes: monthlyEgress,
        quotaBytes: egressQuota,
        usedPct: egressPct
      },
      health: {
        failedUploads,
        pendingUploads,
        notificationErrors
      },
      breakdown
    };
  }

  function createDatabaseBackup(owner) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(paths.backupsDir, `zoiris-crm-backup-${stamp}.sqlite`);
    db.exec('PRAGMA wal_checkpoint(FULL);');
    copyFileSync(paths.dbFile, dest);
    const size = statSync(dest).size;
    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'database.backup_created',
      entityType: 'backup',
      entityId: `zoiris-crm-backup-${stamp}.sqlite`,
      metadata: { byteSize: size }
    });
    return { filename: `zoiris-crm-backup-${stamp}.sqlite`, byteSize: size, createdAt: new Date().toISOString() };
  }

  function deleteBackup(filename, owner) {
    const cleanName = String(filename || '').trim();
    if (!/^[a-zA-Z0-9._-]+\.sqlite$/.test(cleanName)) {
      const err = new Error('Invalid backup filename.');
      err.status = 400;
      throw err;
    }
    const full = resolve(paths.backupsDir, cleanName);
    if (!full.startsWith(resolve(paths.backupsDir)) || !existsSync(full)) {
      const err = new Error('Backup file not found.');
      err.status = 404;
      throw err;
    }
    const byteSize = statSync(full).size;
    unlinkSync(full);
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'database.backup_deleted',
      entityType: 'backup',
      entityId: cleanName,
      metadata: { byteSize }
    });
    return { ok: true, filename: cleanName, bytesFreed: byteSize };
  }

  function deleteAllBackups(owner) {
    const info = listBackupsSummary();
    let bytesFreed = 0;
    let deletedCount = 0;
    for (const f of info.files) {
      const full = resolve(paths.backupsDir, f.filename);
      if (full.startsWith(resolve(paths.backupsDir)) && existsSync(full)) {
        unlinkSync(full);
        bytesFreed += f.byteSize;
        deletedCount++;
      }
    }
    logAudit({
      actorId: owner?.id || null,
      actorEmail: owner?.email || null,
      action: 'database.backups_cleared',
      entityType: 'backup',
      metadata: { deletedCount, bytesFreed }
    });
    return { ok: true, deletedCount, bytesFreed };
  }

  async function cleanupStorage({ scopes = [], owner }) {
    const scopeSet = new Set(Array.isArray(scopes) ? scopes : []);
    const summary = {
      deletedLeads: 0,
      deletedCustomers: 0,
      deletedMediaFiles: 0,
      deletedBackups: 0,
      clearedEvents: 0,
      clearedSnapshots: 0,
      clearedNotifications: 0,
      clearedLogs: 0,
      bytesFreed: 0
    };

    const beforeTotal = getCapacityStatus().breakdown.totalVaultBytes;

    if (scopeSet.has('all_leads_customers')) {
      const r = await bulkDeleteLeads({ all: true, owner });
      summary.deletedLeads += r.deletedLeads;
      summary.deletedCustomers += r.customersDeleted;
      summary.deletedMediaFiles += r.mediaFilesDeleted;
    } else {
      if (scopeSet.has('spam_archived')) {
        const r = await bulkDeleteLeads({ statuses: ['Spam', 'Archived', 'Not Converted'], owner });
        summary.deletedLeads += r.deletedLeads;
        summary.deletedCustomers += r.customersDeleted;
        summary.deletedMediaFiles += r.mediaFilesDeleted;
      }
      if (scopeSet.has('completed_leads')) {
        const r = await bulkDeleteLeads({ statuses: ['Completed'], owner });
        summary.deletedLeads += r.deletedLeads;
        summary.deletedCustomers += r.customersDeleted;
        summary.deletedMediaFiles += r.mediaFilesDeleted;
      }
    }

    if (scopeSet.has('all_media')) {
      const r = await bulkDeleteMedia({ filter: 'all', owner });
      summary.deletedMediaFiles += r.deletedCount;
    } else if (scopeSet.has('closed_media')) {
      const r = await bulkDeleteMedia({ filter: 'closed_leads', owner });
      summary.deletedMediaFiles += r.deletedCount;
    }

    if (scopeSet.has('backups')) {
      const r = deleteAllBackups(owner);
      summary.deletedBackups += r.deletedCount;
    }

    if (scopeSet.has('analytics')) {
      summary.clearedEvents += Number(db.prepare('DELETE FROM web_events').run()?.changes || 0);
      summary.clearedSnapshots += Number(db.prepare('DELETE FROM analytics_snapshots').run()?.changes || 0);
      setSetting('monthly_egress_bytes', 0, owner?.id || null);
    }

    if (scopeSet.has('logs')) {
      summary.clearedNotifications += Number(db.prepare('DELETE FROM notifications').run()?.changes || 0);
      summary.clearedLogs += Number(db.prepare('DELETE FROM login_attempts').run()?.changes || 0);
      summary.clearedLogs += Number(
        db.prepare('DELETE FROM owner_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?').run(new Date().toISOString())?.changes || 0
      );
      summary.clearedLogs += Number(db.prepare('DELETE FROM owner_recovery_tokens').run()?.changes || 0);
      summary.clearedLogs += Number(db.prepare('DELETE FROM admin_audit_logs').run()?.changes || 0);
    }

    cleanupExpiredUploadSessions();
    db.prepare("DELETE FROM file_upload_sessions WHERE status IN ('completed', 'expired', 'revoked')").run();
    db.prepare('DELETE FROM lead_seq WHERE id < (SELECT MAX(id) FROM lead_seq)').run();

    const orphan = sweepOrphanMedia();
    summary.deletedMediaFiles += orphan.filesDeleted;
    refreshStorageAlertBaseline();

    if (compactDatabase) compactDatabase();

    const afterCap = getCapacityStatus();
    summary.bytesFreed = Math.max(0, beforeTotal - afterCap.breakdown.totalVaultBytes);

    if (!scopeSet.has('logs')) {
      logAudit({
        actorId: owner?.id || null,
        actorEmail: owner?.email || null,
        action: 'storage.cleaned',
        entityType: 'storage',
        metadata: { scopes: [...scopeSet], ...summary }
      });
      if (checkpointDatabase) checkpointDatabase();
    }

    return {
      ok: true,
      summary,
      capacity: getCapacityStatus(),
      backups: listBackupsSummary().files
    };
  }

  function exportLeadsCsv() {
    const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
    const headers = [
      'lead_number',
      'status',
      'priority',
      'created_at',
      'full_name',
      'phone',
      'email',
      'customer_type',
      'pickup_address',
      'city',
      'state',
      'zip_code',
      'requested_service',
      'has_electronics',
      'estimated_quantity',
      'photo_count',
      'video_count',
      'estimate_dollars',
      'scheduled_pickup_at',
      'source_page_path',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'device_category'
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
      const vals = [
        r.lead_number,
        r.status,
        r.priority,
        r.created_at,
        r.full_name,
        r.phone,
        r.email || '',
        r.customer_type,
        r.pickup_address,
        r.city,
        r.state,
        r.zip_code,
        r.requested_service,
        r.has_electronics ? 'yes' : 'no',
        r.estimated_quantity || '',
        r.photo_count,
        r.video_count,
        r.estimate_cents !== null ? (r.estimate_cents / 100).toFixed(2) : '',
        r.scheduled_pickup_at || '',
        r.source_page_path || '',
        r.utm_source || '',
        r.utm_medium || '',
        r.utm_campaign || '',
        r.device_category || ''
      ];
      lines.push(vals.map(csvEscape).join(','));
    }
    return lines.join('\n') + '\n';
  }

  function exportSingleLeadJson(idOrNumber, owner) {
    const detail = getLeadDetail(idOrNumber, owner, { markOpened: false });
    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'lead.exported',
      entityType: 'lead',
      entityId: detail.lead.id,
      metadata: { leadNumber: detail.lead.leadNumber }
    });
    recordLeadEvent({
      leadId: detail.lead.id,
      actorId: owner.id,
      actorLabel: owner.displayName,
      eventType: 'lead_exported',
      summary: `Lead record exported by ${owner.displayName}.`
    });
    return detail;
  }

  function recordLeadEvent({ leadId, actorId = null, actorLabel, eventType, summary, metadata = {} }) {
    db.prepare(
      `INSERT INTO lead_events (id, lead_id, actor_id, actor_label, event_type, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), leadId, actorId, actorLabel, eventType, summary, JSON.stringify(metadata), new Date().toISOString());
  }

  function countSql(sql, ...params) {
    return Number(db.prepare(sql).get(...params)?.n || 0);
  }

  function listMapPins({ includeClosed = false } = {}) {
    const rows = db
      .prepare(
        `SELECT * FROM leads
         WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
           AND status NOT IN ('Spam', 'Archived' ${includeClosed ? '' : ", 'Completed', 'Not Converted'"})
         ORDER BY created_at DESC
         LIMIT 300`
      )
      .all();
    return rows.map(mapLeadSummary);
  }

  return {
    publicUploadLimits,
    submitCustomerInquiry,
    uploadCustomerMedia,
    completeUploadSession,
    cleanupExpiredUploadSessions,
    mintSignedMediaUrl,
    deleteLeadAttachment,
    deleteAllLeadMedia,
    bulkDeleteMedia,
    sweepOrphanMedia,
    listLeads,
    getPipelineBoard,
    getLeadDetail,
    updateLeadStatus,
    updateLeadFields,
    deleteLead,
    bulkDeleteLeads,
    addLeadNote,
    deleteLeadNote,
    createFollowUpTask,
    updateFollowUpTask,
    deleteFollowUpTask,
    listAppointments,
    createAppointment,
    updateAppointment,
    deleteAppointment,
    listCustomers,
    getCustomerDetail,
    updateCustomerRecord,
    mergeCustomers,
    deleteCustomer,
    deleteCustomerPii,
    getDashboardOverview,
    getCapacityStatus,
    listBackupsSummary,
    createDatabaseBackup,
    deleteBackup,
    deleteAllBackups,
    cleanupStorage,
    exportLeadsCsv,
    exportSingleLeadJson,
    listMapPins
  };
}

function mapLeadSummary(r) {
  return {
    id: r.id,
    leadNumber: r.lead_number,
    customerId: r.customer_id,
    status: r.status,
    priority: r.priority,
    isUnread: !!r.is_unread,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    customerType: r.customer_type,
    city: r.city,
    state: r.state,
    zipCode: r.zip_code,
    requestedService: r.requested_service,
    itemCategories: safeParseJson(r.item_categories_json, []),
    hasElectronics: !!r.has_electronics,
    photoCount: r.photo_count,
    videoCount: r.video_count,
    pendingUploadCount: r.pending_upload_count,
    sourcePagePath: r.source_page_path,
    deviceCategory: r.device_category,
    estimateCents: r.estimate_cents,
    scheduledPickupAt: r.scheduled_pickup_at,
    followUpAt: r.follow_up_at,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    pickupAddress: r.pickup_address,
    addressUnit: r.address_unit || '',
    addressStatus: r.address_status || 'unverified',
    lat: r.geo_lat ?? null,
    lng: r.geo_lng ?? null,
    countyName: r.county_name || '',
    spamScore: Number(r.spam_score || 0),
    spamFlags: safeParseJson(r.spam_flags_json, []),
    needsReview: Number(r.spam_score || 0) >= 35 || (r.address_status || 'unverified') === 'unverified'
  };
}

function mapLeadFull(r) {
  return {
    ...mapLeadSummary(r),
    firstName: r.first_name,
    lastName: r.last_name,
    preferredContact: r.preferred_contact,
    pickupAddress: r.pickup_address,
    countySlug: r.county_slug,
    locationSlug: r.location_slug,
    neighborhoodSlug: r.neighborhood_slug,
    itemDescription: r.item_description,
    otherItemDescription: r.other_item_description,
    estimatedQuantity: r.estimated_quantity,
    estimatedDimensions: r.estimated_dimensions,
    indoorsOrOutdoors: r.indoors_or_outdoors,
    floorLevel: r.floor_level,
    hasStairs: r.has_stairs,
    elevatorAvailable: r.elevator_available,
    disassembledStatus: r.disassembled_status,
    accessInstructions: r.access_instructions,
    preferredDate: r.preferred_date,
    preferredWindow: r.preferred_window,
    customerNotes: r.customer_notes,
    estimateNotes: r.estimate_notes,
    completionStatus: r.completion_status,
    completedAt: r.completed_at,
    openedAt: r.opened_at,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    servicePageSlug: r.service_page_slug,
    locationPageSlug: r.location_page_slug,
    referrerUrl: r.referrer_url,
    utmSource: r.utm_source,
    utmMedium: r.utm_medium,
    utmCampaign: r.utm_campaign,
    matchedAddress: r.matched_address || '',
    addressSource: r.address_source || '',
    countyFips: r.county_fips || ''
  };
}

function safeParseJson(str, fallback) {
  try {
    return JSON.parse(str || '');
  } catch {
    return fallback;
  }
}

export function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
