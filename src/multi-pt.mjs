// RC-14: single-PT mode. MULTI_PT_ENABLED is on only when the env var is exactly "true".
// Default is false: one coach, no public directory, no extra PT creates, no platform
// subscription, no subscription-scope codes, no legacy pt_direct key routes.
import { httpError } from './util.mjs';

export const MULTI_PT_DISABLED = 'MULTI_PT_DISABLED';
export const SINGLE_PT_EXISTS = 'SINGLE_PT_EXISTS';
export const SINGLE_CONNECT_EXISTS = 'SINGLE_CONNECT_EXISTS';
export const PLATFORM_LINK_DISABLED = 'PLATFORM_LINK_DISABLED';

/** True only when the env var is the string "true". Unset, "false" and any other value are off. */
export function multiPtEnabled(env) {
  return env?.MULTI_PT_ENABLED === 'true';
}

/** Opaque booking URL for a published PT. Callers must not parse this; they just link to it. */
export function bookingPathFor(pt) {
  return pt?.slug ? '/pt/' + pt.slug : null;
}

export function multiPtDisabledError() {
  return httpError(404, 'This action is not available.', { code: MULTI_PT_DISABLED });
}

export function singlePtExistsError() {
  return httpError(409, 'This site already has its coach.', { code: SINGLE_PT_EXISTS });
}

export function singleConnectExistsError() {
  return httpError(409, 'This site already has a Stripe Connect account.', { code: SINGLE_CONNECT_EXISTS });
}

export function platformLinkDisabledError() {
  return httpError(409, 'Platform account linking is not available in single-coach mode.', { code: PLATFORM_LINK_DISABLED });
}

/**
 * Routes that stay in the tree for multi-PT mode but 404 when MULTI_PT_ENABLED is not "true":
 * the public PT directory, legacy pt_direct key routes, RC-7 platform subscription, and
 * RC-8 subscription-scope discount codes. /api/public/pts/:slug is NOT hidden (the booking page).
 */
export function isHiddenMultiPtRoute(method, route) {
  if (method === 'GET' && route === '/api/public/pts') return true;
  if (method === 'POST' && /^\/api\/stripe\/pt\/[a-f0-9-]{36}\/webhook$/.test(route)) return true;
  if (method === 'POST' && /^\/api\/pt\/stripe\/(credentials|check|enable|disconnect)$/.test(route)) return true;
  if (/^\/api\/(?:pt|admin)\/subscription(?:s)?(?:\/|$)/.test(route)) return true;
  if (/^\/api\/(?:pt|admin)\/subscription-codes(?:\/|$)/.test(route)) return true;
  return false;
}
