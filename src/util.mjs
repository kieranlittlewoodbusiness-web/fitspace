// Pure helpers ported from app/db.cjs and app/auth.cjs (no node:sqlite import).
import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const httpError = (status, message) => Object.assign(new Error(message), { status });

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
export const isStripe = mode => mode === 'stripe_test' || mode === 'stripe_live';
export const live = mode => mode === 'stripe_live';
