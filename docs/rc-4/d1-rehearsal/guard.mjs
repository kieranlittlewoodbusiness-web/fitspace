// RC-4: the one production-id guard for the remote generators (generate.mjs, preview-apply.mjs,
// gen-upload.mjs). CR 5943169048 C2: compare the NORMALISED id (trimmed, lowercased), so the
// production id in upper case or with surrounding whitespace is refused as production, and
// any id sharing its first 8 hex digits is refused too.
export const PRODUCTION_DB = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isProduction = raw => { const id = String(raw ?? '').trim().toLowerCase(); return id === PRODUCTION_DB || id.startsWith(PRODUCTION_DB.slice(0, 8)); };
/** Returns the normalised database uuid, or throws 'refusing: ...'. */
export function safeDatabaseId(raw) {
  if (isProduction(raw)) throw new Error('refusing: that is the production database');
  const id = String(raw ?? '').trim().toLowerCase();
  if (!UUID.test(id)) throw new Error('refusing: not a database uuid');
  return id;
}
/** True if the text names the production id (any case) or its 8-hex prefix. */
export const mentionsProduction = text => String(text).toLowerCase().includes(PRODUCTION_DB.slice(0, 8));

/** The production D1 may be targeted only when the caller passed `--env production`. */
export function requireProductionEnv(envName) {
  const name = String(envName ?? '').trim();
  if (name !== 'production') throw new Error('refusing: the production database is allowed only with --env production');
  return name;
}
