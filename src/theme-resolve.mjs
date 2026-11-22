// Resolve the PT theme for an HTML page and inject CSS variables into <head>
// so the first paint is already themed (no flash of the default yellow/black).
// Uses the existing pts colour columns (no migration). Does not write.
// customerPt/bookingPt require p.published=1, and p.deleted_at IS NULL only
// when that column exists (0007). Preview D1 has been migrated only through
// 0006 and has no pts.deleted_at; the check is skipped there.
import { currentUser } from './auth.mjs';
import { createDb } from './db.mjs';
import { multiPtEnabled } from './multi-pt.mjs';
import { publishedCoach } from './public.mjs';
import { accentInk, presetById, resolveThemeId } from './theme-presets.mjs';

const FALLBACK = Object.freeze({
  accent: '#ffd43b',
  accentInk: '#000000',
  background: '#ffffff',
  text: '#111111',
  primary: '#111111',
  primaryInk: '#ffffff'
});

export const THEME_HEX = /^#[0-9a-f]{6}$/i;

function safeHex(value, fallback) {
  return THEME_HEX.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

/** Map a pts row (or a public PT payload) to the CSS variables the pages use. */
export function themeVarsFromPt(pt) {
  if (!pt) return { ...FALLBACK };
  const preset = presetById(pt.id) || presetById(pt.theme_id) || presetById(resolveThemeId(pt));
  const accent = safeHex(pt.accent || preset?.accent, FALLBACK.accent);
  const background = safeHex(pt.background || preset?.background, FALLBACK.background);
  const text = safeHex(pt.foreground || pt.text || preset?.text, FALLBACK.text);
  const primary = safeHex(pt.primary || preset?.primary || text, FALLBACK.primary);
  return {
    accent,
    accentInk: accentInk(accent),
    background,
    text,
    primary,
    primaryInk: accentInk(primary)
  };
}

export function themeStyleTag(vars = FALLBACK) {
  const v = vars || FALLBACK;
  return `<style id="theme-boot">:root{--accent:${v.accent};--accent-ink:${v.accentInk};--bg:${v.background};--fg:${v.text};--ink:${v.text};--canvas:${v.background};--primary:${v.primary};--primary-ink:${v.primaryInk}}</style>`;
}

export function injectThemeIntoHtml(html, vars) {
  const source = String(html || '');
  const tag = themeStyleTag(vars);
  if (/<style id="theme-boot">[\s\S]*?<\/style>/.test(source)) {
    return source.replace(/<style id="theme-boot">[\s\S]*?<\/style>/, tag);
  }
  if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, tag + '</head>');
  return tag + source;
}

async function ptById(db, id) {
  if (!id) return null;
  return db.get('SELECT accent,background,foreground,id FROM pts WHERE id=?', id);
}

async function publishedPtBySlug(db, slug) {
  if (!slug) return null;
  return db.get('SELECT accent,background,foreground,id,slug FROM pts WHERE slug=? AND published=1', slug);
}

async function ptsHasDeletedAt(db) {
  const rows = await db.all('PRAGMA table_info(pts)');
  return rows.some(row => row.name === 'deleted_at');
}

async function bookingPt(db, user, bookingId) {
  if (!user || !bookingId) return null;
  const live = await ptsHasDeletedAt(db);
  if (user.role === 'customer') {
    if (live) {
      return db.get(
        'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND b.customer_id=? AND p.published=1 AND p.deleted_at IS NULL',
        bookingId, user.id
      );
    }
    return db.get(
      'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND b.customer_id=? AND p.published=1',
      bookingId, user.id
    );
  }
  if (user.role === 'pt' && user.pt_id) {
    if (live) {
      return db.get(
        'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND c.pt_id=? AND p.published=1 AND p.deleted_at IS NULL',
        bookingId, user.pt_id
      );
    }
    return db.get(
      'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND c.pt_id=? AND p.published=1',
      bookingId, user.pt_id
    );
  }
  if (user.role === 'admin') {
    if (live) {
      return db.get(
        'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND p.published=1 AND p.deleted_at IS NULL',
        bookingId
      );
    }
    return db.get(
      'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.id=? AND p.published=1',
      bookingId
    );
  }
  return null;
}

