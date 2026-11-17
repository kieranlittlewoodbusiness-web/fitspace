// Vitest Workers integration (local Miniflare/workerd only; no Cloudflare account).
// `@cloudflare/vitest-pool-workers` was renamed to `@cloudflare/vitest-plugin`; this uses
// the maintained package. Each test file gets isolated D1 + Durable Object storage.
import crypto from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './workers-test/entry.mjs',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          PAYMENT_MODE: 'demo',
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
