// Preview-only password gate. Enabled solely when PREVIEW_GATE is exactly "on"
// (set in wrangler.jsonc env.preview). The default/production env must never
// gate, even if PREVIEW_PASSWORD is present. Cron (scheduled()) is not gated.
import crypto from 'node:crypto';
import { createDb } from './db.mjs';
import { rateLimit } from './ratelimit.mjs';

// Same headers as worker/index.mjs securityHeaders (kept here to avoid a cycle).
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

export const GATE_PATH = '/__preview-gate';
export const COOKIE_NAME = 'preview_gate';
export const TTL_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_BODY = 'User-agent: *\nDisallow: /';
const ROBOTS_TAG = 'noindex, nofollow';

export const gateOn = env => env.PREVIEW_GATE === 'on';

function secretsReady(env) {
  return Boolean(env.PREVIEW_PASSWORD) && Boolean(env.PREVIEW_GATE_SECRET);
}

export function withPreviewHeaders(env, response) {
  if (!gateOn(env) || !response) return response;
  response.headers.set('X-Robots-Tag', ROBOTS_TAG);
  return response;
}

export function signPreviewCookie(secret, issuedAt = Date.now()) {
  const ts = String(issuedAt);
  const mac = crypto.createHmac('sha256', secret).update(ts).digest('base64url');
  return `${ts}.${mac}`;
}

export function verifyPreviewCookie(secret, value, now = Date.now()) {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const ts = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d+$/.test(ts)) return false;
  const expected = crypto.createHmac('sha256', secret).update(ts).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const issued = Number(ts);
  if (!Number.isFinite(issued)) return false;
  if (now - issued > TTL_MS || issued > now + 60000) return false;
  return true;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** HMAC both values with the gate secret, then compare the digests in constant time. */
export function passwordsMatch(secret, provided, expected) {
  const a = crypto.createHmac('sha256', secret).update(String(provided ?? '')).digest();
  const b = crypto.createHmac('sha256', secret).update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function setCookie(value) {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

function formPage(message = '') {
  const error = message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Resilience Coaching — Preview</title>
  <style>
    :root{--ink:#141414;--muted:#6c6c6c;--accent:#ffd43b;--line:#e5e5e5}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.65 Arial,Helvetica,sans-serif;color:var(--ink);background:#fff}
    main{width:min(420px,calc(100% - 40px));padding:36px 32px 32px;border:1px solid var(--line);border-radius:14px}
    .brand{display:flex;gap:10px;align-items:center;font-size:16px;font-weight:800;letter-spacing:-.04em;margin-bottom:22px}
    .mark{display:grid;place-items:center;width:32px;height:32px;background:#111;color:var(--accent);border-radius:50%;font-size:18px;font-weight:500}
    h1{font-size:22px;letter-spacing:-.055em;margin:0 0 8px;font-weight:600}
    p{margin:0 0 18px;color:var(--muted)}
    .err{color:#7c2520;background:#ffe6df;border-radius:8px;padding:10px 12px;font-size:13px}
    label{display:block;font-size:12px;font-weight:600}
    input{margin-top:6px;width:100%;border:1px solid #d5d5d5;border-radius:8px;padding:12px 13px;font:inherit}
    button{margin-top:16px;width:100%;border:0;border-radius:8px;padding:14px 19px;background:var(--accent);color:#111;font:inherit;font-weight:600;cursor:pointer}
    button:hover{opacity:.9}
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark">R</span> Resilience Coaching</div>
    <h1>Preview</h1>
    <p>This preview is locked. Enter the preview password to continue.</p>
    ${error}
    <form method="post" action="${GATE_PATH}">
      <label>Password
        <input type="password" name="password" required autocomplete="current-password" autofocus>
      </label>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function htmlResponse(status, body, extra = {}) {
  return new Response(body, { status, headers: { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', ...extra } });
}

function jsonResponse(status, data, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

function wantsJson(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/')) return true;
  const accept = request.headers.get('Accept') || '';
  const type = request.headers.get('Content-Type') || '';
  return type.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
}

function locked(request, message = 'This preview is locked.') {
  if (wantsJson(request) || new URL(request.url).pathname.startsWith('/api/')) {
    return jsonResponse(401, { error: message, code: 'PREVIEW_LOCKED' });
  }
  return htmlResponse(401, formPage(message === 'This preview is locked.' ? '' : message));
}

function failClosed(request) {
  const message = 'Preview gate is misconfigured.';
  if (wantsJson(request) || new URL(request.url).pathname.startsWith('/api/')) {
    return jsonResponse(503, { error: message });
  }
  return htmlResponse(503, formPage(message));
}

async function readPassword(request) {
  const type = request.headers.get('Content-Type') || '';
  const raw = new TextDecoder().decode(await request.arrayBuffer());
  if (type.includes('application/json')) {
    try {
      const body = raw ? JSON.parse(raw) : {};
      return typeof body.password === 'string' ? body.password : '';
    } catch { return ''; }
  }
  const params = Object.fromEntries(new URLSearchParams(raw));
  return typeof params.password === 'string' ? params.password : '';
}

async function unlock(request, env) {
  const provided = await readPassword(request);
  const ok = passwordsMatch(env.PREVIEW_GATE_SECRET, provided, env.PREVIEW_PASSWORD);
  if (!ok) {
    const db = createDb(env.DB);
    const client = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      await rateLimit(db, 'preview-gate', client, { max: 5, windowMs: 15 * 60000 });
    } catch (error) {
      if (error.status === 429) {
        const message = error.message;
        return wantsJson(request)
          ? jsonResponse(429, { error: message, code: 'PREVIEW_LOCKED' })
          : htmlResponse(429, formPage(message));
      }
      throw error;
    }
    return locked(request, 'That password is incorrect.');
  }
  const cookie = setCookie(signPreviewCookie(env.PREVIEW_GATE_SECRET));
  if (wantsJson(request)) return jsonResponse(200, { ok: true }, { 'Set-Cookie': cookie });
  return new Response(null, { status: 303, headers: { ...securityHeaders, Location: '/', 'Set-Cookie': cookie, 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * If the gate handles this request, return a Response (already tagged).
 * Otherwise return null so the Worker can serve the app.
 */
export async function previewFetch(request, env) {
  if (!gateOn(env)) return null;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/robots.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withPreviewHeaders(env, new Response(request.method === 'HEAD' ? null : ROBOTS_BODY, {
      status: 200,
      headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    }));
  }

  if (!secretsReady(env)) return withPreviewHeaders(env, failClosed(request));

  if (path === GATE_PATH && request.method === 'POST') {
    return withPreviewHeaders(env, await unlock(request, env));
  }

  const token = readCookie(request, COOKIE_NAME);
  if (verifyPreviewCookie(env.PREVIEW_GATE_SECRET, token)) return null;

  return withPreviewHeaders(env, locked(request));
}
