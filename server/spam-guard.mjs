/**
 * server/spam-guard.mjs
 * Layered protection so only genuine pickup requests reach the owner's inbox.
 *
 *  Hard blocks (request rejected with a friendly message + phone fallback):
 *   - Fake / fictional / impossible US phone numbers (555-01xx, 000, repeated or sequential digits)
 *   - Disposable "throwaway" email domains, or email domains that cannot receive mail (DNS MX)
 *   - Names containing links or no letters at all
 *   - Promotional / SEO / crypto spam with links (score >= 70)
 *
 *  Soft flags (request saved, but marked "Needs review" in the Command Center):
 *   - Submitted faster than a person can fill the form, toll-free numbers, unusual scripts, etc.
 */
import { promises as dns } from 'node:dns';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'tempmailo.com', 'tempail.com', 'tempr.email',
  'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'dispostable.com',
  'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'emailondeck.com', 'mohmal.com',
  'burnermail.io', 'mailnesia.com', 'mailcatch.com', 'spamgourmet.com', 'moakt.com', 'tmail.ws', 'tmpmail.org',
  'tmpmail.net', 'inboxkitten.com', 'mail.tm', 'mailpoof.com', 'spambox.us', 'discard.email', 'fakemail.net',
  'emailfake.com', 'byom.de', 'one-time.email', 'mytemp.email', 'trbvm.com', 'example.com', 'example.org', 'test.com'
]);

const PROMO_PATTERNS = [
  /\bseo\b/i, /backlinks?/i, /guest\s*post/i, /first page of google/i, /rank(ing)? (higher|#?1)/i,
  /web\s*design/i, /website (redesign|traffic)/i, /digital marketing/i, /marketing (services|agency)/i,
  /lead generation/i, /increase (your )?(sales|traffic)/i, /crypto|bitcoin|forex|binary option/i,
  /casino|betting|viagra|cialis|cbd oil/i, /loan (offer|approval)/i, /whats\s?app|telegram/i,
  /unsubscribe/i, /dear (sir|madam|business owner)/i, /\bdomain\b.*\b(expir|renew)/i
];

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ru|xyz|info|biz|top|site|online|shop)\b)/gi;
const URL_TEST = new RegExp(URL_RE.source, 'i');

export function checkUsPhone(raw = '') {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return { ok: false, reason: 'Enter a 10-digit US phone number.' };
  const area = d.slice(0, 3);
  const exch = d.slice(3, 6);
  const line = d.slice(6);
  if (/^[01]/.test(area) || /^[01]/.test(exch)) return { ok: false, reason: 'That phone number is not a valid US number.' };
  if (/^(\d)\1{9}$/.test(d) || d === '1234567890' || d === '0123456789' || d === '9876543210') {
    return { ok: false, reason: 'Please enter your real phone number so we can reach you.' };
  }
  if (exch === '555' && /^01\d\d$/.test(line)) return { ok: false, reason: '555-01xx numbers are fictional. Please enter your real phone number.' };
  if (/^\d11$/.test(area)) return { ok: false, reason: 'That phone number is not a valid US number.' };
  const tollFree = ['800', '833', '844', '855', '866', '877', '888'].includes(area);
  return { ok: true, digits: d, tollFree };
}

async function emailDomainAcceptsMail(domain, mode) {
  if (mode === 'mock') return true;
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))
    ]);
    if (Array.isArray(mx) && mx.length) return true;
    return false;
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
      // Some small domains only publish an A record and still accept mail.
      try {
        const a = await dns.resolve4(domain);
        return a.length > 0;
      } catch {
        return false;
      }
    }
    return true; // DNS trouble on our side — never punish the customer for it
  }
}

/**
 * @returns {Promise<{ blocked: boolean, message?: string, fieldErrors: Record<string,string>, score: number, flags: string[] }>}
 */
export async function screenSubmission(body = {}, { mode = process.env.ZOIRIS_GEOCODER || 'live' } = {}) {
  const fieldErrors = {};
  const flags = [];
  let score = 0;

  // Phone
  const phone = checkUsPhone(body.phone || '');
  if (!phone.ok) fieldErrors.phone = phone.reason;
  else if (phone.tollFree) {
    flags.push('Toll-free phone number');
    score += 15;
  }

  // Names
  for (const key of ['firstName', 'lastName']) {
    const v = String(body[key] || '');
    if (!v.trim()) continue;
    if (URL_TEST.test(v)) {
      fieldErrors[key] = 'Names cannot contain links.';
    } else if (!/\p{L}/u.test(v)) {
      fieldErrors[key] = 'Please enter your real name.';
    }
  }

  // Email (optional)
  const email = String(body.email || '').trim().toLowerCase();
  if (email) {
    const domain = email.split('@')[1] || '';
    if (DISPOSABLE_DOMAINS.has(domain)) {
      fieldErrors.email = 'Please use an email you actually check (temporary inboxes are not accepted), or leave it blank.';
    } else if (domain && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !(await emailDomainAcceptsMail(domain, mode))) {
      fieldErrors.email = "That email domain can't receive mail. Check the spelling or leave it blank.";
    }
  }

  // Free-text content
  const text = ['itemDescription', 'otherItemDescription', 'accessInstructions', 'customerNotes']
    .map((k) => String(body[k] || ''))
    .join(' \n ');
  const urlCount = (text.match(URL_RE) || []).length;
  if (urlCount) {
    flags.push(`${urlCount} link(s) in message`);
    score += Math.min(2, urlCount) * 35;
  }
  let promoHits = 0;
  for (const re of PROMO_PATTERNS) if (re.test(text)) promoHits++;
  if (promoHits) {
    flags.push(`Promotional wording (${promoHits})`);
    score += Math.min(3, promoHits) * 25;
  }
  if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(text + (body.firstName || '') + (body.lastName || ''))) {
    flags.push('Unusual character set');
    score += 15;
  }

  // Human timing — the form records when the visitor started it
  const startedAt = Number(body.formStartedAt || 0);
  if (startedAt > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 0 && elapsed < 5000) {
      flags.push('Submitted in under 5 seconds');
      score += 45;
    }
  } else if (body.source === 'zoiris-website') {
    flags.push('Missing form timing');
    score += 10;
  }

  score = Math.min(100, score);
  const blocked = score >= 70;
  return {
    blocked,
    message: blocked
      ? 'This request looks automated or promotional, so it was not sent. If you need a pickup, please call 251-930-8621.'
      : undefined,
    fieldErrors,
    score,
    flags
  };
}
