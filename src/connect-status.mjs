// RC-5: Connect account snapshot and the dashboard state shown to the PT.
// Pure helpers plus one read (resolveConnectPtId). No Stripe calls.
import { httpError } from './util.mjs';

export const CONNECT_STATES = Object.freeze(['not_connected', 'onboarding_incomplete', 'restricted', 'pending', 'active']);

const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

export function parseRequirements(value) {
  let req = value;
  if (typeof value === 'string') {
    try { req = JSON.parse(value); } catch { req = {}; }
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) req = {};
  const disabled = req.disabled_reason;
  return {
    currently_due: list(req.currently_due),
    past_due: list(req.past_due),
    disabled_reason: typeof disabled === 'string' && disabled ? disabled : null
  };
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isV1Requirements = value => isObject(value) && (Array.isArray(value.currently_due) || Array.isArray(value.past_due));
// v2 capability status_details codes -> the v1 disabled_reason strings the card already shows.
const V2_DISABLED_REASONS = Object.freeze({
  requirements_past_due: 'requirements.past_due',
  requirements_pending_verification: 'requirements.pending_verification'
});

/**
 * RC-33: requirements carried by a Stripe response, in the stored {currently_due, past_due, disabled_reason} shape.
 * v1 Account (or v1-shaped object) -> parsed as-is. v2 Core Account with `include=requirements` -> mapped from
 * requirements.entries (only entries awaiting the user; past_due entries also count as currently_due, as in v1).
 * Returns null when the response carries no requirements, so the caller keeps what is stored.
 */
export function accountRequirements(account) {
  const v1 = [account?.configuration?.merchant?.requirements, account?.requirements].find(isV1Requirements);
  if (v1) return parseRequirements(v1);
  const v2 = account?.requirements;
  if (!isObject(v2) || !('entries' in v2 || 'summary' in v2)) return null;
  if (v2.entries != null && !Array.isArray(v2.entries)) return null;
  const currently = new Set();
  const past = new Set();
  for (const entry of v2.entries || []) {
    if (!isObject(entry) || entry.awaiting_action_from === 'stripe') continue;
    const name = typeof entry.description === 'string' ? entry.description : '';
    const status = entry.minimum_deadline?.status;
    if (!name) continue;
    if (status === 'past_due') { past.add(name); currently.add(name); }
    else if (status === 'currently_due') currently.add(name);
  }
  const card = account?.configuration?.merchant?.capabilities?.card_payments;
  const codes = card && card.status !== 'active' && Array.isArray(card.status_details) ? card.status_details.map(d => d?.code) : [];
  const mapped = codes.map(code => V2_DISABLED_REASONS[code]).find(Boolean);
  return {
    currently_due: [...currently],
    past_due: [...past],
    disabled_reason: mapped || (past.size ? 'requirements.past_due' : null)
  };
}

/** Map a Stripe v1 Account or v2 Core Account to the fields we store and return. requirements is null when absent. */
export function accountSnapshot(account) {
  const merchant = account?.configuration?.merchant;
  const card = merchant?.capabilities?.card_payments?.status;
  const transfers = merchant?.capabilities?.transfers?.status;
  const requirements = accountRequirements(account);
  const charges = typeof account?.charges_enabled === 'boolean' ? Boolean(account.charges_enabled) : card === 'active';
  const payouts = typeof account?.payouts_enabled === 'boolean' ? Boolean(account.payouts_enabled) : transfers === 'active';
  const details = typeof account?.details_submitted === 'boolean'
    ? Boolean(account.details_submitted)
    : Boolean(merchant && card && card !== 'unrequested');
  return {
    charges_enabled: charges,
    payouts_enabled: payouts,
    details_submitted: details,
    requirements,
    ready: charges
  };
}

export function connectState(row) {
  if (!row?.account_id) return 'not_connected';
  const requirements = parseRequirements(row.requirements);
  if (requirements.disabled_reason || requirements.past_due.length) return 'restricted';
  if (row.charges_enabled) return 'active';
  if (!row.details_submitted) return 'onboarding_incomplete';
  return 'pending';
}

export function connectStatusView(row, { mode } = {}) {
  return {
    state: connectState(row),
    account_id: row?.account_id || null,
    routing: row?.routing || null,
    ready: Boolean(row?.ready || row?.charges_enabled),
    charges_enabled: Boolean(row?.charges_enabled),
    payouts_enabled: Boolean(row?.payouts_enabled),
    details_submitted: Boolean(row?.details_submitted),
    requirements: parseRequirements(row?.requirements),
    ...(mode ? { mode } : {})
  };
}

/** PT owner (own pt_id) or admin (explicit pt_id, or the one PT when single-PT mode is on). */
export async function resolveConnectPtId(db, user, ptId, { multiPt = true } = {}) {
  if (!user) throw httpError(401, 'Please sign in to continue.', { code: 'UNAUTHENTICATED' });
  if (user.role === 'pt' && user.pt_id) {
    if (ptId && ptId !== user.pt_id) throw httpError(403, 'Your account does not have access to this action.', { code: 'FORBIDDEN' });
    return user.pt_id;
  }
  if (user.role === 'admin') {
    if (typeof ptId === 'string' && ptId) {
      if (!(await db.get('SELECT id FROM pts WHERE id=? AND deleted_at IS NULL', ptId))) throw httpError(404, 'Trainer not found.', { code: 'TRAINER_NOT_FOUND' });
      return ptId;
    }
    if (!multiPt) {
      const rows = await db.all('SELECT id FROM pts WHERE deleted_at IS NULL ORDER BY created_at LIMIT 2');
      if (rows.length === 1) return rows[0].id;
    }
    throw httpError(400, 'Choose a trainer to continue Stripe setup.', { code: 'PT_REQUIRED' });
  }
  throw httpError(403, 'Your account does not have access to this action.', { code: 'FORBIDDEN' });
}
