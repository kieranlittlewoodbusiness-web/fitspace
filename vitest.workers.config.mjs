// Vitest Workers integration (local Miniflare/workerd only; no Cloudflare account).
// `@cloudflare/vitest-pool-workers` was renamed to `@cloudflare/vitest-plugin`; this uses
// the maintained package. Each test file gets isolated D1 + Durable Object storage.
import crypto from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import { makeDemoSnapshot } from './scripts/demo-snapshot.mjs';
import { prepareImport } from './scripts/snapshot-import.mjs';

// Phase 4: the app's own demo seed, in the live snapshot format, run through the real
// snapshot -> D1 import. workers-test/legacy-platform.test.mjs loads these statements and
// runs the ported app/tests/platform.test.cjs against them. Demo data only.
async function demoSnapshotStatements() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc4-vitest-snapshot-'));
  try {
    const r = await prepareImport(makeDemoSnapshot(path.join(dir, 'demo.sqlite')));
    if (r.status !== 'ok') throw new Error('demo snapshot import failed: ' + r.status);
    return JSON.stringify(r.statements);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './workers-test/entry.mjs',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          DEMO_SNAPSHOT_SQL: await demoSnapshotStatements(),
          PAYMENT_MODE: 'demo',
          // Production/wrangler default is false. Tests opt into the marketplace unless a case passes false.
          MULTI_PT_ENABLED: 'true',
          // Throwaway per-run value so tests can sign webhook payloads. Never a real secret,
          // never written to disk or printed.
          STRIPE_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
          // Password-reset config so the reset flow is "configured" in tests. All throwaway:
          // RESEND_API_KEY is a random dummy and no code path in the tests calls Resend.
          RESET_EMAIL_MODE: 'send',
          RESEND_API_KEY: 'dummy-' + crypto.randomBytes(8).toString('hex'),
          MAIL_FROM: 'noreply@example.test',
          AUTH_RESET_SECRET: crypto.randomBytes(32).toString('hex'),
          APP_URL: 'https://example.test',
          // Phase 3 throwaways. Stripe/Resend HTTP is mocked in every test (vi.spyOn(fetch));
          // the "keys" below only satisfy format checks and are random per run.
          PT_INVITE_SECRET: crypto.randomBytes(32).toString('hex'),
          CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
          STRIPE_SECRET_KEY: 'sk_test_dummy' + crypto.randomBytes(8).toString('hex')
        },
        durableObjects: { WRITER: 'Writer', TEST_WRITER: 'TestWriter' }
      }
    }))
  ],
  test: {
    include: ['workers-test/**/*.test.mjs'],
    setupFiles: ['./workers-test/apply-migrations.mjs']
  }
});
