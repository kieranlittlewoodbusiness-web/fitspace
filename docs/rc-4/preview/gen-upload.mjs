// RC-4: builds the connector `execute` script that uploads ONLY the preview Worker
// (resiliencecoaching-preview), bound ONLY to the preview D1 database. Run from the repo root
// after `wrangler deploy --dry-run --env preview --outdir /tmp/rc4-prev`.
// Usage: node docs/rc-4/preview/gen-upload.mjs <out.js> [bundle-dir]
// Safety: refuse when production is *bound* (resolved env.preview D1 / vars, or upload
// metadata bindings). The worker bundle may contain the guard's comparison constant
// (imported by the preview out-of-band reset gate) without being prod-bound.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { isProduction, mentionsProduction } from '../d1-rehearsal/guard.mjs';

export const PREVIEW_DB = '81379d2e-c718-48b7-870d-1d189feea966';

const VAR_IDS = new Set(['D1_DATABASE_ID', 'DATABASE_ID']);

/** Ids that would be bound at upload or on the preview env, not strings inside the JS bundle. */
export function boundUploadIds(metadata, wranglerPreview = {}) {
  const ids = [];
  if (wranglerPreview.database_id) ids.push(wranglerPreview.database_id);
  for (const name of VAR_IDS) {
    const value = wranglerPreview[name];
    if (value != null && String(value).trim() !== '') ids.push(value);
  }
  for (const b of metadata.bindings || []) {
    if (b.type === 'd1' && b.id) ids.push(b.id);
    if (b.type === 'plain_text' && VAR_IDS.has(b.name) && b.text != null && String(b.text).trim() !== '') ids.push(b.text);
  }
  return ids;
}

export function assertSafePreviewUpload(metadata, wranglerPreview = {}) {
  if (mentionsProduction(JSON.stringify(metadata))) {
    throw new Error('refusing: production database id present in the upload');
  }
  const ids = boundUploadIds(metadata, wranglerPreview);
  if (!ids.length) throw new Error('refusing: preview database id is not bound');
  for (const id of ids) {
    if (isProduction(id) || String(id).trim().toLowerCase() !== PREVIEW_DB) {
      throw new Error('refusing: production database id present in the upload');
    }
  }
}

function previewBindingsFromWrangler(config = 'wrangler.jsonc') {
  const preview = unstable_readConfig({ config, env: 'preview' });
  return {
    database_id: preview.d1_databases?.[0]?.database_id,
    D1_DATABASE_ID: preview.vars?.D1_DATABASE_ID,
    DATABASE_ID: preview.vars?.DATABASE_ID
  };
}

export function buildPreviewUpload({ bundleDir = '/tmp/rc4-prev', wranglerPath = 'wrangler.jsonc' } = {}) {
  const cfg = readFileSync(wranglerPath, 'utf8');
  if (!cfg.includes(`"database_id": "${PREVIEW_DB}"`)) throw new Error('env.preview database_id not found in wrangler.jsonc');
  const b64 = p => readFileSync(p).toString('base64');
  const modules = [
    { name: 'entry.mjs', type: 'application/javascript+module', b64: b64('docs/rc-4/preview/entry.mjs') },
    { name: 'index.js', type: 'application/javascript+module', b64: b64(join(bundleDir, 'index.js')) },
    ...['index.html', 'app.js', 'styles.css', 'sitemap.xml'].map(f => ({ name: `public/${f}.txt`, type: 'text/plain', b64: b64(`app/public/${f}`) })),
    // RC-28 / launch-1: binaries as ASCII base64 text modules (same Text-module channel as the HTML/JS/CSS).
    // Production robots.txt is not uploaded; the preview entry intercepts /robots.txt with Disallow-all.
    ...['fonts/sora-latin-wght.woff2','images/hero.webp','images/booking-hero.webp','images/class-strength.webp','images/class-conditioning.webp','images/empty-classes.webp','images/empty-bookings.webp','favicon.ico','apple-touch-icon.png','images/og.jpg'].map(f => ({ name: `public/${f}.b64.txt`, type: 'text/plain', b64: Buffer.from(readFileSync(`app/public/${f}`).toString('base64'), 'utf8').toString('base64') }))
  ];
  const metadata = {
    main_module: 'entry.mjs', compatibility_date: '2026-11-01', compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'd1', name: 'DB', id: PREVIEW_DB },
      { type: 'durable_object_namespace', name: 'WRITER', class_name: 'Writer' },
      { type: 'plain_text', name: 'EMAIL_MODE', text: 'preview' },
      { type: 'plain_text', name: 'PAYMENT_MODE', text: 'stripe_test' },
      { type: 'plain_text', name: 'STRIPE_INTEGRATION', text: 'connect' },
      { type: 'plain_text', name: 'APP_URL', text: 'https://resiliencecoaching-preview.littlk.workers.dev' },
      // CR 5941600057: scheduled() is a no-op without it (the parked 15:45 upload predates the gate).
      { type: 'plain_text', name: 'CRON_ENABLED', text: 'true' }
    ],
    migrations: { new_tag: 'v1', new_sqlite_classes: ['Writer'] },
    keep_bindings: ['secret_text', 'secret_key'],
    observability: { enabled: true }
  };
  assertSafePreviewUpload(metadata, previewBindingsFromWrangler(wranglerPath));
  return { modules, metadata };
}

function main() {
  const OUT = process.argv[2];
  if (!OUT) throw new Error('usage: gen-upload.mjs <out.js> [bundle-dir]');
  const bundleDir = process.argv[3] || '/tmp/rc4-prev';
  const { modules, metadata } = buildPreviewUpload({ bundleDir });
  writeFileSync(OUT, `async () => {
const name = 'resiliencecoaching-preview'; const base = \`/accounts/\${accountId}/workers/scripts/\${name}\`;
const MODULES = ${JSON.stringify(modules)}; const META = ${JSON.stringify(metadata)};
const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(META)], { type: 'application/json' }));
for (const m of MODULES) form.append(m.name, new Blob([bytes(m.b64)], { type: m.type }), m.name);
const r = (await cloudflare.request({ method: 'PUT', path: base, body: form })).result;
const settings = (await cloudflare.request({ method: 'GET', path: \`\${base}/settings\` })).result;
const sub = (await cloudflare.request({ method: 'GET', path: \`\${base}/subdomain\` })).result;
return { script: { id: r.id, tag: r.tag, etag: r.etag, usage_model: r.usage_model, compatibility_date: r.compatibility_date, modified_on: r.modified_on },
  bindings: settings.bindings.map(b => ({ type: b.type, name: b.name, id: b.id, class_name: b.class_name, namespace_id: b.namespace_id, text: b.type === 'plain_text' ? b.text : undefined })),
  subdomain: sub };
}`);
  console.log('ok', modules.map(m => m.name + ':' + m.type).join(' '));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
