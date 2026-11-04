/**
 * server/auth.mjs
 * Owner-only authentication, session management, inactivity expiration,
 * TOTP MFA, brute-force rate limiting, CSRF protection, and account recovery.
 *
 * Security invariants:
 *  - No public registration endpoint exists.
 *  - No hardcoded administrator credentials exist anywhere in the codebase.
 *  - Initial owner account can ONLY be created via `scripts/provision-owner.mjs`
 *    or `POST /api/auth/setup` when 0 owner accounts exist AND `OWNER_SETUP_SECRET`
 *    is configured and supplied.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  buildOtpAuthUri,
  decryptSecret,
  encryptSecret,
  generateBase32Secret,
  generateRecoveryCodes,
  hashPassword,
  safeEqualStrings,
  sha256Hex,
  verifyPassword,
  verifyTotp
} from './crypto-totp.mjs';

export const SESSION_COOKIE = 'zoiris_owner_session';
export const REMEMBER_DEVICE_MINUTES = 30 * 24 * 60; // 30 days persistent multi-device sign-in
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;

export function describeDevice(userAgent = '', deviceHint = null) {
  const ua = String(userAgent || '');
  const hint = deviceHint && typeof deviceHint === 'object' ? deviceHint : {};
  const touchPoints = Number(hint.maxTouchPoints || 0);

  let device = 'Web Browser';
  let kind = 'desktop';

  if (/iPhone|iPod/i.test(ua)) {
    device = 'iPhone';
    kind = 'phone';
  } else if (/iPad/i.test(ua) || (/Macintosh|Mac OS X/i.test(ua) && touchPoints > 1)) {
    device = 'iPad';
    kind = 'tablet';
  } else if (/Android/i.test(ua)) {
    if (/Mobile/i.test(ua)) {
      device = 'Android Phone';
      kind = 'phone';
    } else {
      device = 'Android Tablet';
      kind = 'tablet';
    }
  } else if (/CrOS/i.test(ua)) {
    device = 'Chromebook';
    kind = 'desktop';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    device = 'Mac';
    kind = 'desktop';
  } else if (/Windows/i.test(ua)) {
    device = 'Windows PC';
    kind = 'desktop';
  } else if (/Linux/i.test(ua)) {
    device = 'Linux Computer';
    kind = 'desktop';
  } else if (hint.platform) {
    device = String(hint.platform).slice(0, 40);
  }

  let browser = '';
  if (/EdgA?\/|EdgiOS\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser\//i.test(ua)) browser = 'Samsung Internet';
  else if (/CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/FxiOS\/|Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|HeadlessChrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  const base = browser ? `${device} · ${browser}` : device;
  const label = hint.standalone ? `${base} (App)` : base;
  return { label: label.slice(0, 120), kind };
}

export function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeSessionCookie(token, maxAgeSeconds, isSecure = false) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function validatePasswordStrength(password) {
  const s = String(password || '');
  if (s.length < 12) return 'Password must be at least 12 characters long.';
  if (!/[a-z]/i.test(s) || !/\d/.test(s)) return 'Password must include both letters and numbers.';
  return null;
}

export function createAuthManager({ ctx, masterKey }) {
  const { db, getSettings, logAudit } = ctx;

  function ownerCount() {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM owner_profiles').get().n);
  }

  function ipBucket(ip = '') {
    return sha256Hex(`ip:${ip || 'local'}`).slice(0, 24);
  }

  function isRateLimited(email, ip) {
    const cutoff = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60000).toISOString();
    const byEmail = Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND succeeded = 0 AND attempted_at >= ?')
        .get(String(email || '').toLowerCase(), cutoff).n
    );
    const byIp = Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip_bucket = ? AND succeeded = 0 AND attempted_at >= ?')
        .get(ipBucket(ip), cutoff).n
    );
    return byEmail >= MAX_FAILED_ATTEMPTS || byIp >= MAX_FAILED_ATTEMPTS;
  }

  function recordAttempt(email, ip, succeeded) {
    db.prepare('INSERT INTO login_attempts (identifier, ip_bucket, succeeded, attempted_at) VALUES (?, ?, ?, ?)').run(
      String(email || '').toLowerCase(),
      ipBucket(ip),
      succeeded ? 1 : 0,
      new Date().toISOString()
    );
  }

  function provisionFirstOwner({ email, displayName, password, setupSecret, allowCliBypass = false }) {
    if (ownerCount() > 0) {
      const err = new Error('An owner account is already provisioned. Use authenticated security settings to manage accounts.');
      err.status = 409;
      throw err;
    }
    if (!allowCliBypass) {
      const expected = process.env.OWNER_SETUP_SECRET || '';
      if (!expected || expected.length < 16) {
        const err = new Error(
          'Initial web setup is locked because OWNER_SETUP_SECRET is not configured on the server. Run `npm run owner:provision` on the server or set OWNER_SETUP_SECRET (16+ chars).'
        );
        err.status = 403;
        throw err;
      }
      if (!safeEqualStrings(expected, String(setupSecret || ''))) {
        const err = new Error('Invalid OWNER_SETUP_SECRET.');
        err.status = 403;
        throw err;
      }
    }
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(displayName || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      const err = new Error('Enter a valid owner email address.');
      err.status = 400;
      throw err;
    }
    if (cleanName.length < 2) {
      const err = new Error('Enter the owner display name.');
      err.status = 400;
      throw err;
    }
    const pwErr = validatePasswordStrength(password);
    if (pwErr) {
      const err = new Error(pwErr);
      err.status = 400;
      throw err;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO owner_profiles (id, email, display_name, role, password_hash, mfa_enabled, recovery_codes_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', ?, 0, '[]', 1, ?, ?)`
    ).run(id, cleanEmail, cleanName, hashPassword(password), now, now);

    db.prepare(
      `INSERT INTO notification_preferences (owner_id, in_app_enabled, sound_enabled, desktop_enabled, email_enabled, email_address, updated_at)
       VALUES (?, 1, 0, 0, ?, ?, ?)`
    ).run(id, process.env.EMAIL_NOTIFICATION_ADDRESS ? 1 : 0, process.env.EMAIL_NOTIFICATION_ADDRESS || cleanEmail, now);

    logAudit({
      actorId: id,
      actorEmail: cleanEmail,
      action: 'owner.provisioned',
      entityType: 'owner_profile',
      entityId: id,
      metadata: { method: allowCliBypass ? 'cli' : 'setup_secret' }
    });

    return { id, email: cleanEmail, displayName: cleanName, role: 'owner' };
  }

  function createSession(owner, reqMeta = {}, mfaVerified = true) {
    const settings = getSettings();
    const rememberDevice = reqMeta.rememberDevice !== false;
    const idleMinutes = rememberDevice
      ? REMEMBER_DEVICE_MINUTES
      : Math.max(5, Number(settings.session_idle_minutes || 480));
    const rawToken = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(24).toString('hex');
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expIso = new Date(now + idleMinutes * 60000).toISOString();
    const sessionId = randomUUID();
    const dev = describeDevice(reqMeta.userAgent || '', reqMeta.deviceHint || null);

    db.prepare(
      `INSERT INTO owner_sessions (
         id, owner_id, token_hash, csrf_token, user_agent, ip_hint, mfa_verified,
         device_label, device_kind, remember_device, created_at, last_active_at, expires_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      owner.id,
      sha256Hex(rawToken),
      csrfToken,
      String(reqMeta.userAgent || '').slice(0, 180),
      ipBucket(reqMeta.ip || '').slice(0, 12),
      mfaVerified ? 1 : 0,
      dev.label,
      dev.kind,
      rememberDevice ? 1 : 0,
      nowIso,
      nowIso,
      expIso
    );

    const activeRow = db
      .prepare('SELECT COUNT(*) AS n FROM owner_sessions WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(owner.id, nowIso);

    return {
      sessionId,
      rawToken,
      csrfToken,
      idleSeconds: idleMinutes * 60,
      expiresAt: expIso,
      deviceLabel: dev.label,
      deviceKind: dev.kind,
      rememberDevice,
      activeDeviceCount: Number(activeRow?.n || 1)
    };
  }

  function login({ email, password, totp, recoveryCode, rememberDevice = true, deviceHint = null, ip = '', userAgent = '' }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (isRateLimited(cleanEmail, ip)) {
      logAudit({
        actorEmail: cleanEmail,
        action: 'auth.rate_limited',
        entityType: 'auth',
        metadata: { lockoutMinutes: LOCKOUT_WINDOW_MINUTES }
      });
      const err = new Error('Too many failed sign-in attempts. Please wait 15 minutes before trying again.');
      err.status = 429;
      throw err;
    }

    const owner = db.prepare('SELECT * FROM owner_profiles WHERE email = ? AND is_active = 1').get(cleanEmail);
    if (!owner || !verifyPassword(password, owner.password_hash)) {
      recordAttempt(cleanEmail, ip, false);
      logAudit({
        actorEmail: cleanEmail,
        action: 'auth.login_failed',
        entityType: 'auth',
        metadata: { reason: 'invalid_credentials' }
      });
      const err = new Error('Invalid email or password.');
      err.status = 401;
      throw err;
    }

    if (owner.mfa_enabled) {
      if (!totp && !recoveryCode) {
        return { mfaRequired: true };
      }
      let mfaOk = false;
      if (totp && owner.mfa_secret_enc) {
        const secret = decryptSecret(owner.mfa_secret_enc, masterKey);
        mfaOk = verifyTotp(secret, totp);
      } else if (recoveryCode) {
        const hashes = JSON.parse(owner.recovery_codes_json || '[]');
        const target = sha256Hex(String(recoveryCode).trim().toUpperCase());
        const idx = hashes.findIndex((h) => safeEqualStrings(h, target));
        if (idx >= 0) {
          hashes.splice(idx, 1);
          db.prepare('UPDATE owner_profiles SET recovery_codes_json = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(hashes),
            new Date().toISOString(),
            owner.id
          );
          mfaOk = true;
        }
      }
      if (!mfaOk) {
        recordAttempt(cleanEmail, ip, false);
        logAudit({
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'auth.mfa_failed',
          entityType: 'auth'
        });
        const err = new Error('Invalid multi-factor authentication code.');
        err.status = 401;
        throw err;
      }
    }

    recordAttempt(cleanEmail, ip, true);
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE owner_profiles SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, owner.id);
    const session = createSession(owner, { ip, userAgent, rememberDevice, deviceHint }, true);

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'auth.login_succeeded',
      entityType: 'owner_session',
      entityId: session.sessionId,
      metadata: { device: session.deviceLabel, rememberDevice: session.rememberDevice }
    });

    return {
      mfaRequired: false,
      session,
      owner: sanitizeOwner(owner)
    };
  }

  function authenticateRequest(req, { requireCsrf = false } = {}) {
    const cookies = parseCookies(req.headers.cookie || '');
    const rawToken = cookies[SESSION_COOKIE];
    if (!rawToken) return null;

    const row = db
      .prepare(
        `SELECT s.*, o.email, o.display_name, o.role, o.mfa_enabled, o.is_active, o.last_login_at
         FROM owner_sessions s
         JOIN owner_profiles o ON o.id = s.owner_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL`
      )
      .get(sha256Hex(rawToken));

    if (!row || !row.is_active) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      return null;
    }

    if (requireCsrf) {
      const headerToken = req.headers['x-zoiris-csrf'] || '';
      if (!safeEqualStrings(String(headerToken), row.csrf_token)) {
        const err = new Error('CSRF token validation failed.');
        err.status = 403;
        throw err;
      }
    }

    // Sliding expiration update — remembered devices stay signed in for 30 days across restarts
    const settings = getSettings();
    const rememberDevice = row.remember_device !== 0;
    const ttlMinutes = rememberDevice
      ? REMEMBER_DEVICE_MINUTES
      : Math.max(5, Number(settings.session_idle_minutes || 480));
    const now = Date.now();
    const newExp = new Date(now + ttlMinutes * 60000).toISOString();
    const parsedDev = row.device_label
      ? { label: row.device_label, kind: row.device_kind || 'desktop' }
      : describeDevice(row.user_agent || req.headers['user-agent'] || '');

    db.prepare('UPDATE owner_sessions SET last_active_at = ?, expires_at = ?, device_label = ?, device_kind = ? WHERE id = ?').run(
      new Date(now).toISOString(),
      newExp,
      parsedDev.label,
      parsedDev.kind,
      row.id
    );

    const activeDeviceCount = Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM owner_sessions WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?')
        .get(row.owner_id, new Date(now).toISOString())?.n || 1
    );

    return {
      sessionId: row.id,
      rawToken,
      csrfToken: row.csrf_token,
      expiresAt: newExp,
      idleSeconds: ttlMinutes * 60,
      rememberDevice,
      deviceLabel: parsedDev.label,
      deviceKind: parsedDev.kind,
      activeDeviceCount,
      owner: {
        id: row.owner_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        mfaEnabled: !!row.mfa_enabled,
        lastLoginAt: row.last_login_at
      }
    };
  }

  function logout(sessionId, actor) {
    if (!sessionId) return;
    db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
    if (actor) {
      logAudit({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'auth.logout',
        entityType: 'owner_session',
        entityId: sessionId
      });
    }
  }

  function revokeOtherSessions(ownerId, keepSessionId) {
    db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND id != ? AND revoked_at IS NULL').run(
      new Date().toISOString(),
      ownerId,
      keepSessionId
    );
  }

  function revokeSessionById(ownerId, targetSessionId, actorEmail = null) {
    const res = db
      .prepare('UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), ownerId, targetSessionId);
    logAudit({
      actorId: ownerId,
      actorEmail,
      action: 'auth.device_revoked',
      entityType: 'owner_session',
      entityId: targetSessionId
    });
    return { ok: true, revoked: Number(res?.changes || 0) > 0 };
  }

  function beginMfaEnrollment(ownerId) {
    const owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerId);
    if (!owner) throw new Error('Owner not found');
    const secret = generateBase32Secret();
    const enc = encryptSecret(secret, masterKey);
    db.prepare('UPDATE owner_profiles SET mfa_pending_secret_enc = ?, updated_at = ? WHERE id = ?').run(
      enc,
      new Date().toISOString(),
      ownerId
    );
    return {
      secret,
      otpauthUri: buildOtpAuthUri({ email: owner.email, secret })
    };
  }

  function confirmMfaEnrollment(ownerId, code) {
    const owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerId);
    if (!owner || !owner.mfa_pending_secret_enc) {
      const err = new Error('No pending MFA setup found.');
      err.status = 400;
      throw err;
    }
    const secret = decryptSecret(owner.mfa_pending_secret_enc, masterKey);
    if (!verifyTotp(secret, code)) {
      const err = new Error('Verification code did not match. Check your authenticator clock and try again.');
      err.status = 400;
      throw err;
    }
    const { plain, hashes } = generateRecoveryCodes(8);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE owner_profiles
       SET mfa_enabled = 1, mfa_secret_enc = ?, mfa_pending_secret_enc = NULL, recovery_codes_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(owner.mfa_pending_secret_enc, JSON.stringify(hashes), now, ownerId);

    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'auth.mfa_enabled',
      entityType: 'owner_profile',
      entityId: owner.id
    });

    return { recoveryCodes: plain };
  }

  function disableMfa(ownerId, password) {
    const owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerId);
    if (!owner || !verifyPassword(password, owner.password_hash)) {
      const err = new Error('Current password is required to disable MFA.');
      err.status = 401;
      throw err;
    }
    db.prepare(
      'UPDATE owner_profiles SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, recovery_codes_json = ?, updated_at = ? WHERE id = ?'
    ).run('[]', new Date().toISOString(), ownerId);
    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'auth.mfa_disabled',
      entityType: 'owner_profile',
      entityId: owner.id
    });
  }

  function changePassword(ownerId, currentPassword, newPassword, keepSessionId) {
    const owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerId);
    if (!owner || !verifyPassword(currentPassword, owner.password_hash)) {
      const err = new Error('Current password is incorrect.');
      err.status = 401;
      throw err;
    }
    const pwErr = validatePasswordStrength(newPassword);
    if (pwErr) {
      const err = new Error(pwErr);
      err.status = 400;
      throw err;
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE owner_profiles SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword),
      now,
      ownerId
    );
    revokeOtherSessions(ownerId, keepSessionId);
    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'auth.password_changed',
      entityType: 'owner_profile',
      entityId: owner.id
    });
  }

  function issueRecoveryToken(email) {
    const owner = db.prepare('SELECT * FROM owner_profiles WHERE email = ? AND is_active = 1').get(String(email || '').trim().toLowerCase());
    if (!owner) return null;
    const raw = randomBytes(24).toString('hex');
    const now = Date.now();
    db.prepare(
      'INSERT INTO owner_recovery_tokens (id, owner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), owner.id, sha256Hex(raw), new Date(now + 15 * 60000).toISOString(), new Date(now).toISOString());
    logAudit({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'auth.recovery_requested',
      entityType: 'owner_profile',
      entityId: owner.id
    });
    return { token: raw, owner };
  }

  function completePasswordRecovery({ token, newPassword }) {
    const pwErr = validatePasswordStrength(newPassword);
    if (pwErr) {
      const err = new Error(pwErr);
      err.status = 400;
      throw err;
    }
    const row = db
      .prepare('SELECT * FROM owner_recovery_tokens WHERE token_hash = ? AND used_at IS NULL')
      .get(sha256Hex(String(token || '').trim()));
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      const err = new Error('Invalid or expired recovery token.');
      err.status = 400;
      throw err;
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE owner_recovery_tokens SET used_at = ? WHERE id = ?').run(now, row.id);
    db.prepare('UPDATE owner_profiles SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword),
      now,
      row.owner_id
    );
    db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL').run(now, row.owner_id);
    logAudit({
      actorId: row.owner_id,
      action: 'auth.recovery_completed',
      entityType: 'owner_profile',
      entityId: row.owner_id
    });
  }

  function listActiveSessions(ownerId) {
    return db
      .prepare(
        `SELECT id, user_agent, ip_hint, device_label, device_kind, remember_device, created_at, last_active_at, expires_at
         FROM owner_sessions
         WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_active_at DESC`
      )
      .all(ownerId, new Date().toISOString())
      .map((r) => {
        const dev = r.device_label ? { label: r.device_label, kind: r.device_kind || 'desktop' } : describeDevice(r.user_agent || '');
        return {
          id: r.id,
          user_agent: r.user_agent,
          ip_hint: r.ip_hint,
          deviceLabel: dev.label,
          deviceKind: dev.kind,
          rememberDevice: r.remember_device !== 0,
          created_at: r.created_at,
          last_active_at: r.last_active_at,
          expires_at: r.expires_at
        };
      });
  }

  return {
    ownerCount,
    provisionFirstOwner,
    login,
    authenticateRequest,
    logout,
    revokeOtherSessions,
    revokeSessionById,
    beginMfaEnrollment,
    confirmMfaEnrollment,
    disableMfa,
    changePassword,
    issueRecoveryToken,
    completePasswordRecovery,
    listActiveSessions
  };
}

function sanitizeOwner(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    mfaEnabled: !!row.mfa_enabled,
    lastLoginAt: row.last_login_at
  };
}
