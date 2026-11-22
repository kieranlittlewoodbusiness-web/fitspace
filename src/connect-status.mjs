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

/** Map a Stripe v1 Account or v2 Core Account to the fields we store and return. */
export function accountSnapshot(account) {
  const merchant = account?.configuration?.merchant;
  const card = merchant?.capabilities?.card_payments?.status;
  const transfers = merchant?.capabilities?.transfers?.status;
  const requirements = parseRequirements(merchant?.requirements || account?.requirements || {});
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
