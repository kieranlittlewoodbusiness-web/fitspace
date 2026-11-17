// RC-4: builds the connector `execute` script that uploads ONLY the preview Worker
// (resiliencecoaching-preview), bound ONLY to the preview D1 database. Run from the repo root
// after `wrangler deploy --dry-run --env preview --outdir /tmp/rc4-prev`.
// Usage: node docs/rc-4/preview/gen-upload.mjs <out.js>
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = process.argv[2]; if (!OUT) throw new Error('usage: gen-upload.mjs <out.js>');
const PREVIEW_DB = '81379d2e-c718-48b7-870d-1d189feea966';
const PRODUCTION_DB = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
const cfg = readFileSync('wrangler.jsonc', 'utf8');
if (!cfg.includes(`"database_id": "${PREVIEW_DB}"`)) throw new Error('env.preview database_id not found in wrangler.jsonc');
const b64 = p => readFileSync(p).toString('base64');
const modules = [
  { name: 'entry.mjs', type: 'application/javascript+module', b64: b64('docs/rc-4/preview/entry.mjs') },
  { name: 'index.js', type: 'application/javascript+module', b64: b64('/tmp/rc4-prev/index.js') },
  ...['index.html', 'app.js', 'styles.css'].map(f => ({ name: `public/${f}.txt`, type: 'text/plain', b64: b64(`app/public/${f}`) }))
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
    { type: 'plain_text', name: 'CRON_ENABLED', text: 'true' },
    { type: 'plain_text', name: 'PREVIEW_GATE', text: 'on' }
  ],
  migrations: { new_tag: 'v1', new_sqlite_classes: ['Writer'] },
  keep_bindings: ['secret_text', 'secret_key'],
  observability: { enabled: true }
};
const all = JSON.stringify(metadata) + modules.map(m => Buffer.from(m.b64, 'base64').toString('utf8')).join('');
if (all.includes(PRODUCTION_DB) || all.includes(PRODUCTION_DB.slice(0, 8))) throw new Error('refusing: production database id present in the upload');
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
