// CR 5941600057 item 3: the remote rehearsal/preview generators refuse the production D1 id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRODUCTION = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('generate.mjs (rehearsal, runs DOWN migrations) refuses the production id and non-uuids', () => {
  for (const id of [PRODUCTION, PRODUCTION.toUpperCase(), 'fd8a613f-0000-4000-8000-000000000000', 'resiliencecoaching', '']) {
    const out = mkdtempSync(join(tmpdir(), 'rc4-gen-'));
    const r = run('docs/rc-4/d1-rehearsal/generate.mjs', [id, out].filter(Boolean));
    assert.notEqual(r.status, 0, id);
    assert.match(r.stderr, /refusing|usage/);
    assert.deepEqual(readdirSync(out), [], 'nothing written for ' + id);
  }
  const out = mkdtempSync(join(tmpdir(), 'rc4-gen-'));
  const ok = run('docs/rc-4/d1-rehearsal/generate.mjs', ['23a1910b-7fe8-450d-9e7b-c1d694dc0c67', out]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readdirSync(out).sort(), ['step1.js', 'step2.js']);
  assert.doesNotMatch(readFileSync(join(out, 'step2.js'), 'utf8'), new RegExp(PRODUCTION));
});

test('preview-apply.mjs refuses the production id', () => {
  const r = run('docs/rc-4/d1-rehearsal/preview-apply.mjs', [PRODUCTION, join(tmpdir(), 'rc4-never.js')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing/);
});

test('wrangler.jsonc: the default env does not enable the cron; only env.preview does', () => {
  const cfg = readFileSync('wrangler.jsonc', 'utf8');
  const preview = cfg.slice(cfg.indexOf('"preview": {'));
  const top = cfg.slice(0, cfg.indexOf('"env": {'));
  assert.doesNotMatch(top, /"CRON_ENABLED"/);
  assert.match(preview, /"CRON_ENABLED": "true"/);
  assert.match(preview, /"database_id": "81379d2e-c718-48b7-870d-1d189feea966"/);
  assert.doesNotMatch(preview, new RegExp(PRODUCTION));
});