async function customerPt(db, user) {
  if (!user?.id) return null;
  if (await ptsHasDeletedAt(db)) {
    return db.get(
      'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.customer_id=? AND p.published=1 AND p.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 1',
      user.id
    );
  }
  return db.get(
    'SELECT p.accent,p.background,p.foreground,p.id FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id WHERE b.customer_id=? AND p.published=1 ORDER BY b.created_at DESC LIMIT 1',
    user.id
  );
}

/**
 * Choose the PT whose theme should appear on this HTML request.
 * Admin dashboard stays on the Resilience default. Public PT pages, checkout,
 * a signed-in PT, a signed-in customer, and single-PT site pages follow the
 * resolved trainer. Missing or unmatched colours fall back to Resilience.
 */
export async function resolveThemeVars(db, request, { multiPt = false, demo = false } = {}) {
  const url = new URL(request.url, 'https://resiliencecoaching.app');
  const path = url.pathname;
  const user = await currentUser(db, request, { demo });

  const onDashboard = path === '/dashboard' || path.startsWith('/dashboard/');
  if (user?.role === 'admin' && onDashboard) return themeVarsFromPt(null);

  const ptPage = path.match(/^\/pt\/([a-z0-9-]+)$/);
  if (ptPage) {
    const pt = await publishedPtBySlug(db, ptPage[1]);
    if (pt) return themeVarsFromPt(pt);
  }

  const checkout = path.match(/^\/(checkout|booking)\/([^/]+)$/);
  if (checkout) {
    const pt = await bookingPt(db, user, checkout[2]);
    if (pt) return themeVarsFromPt(pt);
  }

  if (user?.role === 'pt') {
    const pt = await ptById(db, user.pt_id);
    if (pt) return themeVarsFromPt(pt);
  }

  if (user?.role === 'customer') {
    const pt = await customerPt(db, user);
    if (pt) return themeVarsFromPt(pt);
    if (!multiPt) return themeVarsFromPt(await publishedCoach(db));
    return themeVarsFromPt(null);
  }

  if (!multiPt) return themeVarsFromPt(await publishedCoach(db));
  return themeVarsFromPt(null);
}

export { FALLBACK as DEFAULT_THEME_VARS };

function headerValue(headers, name) {
  const want = String(name).toLowerCase();
  if (!headers) return '';
  for (const [key, value] of headers) {
    if (key.toLowerCase() === want) return value;
  }
  return '';
}

function withSecurityHeaders(out, request, securityHeaders) {
  for (const [name, value] of Object.entries(securityHeaders || {})) out.headers.set(name, value);
  if (new URL(request.url).pathname === '/reset-password') out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}

/** Apply the resolved PT theme to a 200 HTML ASSETS response. 304s and other
 *  statuses are passed through untouched so a conditional request cannot build
 *  a 304 with a body. */
export async function serveThemedAsset(asset, request, env, securityHeaders) {
  const type = headerValue(asset.headers, 'content-type');
  if (asset.status !== 200 || !type.includes('text/html')) {
    return withSecurityHeaders(new Response(asset.body, asset), request, securityHeaders);
  }
  let vars = FALLBACK;
  try {
    vars = await resolveThemeVars(createDb(env.DB), request, {
      multiPt: multiPtEnabled(env),
      demo: env.DEMO_MODE === 'true'
    });
  } catch (error) {
    console.error('RC-29b theme resolve failed:', error.code || error.name || 'Error');
  }
  const out = new Response(injectThemeIntoHtml(await asset.text(), vars), {
    status: 200,
    statusText: asset.statusText,
    headers: new Headers(asset.headers)
  });
  out.headers.delete('Content-Length');
  out.headers.delete('ETag');
  out.headers.delete('Last-Modified');
  out.headers.set('Cache-Control', 'no-store');
  return withSecurityHeaders(out, request, securityHeaders);
}
