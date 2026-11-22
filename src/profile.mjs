// PT profile/contact helpers (launch settings). display_name is pts.brand_name;
// bio is pts.about. New contact columns live on pts and are nullable.
import { httpError } from './util.mjs';
import { email as validEmail, text } from './validate.mjs';

const WRITABLE = new Set([
  'display_name', 'business_name', 'bio', 'photo_url', 'contact_email', 'contact_phone',
  'reply_to_email', 'reply_to_name', 'venue_name', 'venue_address', 'cancellation_window_hours',
  'published'
]);

const CONTROL = /[\r\n\u0000-\u001f\u007f]/g;

function blank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function failed(fields) {
  const message = Object.values(fields)[0] || 'Check the highlighted fields.';
  throw httpError(400, message, { code: 'VALIDATION_FAILED', fields });
}

function optionalText(value, label, max) {
  if (blank(value)) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be 1–${max} characters.`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new Error(`${label} must be 1–${max} characters.`);
  return trimmed;
}

function optionalEmail(value, label = 'Email') {
  if (blank(value)) return null;
  try { return validEmail(value); }
  catch { throw new Error(`Enter a valid ${label.toLowerCase()}.`); }
}

function optionalPhone(value) {
  if (blank(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Enter a valid phone number.');
  const raw = String(value).trim();
  if (raw.length < 7 || raw.length > 32 || !/^\+?[0-9() .\-]+$/.test(raw)) throw new Error('Enter a valid phone number.');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new Error('Enter a valid phone number.');
  return raw;
}

function optionalHttpsUrl(value) {
  if (blank(value)) return null;
  if (typeof value !== 'string') throw new Error('Enter a valid https photo URL.');
  const raw = value.trim();
  if (raw.length > 500) throw new Error('Photo URL must be 500 characters or fewer.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Enter a valid https photo URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('Photo URL must be an https link.');
  }
  return raw;
}

function optionalWindow(value) {
  if (blank(value) && value !== 0) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0 || n > 720) throw new Error('Cancellation window must be a whole number of hours from 0 to 720.');
  return n;
}

/** Validate a partial body. Unknown or read-only fields (including slug) are rejected. */
export function profilePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid request.');
  const unknown = Object.keys(body).filter(k => !WRITABLE.has(k));
  const fields = {};
  if (unknown.length) {
    for (const key of unknown) {
      fields[key] = key === 'slug' ? 'The page address cannot be changed here.' : 'This field cannot be updated.';
    }
  }
  const patch = {};
  const set = (key, fn) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return;
    try { patch[key] = fn(); }
    catch (error) { fields[key] = error.message || `Check ${key}.`; }
  };
  set('display_name', () => text(body.display_name, 'Display name', 70, 3));
  set('business_name', () => optionalText(body.business_name, 'Business name', 160));
  set('bio', () => text(body.bio, 'Bio', 1200, 10));
  set('photo_url', () => optionalHttpsUrl(body.photo_url));
  set('contact_email', () => optionalEmail(body.contact_email, 'contact email'));
  set('contact_phone', () => optionalPhone(body.contact_phone));
  set('reply_to_email', () => optionalEmail(body.reply_to_email, 'reply-to email'));
  set('reply_to_name', () => optionalText(body.reply_to_name, 'Reply-to name', 80));
  set('venue_name', () => optionalText(body.venue_name, 'Venue name', 160));
  set('venue_address', () => optionalText(body.venue_address, 'Venue address', 400));
  set('cancellation_window_hours', () => optionalWindow(body.cancellation_window_hours));
  set('published', () => (body.published ? 1 : 0));
  if (Object.keys(fields).length) failed(fields);
  return patch;
}

export function applyProfilePatch(row, patch) {
  const next = { ...row };
  if (patch.display_name !== undefined) next.brand_name = patch.display_name;
  if (patch.bio !== undefined) next.about = patch.bio;
  for (const key of [
    'business_name', 'photo_url', 'contact_email', 'contact_phone', 'reply_to_email',
    'reply_to_name', 'venue_name', 'venue_address', 'cancellation_window_hours', 'published'
  ]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

/** Private settings payload (unset nullable fields are null). */
export function ptProfile(pt) {
  return {
    id: pt.id,
    display_name: pt.brand_name,
    business_name: pt.business_name ?? null,
    bio: pt.about,
    photo_url: pt.photo_url ?? null,
    contact_email: pt.contact_email ?? null,
    contact_phone: pt.contact_phone ?? null,
    reply_to_email: pt.reply_to_email ?? null,
    reply_to_name: pt.reply_to_name ?? null,
    venue_name: pt.venue_name ?? null,
    venue_address: pt.venue_address ?? null,
    cancellation_window_hours: pt.cancellation_window_hours ?? null,
    slug: pt.slug,
    published: Boolean(pt.published)
  };
}

export function profileMissing(pt) {
  const missing = [];
  if (blank(pt.business_name)) missing.push('business_name');
  if (blank(pt.contact_email)) missing.push('contact_email');
  return missing;
}

/** Public contact fields only. Null or blank values are omitted; reply_to_* is never included. */
export function publicContactFields(pt) {
  const out = {};
  if (!blank(pt.brand_name)) out.display_name = pt.brand_name;
  if (!blank(pt.business_name)) out.business_name = pt.business_name.trim();
  if (!blank(pt.contact_email)) out.contact_email = pt.contact_email;
  if (!blank(pt.contact_phone)) out.contact_phone = String(pt.contact_phone).trim();
  if (!blank(pt.venue_name)) out.venue_name = pt.venue_name.trim();
  if (!blank(pt.venue_address)) out.venue_address = pt.venue_address.trim();
  if (pt.cancellation_window_hours != null && pt.cancellation_window_hours !== '') {
    const n = Number(pt.cancellation_window_hours);
    if (Number.isInteger(n)) out.cancellation_window_hours = n;
  }
  return out;
}

export async function readPtProfile(db, user) {
  if (user?.role !== 'pt' || !user.pt_id) throw httpError(403, 'Your account does not have access to this action.');
  const pt = await db.get('SELECT * FROM pts WHERE id=?', user.pt_id);
  if (!pt) throw httpError(404, 'Trainer not found.');
  return { pt: ptProfile(pt) };
}

/** Strip CR/LF and other controls so they cannot be used for email header injection. */
export function sanitizeHeader(value) {
  if (value == null) return '';
  return String(value).replace(CONTROL, '').trim();
}

function cleanEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 160 && !/[<>]/.test(value);
}

/** Reply-To for Resend: custom address when valid, otherwise the PT login email. */
export function replyToForSend({ replyToEmail, replyToName, loginEmail } = {}) {
  const login = sanitizeHeader(loginEmail);
  const email = sanitizeHeader(replyToEmail);
  const name = sanitizeHeader(replyToName).replace(/[<>"]/g, '').trim();
  const chosen = cleanEmail(email) ? email : (cleanEmail(login) ? login : '');
  if (!chosen) return undefined;
  return name ? `${name} <${chosen}>` : chosen;
}
