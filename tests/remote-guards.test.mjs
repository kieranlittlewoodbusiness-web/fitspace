// CR 5941600057 item 3: the remote rehearsal/preview generators refuse the production D1 id.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRODUCTION = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
// CR 5943169048 nit: no rc4-* folders left in /tmp.
const dirs = [];
const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// The production id in every spelling a guard must still recognise (CR 5943169048 C2).
const PROD_VARIANTS = [PRODUCTION, PRODUCTION.toUpperCase(), ' ' + PRODUCTION, PRODUCTION + ' ', '\t' + PRODUCTION.toUpperCase() + '\n', 'Fd8A613F-4DD4-462b-83e0-D7673031A6FC', 'fd8a613f-0000-4000-8000-000000000000'];

test('generate.mjs (rehearsal, runs DOWN migrations) refuses the production id and non-uuids', () => {
  for (const id of PROD_VARIANTS) {
    const out = tmp('rc4-gen-');
    const r = run('docs/rc-4/d1-rehearsal/generate.mjs', [id, out]);
    assert.notEqual(r.status, 0, JSON.stringify(id));
    assert.match(r.stderr, /refusing: that is the production database/, JSON.stringify(id));
    assert.deepEqual(readdirSync(out), [], 'nothing written for ' + JSON.stringify(id));
  }
  for (const id of ['resiliencecoaching', '']) {
    const out = tmp('rc4-gen-');
    const r = run('docs/rc-4/d1-rehearsal/generate.mjs', [id, out].filter(Boolean));
    assert.notEqual(r.status, 0, id);
    assert.match(r.stderr, /refusing|usage/);
    assert.deepEqual(readdirSync(out), [], 'nothing written for ' + id);
  }
  const out = tmp('rc4-gen-');
  const ok = run('docs/rc-4/d1-rehearsal/generate.mjs', ['23a1910b-7fe8-450d-9e7b-c1d694dc0c67', out]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readdirSync(out).sort(), ['step1.js', 'step2.js']);
  assert.doesNotMatch(readFileSync(join(out, 'step2.js'), 'utf8'), new RegExp(PRODUCTION));
});

test('preview-apply.mjs refuses the production id in any case or padding, before reading secrets or writing (CR 5943169048 C2)', () => {
  for (const id of PROD_VARIANTS) {
    const out = join(tmp('rc4-papply-'), 'out.js');
    const r = run('docs/rc-4/d1-rehearsal/preview-apply.mjs', [id, out]);
    assert.notEqual(r.status, 0, JSON.stringify(id));
    // the guard itself refuses (not a later ENOENT on .secrets/preview.json)
    assert.match(r.stderr, /refusing: that is the production database/, JSON.stringify(id));
    assert.doesNotMatch(r.stderr, /ENOENT/);
    assert.equal(existsSync(out), false, 'nothing written for ' + JSON.stringify(id));
  }
  const bad = run('docs/rc-4/d1-rehearsal/preview-apply.mjs', ['not-a-uuid', join(tmp('rc4-papply-'), 'out.js')]);
  assert.match(bad.stderr, /refusing: not a database uuid/);
});

test('guard.mjs: normalised production check shared by the generators', async () => {
  const { safeDatabaseId, isProduction, mentionsProduction, requireProductionEnv } = await import('../docs/rc-4/d1-rehearsal/guard.mjs');
  for (const id of PROD_VARIANTS) { assert.equal(isProduction(id), true, JSON.stringify(id)); assert.throws(() => safeDatabaseId(id), /production/); }
  assert.equal(safeDatabaseId(' 81379D2E-C718-48B7-870D-1D189FEEA966 '), '81379d2e-c718-48b7-870d-1d189feea966');
  assert.equal(mentionsProduction('x FD8A613F y'), true);
  assert.equal(mentionsProduction('81379d2e-c718-48b7-870d-1d189feea966'), false);
  assert.equal(requireProductionEnv('production'), 'production');
  assert.equal(requireProductionEnv(' production '), 'production');
  for (const name of [undefined, '', 'preview', 'Production', 'prod']) {
    assert.throws(() => requireProductionEnv(name), /only with --env production/);
  }
  for (const f of ['docs/rc-4/d1-rehearsal/generate.mjs', 'docs/rc-4/d1-rehearsal/preview-apply.mjs', 'docs/rc-4/preview/gen-upload.mjs']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /from '\.\.?\/(?:d1-rehearsal\/)?guard\.mjs'/, f + ' uses the shared guard');
    assert.doesNotMatch(src, /fd8a613f/i, f + ' has no private copy of the production id');
  }
});

