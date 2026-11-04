/**
 * server/realtime.mjs
 * Authenticated owner-only Server-Sent Events (SSE) hub + notification engine
 * (Dashboard live notifications, optional Email provider, optional SMS provider,
 * accurate delivery states, and retry queue).
 *
 * Security invariant:
 *  - Public visitors can NEVER subscribe to SSE channels.
 *  - Email/SMS notifications never claim "sent" unless confirmed by a configured
 *    provider's HTTP 2xx response.
 *  - Notification failures NEVER block or roll back customer lead persistence.
 */
import { randomUUID } from 'node:crypto';

export function createRealtimeAndNotifications({ ctx }) {
  const { db } = ctx;
  const clients = new Map(); // clientId -> { res, ownerId }

  const heartbeatTimer = setInterval(() => {
    for (const [id, client] of clients.entries()) {
      try {
        client.res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clients.delete(id);
      }
    }
  }, 20000);
  heartbeatTimer.unref?.();

  function addSseClient(res, owner) {
    const clientId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Robots-Tag': 'noindex, nofollow'
    });
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        clientId,
        connectedAt: new Date().toISOString(),
        unreadLeads: countUnreadLeads(),
        unreadNotifications: countUnreadNotifications()
      })}\n\n`
    );
    clients.set(clientId, { res, ownerId: owner.id });
    res.on('close', () => clients.delete(clientId));
    return clientId;
  }

  function broadcast(eventType, payload = {}) {
    const envelope = JSON.stringify({
      type: eventType,
      at: new Date().toISOString(),
      unreadLeads: countUnreadLeads(),
      unreadNotifications: countUnreadNotifications(),
      payload
    });
    for (const [id, client] of clients.entries()) {
      try {
        client.res.write(`event: message\ndata: ${envelope}\n\n`);
      } catch {
        clients.delete(id);
      }
    }
  }

  function countUnreadLeads() {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE is_unread = 1 AND status NOT IN ('Spam', 'Archived')").get().n);
  }

  function countUnreadNotifications() {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE channel = 'in_app' AND is_read = 0").get().n);
  }

  async function notifyOwners({ kind, title, body, leadId = null }) {
    const now = new Date().toISOString();
    const owners = db.prepare('SELECT id, email FROM owner_profiles WHERE is_active = 1').all();

    // Always record an internal notification even before the first owner logs in
    if (owners.length === 0) {
      db.prepare(
        `INSERT INTO notifications (id, owner_id, lead_id, kind, title, body, channel, delivery_status, is_read, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, 'in_app', 'unread', 0, ?, ?)`
      ).run(randomUUID(), leadId, kind, title, body, now, now);
      broadcast('notification.created', { kind, title, body, leadId });
      return;
    }

    for (const owner of owners) {
      const prefs =
        db.prepare('SELECT * FROM notification_preferences WHERE owner_id = ?').get(owner.id) || {
          in_app_enabled: 1,
          email_enabled: 0,
          sms_enabled: 0,
          notify_new_lead: 1,
          notify_new_upload: 1,
          notify_storage_alert: 1
        };

      if (kind === 'new_lead' && !prefs.notify_new_lead) continue;
      if (kind === 'new_upload' && !prefs.notify_new_upload) continue;
      if (kind === 'storage_alert' && !prefs.notify_storage_alert) continue;

      if (prefs.in_app_enabled) {
        db.prepare(
          `INSERT INTO notifications (id, owner_id, lead_id, kind, title, body, channel, delivery_status, is_read, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_app', 'unread', 0, ?, ?)`
        ).run(randomUUID(), owner.id, leadId, kind, title, body, now, now);
      }

      if (prefs.email_enabled) {
        await dispatchEmailNotification({
          ownerId: owner.id,
          to: prefs.email_address || process.env.EMAIL_NOTIFICATION_ADDRESS || owner.email,
          leadId,
          kind,
          title,
          body
        });
      }

      if (prefs.sms_enabled) {
        await dispatchSmsNotification({
          ownerId: owner.id,
          to: prefs.sms_phone || process.env.SMS_NOTIFICATION_TO || '',
          leadId,
          kind,
          title,
          body
        });
      }
    }

    broadcast('notification.created', { kind, title, body, leadId });
  }

  async function dispatchEmailNotification({ ownerId, to, leadId, kind, title, body, existingId = null, retryCount = 0 }) {
    const id = existingId || randomUUID();
    const now = new Date().toISOString();
    const apiKey = process.env.EMAIL_PROVIDER_API_KEY || '';
    const fromAddr = process.env.EMAIL_FROM_ADDRESS || 'notifications@zoirisjunkremoval.com';

    if (!apiKey || !to) {
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'email',
        deliveryStatus: 'skipped_unconfigured',
        errorMessage: 'EMAIL_PROVIDER_API_KEY or recipient address not configured.',
        retryCount,
        nextRetryAt: null,
        now
      });
      return { status: 'skipped_unconfigured' };
    }

    try {
      const endpoint = process.env.EMAIL_API_ENDPOINT || 'https://api.resend.com/emails';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [to],
          subject: `[Zoiris Command Center] ${title}`,
          text: body
        })
      });
      if (!res.ok) throw new Error(`Email provider HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'email',
        deliveryStatus: 'sent',
        providerMessageId: data.id || 'ok',
        errorMessage: null,
        retryCount,
        nextRetryAt: null,
        now
      });
      return { status: 'sent' };
    } catch (err) {
      const nextRetry = retryCount < 3 ? new Date(Date.now() + (retryCount + 1) * 5 * 60000).toISOString() : null;
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'email',
        deliveryStatus: 'failed',
        errorMessage: String(err.message || err).slice(0, 240),
        retryCount: retryCount + 1,
        nextRetryAt: nextRetry,
        now
      });
      return { status: 'failed', error: String(err.message || err) };
    }
  }

  async function dispatchSmsNotification({ ownerId, to, leadId, kind, title, body, existingId = null, retryCount = 0 }) {
    const id = existingId || randomUUID();
    const now = new Date().toISOString();
    const sid = process.env.SMS_TWILIO_ACCOUNT_SID || '';
    const token = process.env.SMS_TWILIO_AUTH_TOKEN || '';
    const from = process.env.SMS_TWILIO_FROM || '';

    if (!sid || !token || !from || !to) {
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'sms',
        deliveryStatus: 'skipped_unconfigured',
        errorMessage: 'Twilio SMS credentials not configured.',
        retryCount,
        nextRetryAt: null,
        now
      });
      return { status: 'skipped_unconfigured' };
    }

    try {
      const params = new URLSearchParams({ From: from, To: to, Body: `${title}: ${body}`.slice(0, 300) });
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      if (!res.ok) throw new Error(`SMS provider HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'sms',
        deliveryStatus: 'sent',
        providerMessageId: data.sid || 'ok',
        errorMessage: null,
        retryCount,
        nextRetryAt: null,
        now
      });
      return { status: 'sent' };
    } catch (err) {
      const nextRetry = retryCount < 3 ? new Date(Date.now() + (retryCount + 1) * 5 * 60000).toISOString() : null;
      upsertNotificationRow({
        id,
        ownerId,
        leadId,
        kind,
        title,
        body,
        channel: 'sms',
        deliveryStatus: 'failed',
        errorMessage: String(err.message || err).slice(0, 240),
        retryCount: retryCount + 1,
        nextRetryAt: nextRetry,
        now
      });
      return { status: 'failed', error: String(err.message || err) };
    }
  }

  function upsertNotificationRow({
    id,
    ownerId,
    leadId,
    kind,
    title,
    body,
    channel,
    deliveryStatus,
    providerMessageId = null,
    errorMessage = null,
    retryCount = 0,
    nextRetryAt = null,
    now
  }) {
    db.prepare(
      `INSERT INTO notifications (id, owner_id, lead_id, kind, title, body, channel, delivery_status, provider_message_id, error_message, retry_count, next_retry_at, is_read, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         delivery_status = excluded.delivery_status,
         provider_message_id = excluded.provider_message_id,
         error_message = excluded.error_message,
         retry_count = excluded.retry_count,
         next_retry_at = excluded.next_retry_at,
         updated_at = excluded.updated_at`
    ).run(id, ownerId, leadId, kind, title, body, channel, deliveryStatus, providerMessageId, errorMessage, retryCount, nextRetryAt, now, now);
  }

  async function retryFailedNotifications() {
    const due = db
      .prepare(
        `SELECT * FROM notifications
         WHERE delivery_status = 'failed' AND retry_count < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?)
         LIMIT 20`
      )
      .all(new Date().toISOString());

    const results = [];
    for (const n of due) {
      const prefs = n.owner_id ? db.prepare('SELECT * FROM notification_preferences WHERE owner_id = ?').get(n.owner_id) : null;
      if (n.channel === 'email') {
        results.push(
          await dispatchEmailNotification({
            ownerId: n.owner_id,
            to: prefs?.email_address || process.env.EMAIL_NOTIFICATION_ADDRESS || '',
            leadId: n.lead_id,
            kind: n.kind,
            title: n.title,
            body: n.body,
            existingId: n.id,
            retryCount: n.retry_count
          })
        );
      } else if (n.channel === 'sms') {
        results.push(
          await dispatchSmsNotification({
            ownerId: n.owner_id,
            to: prefs?.sms_phone || process.env.SMS_NOTIFICATION_TO || '',
            leadId: n.lead_id,
            kind: n.kind,
            title: n.title,
            body: n.body,
            existingId: n.id,
            retryCount: n.retry_count
          })
        );
      }
    }
    return results;
  }

  function closeAll() {
    clearInterval(heartbeatTimer);
    for (const c of clients.values()) {
      try {
        c.res.end();
      } catch {
        // ignore
      }
    }
    clients.clear();
  }

  return {
    addSseClient,
    broadcast,
    notifyOwners,
    retryFailedNotifications,
    countUnreadLeads,
    countUnreadNotifications,
    closeAll
  };
}
