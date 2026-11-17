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
          STRIPE_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex')
        },
        durableObjects: { WRITER: 'Writer', GATE_PROBE: 'GateProbe' }
      }
    }))
  ],
  test: {
    include: ['workers-test/**/*.test.mjs'],
    setupFiles: ['./workers-test/apply-migrations.mjs']
  }
});