test('wrangler.jsonc: the default env does not enable the cron; preview and production do', () => {
  const cfg = readFileSync('wrangler.jsonc', 'utf8');
  const top = cfg.slice(0, cfg.indexOf('"env": {'));
  const previewStart = cfg.indexOf('"preview": {');
  const productionStart = cfg.indexOf('"production": {');
  assert.ok(previewStart >= 0 && productionStart > previewStart);
  const preview = cfg.slice(previewStart, productionStart);
  const production = cfg.slice(productionStart);
  assert.doesNotMatch(top, /"CRON_ENABLED"/);
  assert.doesNotMatch(top, /"D1_DATABASE_ID"/);
  assert.doesNotMatch(top, /"triggers"/);
  assert.doesNotMatch(top, new RegExp(PRODUCTION), 'default env must not contain the production D1 id');
  assert.match(preview, /"CRON_ENABLED": "true"/);
  assert.match(preview, /"database_id": "81379d2e-c718-48b7-870d-1d189feea966"/);
  assert.match(preview, /"D1_DATABASE_ID": "81379d2e-c718-48b7-870d-1d189feea966"/);
  assert.doesNotMatch(preview, new RegExp(PRODUCTION), 'preview env must not contain the production D1 id');
  assert.match(top, /"database_id": "00000000-0000-4000-8000-000000000000"/);
  assert.match(production, /"CRON_ENABLED": "true"/);
  assert.match(production, /"PAYMENT_MODE": "stripe_live"/);
  assert.match(production, new RegExp('"D1_DATABASE_ID": "' + PRODUCTION + '"'));
  assert.match(production, /"MAIL_FROM": "bookings@mail.resiliencecoaching.app"/);
});

// Default env: no cron, no CRON_ENABLED (QA D3). env.production has both, and is selected
// only with `--env production`. Resolved through wrangler's own config reader.
test('wrangler.jsonc resolved by wrangler: cron and live Stripe only under --env production', async () => {
  const { unstable_readConfig: readConfig } = await import('wrangler');
  const { previewOutOfBandAllowed } = await import('../src/ops/password-reset.mjs');
  const resolve = (env) => readConfig({ config: 'wrangler.jsonc', env });
  const def = resolve(undefined), preview = resolve('preview'), production = resolve('production');
  const PRODUCTION_DB = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
  const LOCAL_DB = '00000000-0000-4000-8000-000000000000';
  assert.equal(def.d1_databases[0].database_id, LOCAL_DB);
  assert.notEqual(def.d1_databases[0].database_id, PRODUCTION_DB);
  assert.deepEqual(def.triggers?.crons ?? [], [], 'default env must not register a cron trigger');
  assert.equal(def.vars?.CRON_ENABLED, undefined);
  assert.equal(def.vars?.D1_DATABASE_ID, undefined);
  assert.equal(def.vars?.PAYMENT_MODE, 'demo');
  assert.equal(def.vars?.EMAIL_MODE, 'preview');
  assert.deepEqual(preview.triggers?.crons, ['* * * * *']);
  assert.equal(preview.vars?.CRON_ENABLED, 'true');
  assert.equal(preview.vars?.D1_DATABASE_ID, '81379d2e-c718-48b7-870d-1d189feea966');
  assert.notEqual(preview.d1_databases[0].database_id, PRODUCTION_DB);
  assert.notEqual(preview.vars?.PAYMENT_MODE, 'stripe_live');
  assert.deepEqual(production.triggers?.crons, ['* * * * *']);
  assert.equal(production.vars?.CRON_ENABLED, 'true');
  assert.equal(production.vars?.PAYMENT_MODE, 'stripe_live');
  assert.equal(production.vars?.EMAIL_MODE, 'send');
  assert.equal(production.vars?.RESET_EMAIL_MODE, 'send');
  assert.equal(production.vars?.MAIL_FROM, 'bookings@mail.resiliencecoaching.app');
  assert.equal(production.vars?.APP_URL, 'https://resiliencecoaching.app');
  assert.equal(production.vars?.D1_DATABASE_ID, PRODUCTION_DB);
  assert.equal(production.d1_databases[0].database_id, PRODUCTION_DB);
  assert.equal(production.vars?.STRIPE_INTEGRATION, 'connect');
  assert.equal(previewOutOfBandAllowed(production.vars), false, 'preview reset path must stay fail-closed on prod');
  const routes = (production.routes || production.custom_domains || []).map(r => r.pattern || r);
  assert.ok(routes.some(r => String(r).includes('resiliencecoaching.app')));
  assert.ok(routes.some(r => String(r).includes('www.resiliencecoaching.app')));
  // Only the explicit production env may combine a cron trigger with the production database.
  const raw = (await import('wrangler')).experimental_readRawConfig({ config: 'wrangler.jsonc' }).rawConfig;
  for (const name of Object.keys(raw.env || {})) {
    const c = resolve(name);
    if ((c.triggers?.crons ?? []).length && c.d1_databases?.[0]?.database_id === PRODUCTION_DB) {
      assert.equal(name, 'production', name);
    }
  }
  assert.notEqual((resolve('preview').vars?.PAYMENT_MODE), 'stripe_live');
  assert.notEqual(def.vars?.PAYMENT_MODE, 'stripe_live');
  // The full production D1 id is resolved only under --env production.
  assert.notEqual(def.d1_databases[0].database_id, PRODUCTION_DB);
  assert.notEqual(preview.d1_databases[0].database_id, PRODUCTION_DB);
  assert.notEqual(preview.vars?.D1_DATABASE_ID, PRODUCTION_DB);
  assert.equal(production.d1_databases[0].database_id, PRODUCTION_DB);
  assert.equal(production.vars?.D1_DATABASE_ID, PRODUCTION_DB);
});

test('wrangler.jsonc: MULTI_PT_ENABLED is "false" on the default, preview and production envs', async () => {
  const { unstable_readConfig: readConfig } = await import('wrangler');
  const resolve = (env) => readConfig({ config: 'wrangler.jsonc', env });
  assert.equal(resolve(undefined).vars?.MULTI_PT_ENABLED, 'false');
  assert.equal(resolve('preview').vars?.MULTI_PT_ENABLED, 'false');
  assert.equal(resolve('production').vars?.MULTI_PT_ENABLED, 'false');
});


test('gen-upload writes a script from the preview bundle and refuses a prod-bound config', async () => {
  const { assertSafePreviewUpload, PREVIEW_DB } = await import('../docs/rc-4/preview/gen-upload.mjs');
  const previewMeta = () => ({ bindings: [{ type: 'd1', name: 'DB', id: PREVIEW_DB }] });
  assert.doesNotThrow(() => assertSafePreviewUpload(previewMeta(), { database_id: PREVIEW_DB, D1_DATABASE_ID: PREVIEW_DB }));
  // The guard comparison constant in the bundle must not, by itself, refuse a preview-bound upload.
  assert.doesNotThrow(() => assertSafePreviewUpload(previewMeta(), { database_id: PREVIEW_DB }));
  assert.throws(() => assertSafePreviewUpload(previewMeta(), { database_id: PRODUCTION }), /refusing: production database id present in the upload/);
  assert.throws(() => assertSafePreviewUpload(previewMeta(), { D1_DATABASE_ID: PRODUCTION }), /refusing: production database id present in the upload/);
  assert.throws(() => assertSafePreviewUpload({ bindings: [{ type: 'd1', name: 'DB', id: PRODUCTION }] }, { database_id: PREVIEW_DB }), /refusing: production database id present in the upload/);

  const outdir = tmp('rc4-prev-bundle-');
  const wrangler = spawnSync(join(process.cwd(), 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--env', 'preview', '--outdir', outdir], { encoding: 'utf8' });
  assert.equal(wrangler.status, 0, wrangler.stderr || wrangler.stdout);
  const bundle = readFileSync(join(outdir, 'index.js'), 'utf8');
  assert.match(bundle, new RegExp(PRODUCTION, 'i'), 'preview bundle still inlines the guard comparison constant');

  const script = join(tmp('rc4-gen-upload-'), 'upload.js');
  const r = run('docs/rc-4/preview/gen-upload.mjs', [script, outdir]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /^ok /);
  assert.equal(existsSync(script), true);
  const generated = readFileSync(script, 'utf8');
  assert.match(generated, new RegExp(PREVIEW_DB));
  assert.match(generated, /"type":"d1"/);
  assert.doesNotMatch(generated, new RegExp(`"id":"${PRODUCTION}"`));
});

test('seed-dev-pt.mjs refuses --remote (even with --confirm-remote) and requires --local', () => {
  for (const args of [['--remote'], ['--remote', '--confirm-remote']]) {
    const r = run('scripts/seed-dev-pt.mjs', args);
    assert.notEqual(r.status, 0, JSON.stringify(args) + '\n' + (r.stderr || r.stdout));
    assert.match(r.stderr, /local-only|--remote is refused/);
  }
  const missing = run('scripts/seed-dev-pt.mjs', ['--persist-to', '/tmp']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Pass --local/);
  const help = run('scripts/seed-dev-pt.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--remote +refused/);
});
