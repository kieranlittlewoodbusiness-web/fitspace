# RC-4: storage port to Cloudflare D1

Status: **phase 1 of 4, local only.** Decision: Kieran chose D1 (17 Nov 2026). Base `main` 7cebef2, branch `rc-4-d1`.
Nothing here has touched a Cloudflare account. No database was created, nothing was deployed, and no Stripe call was made.

## 1. Architecture

| Piece | File | Notes |
|---|---|---|
| Worker entry | `worker/index.mjs` | Static ESM imports only. Bindings read from `env` per request. Static files via Workers Static Assets (`app/public`) with the app's security headers. |
| D1 schema | `migrations/0001_initial_schema.sql` | The 17 tables of `app/db.cjs` as they stand after its v5/v6 in-app migrations. A test checks column-for-column parity against `app/db.cjs` (`workers-test/fixtures/app-schema-7cebef2.json`). |
| Locks + RC-5..RC-11 foundation | `migrations/0002_locks_and_rc5_rc9_foundation.sql` | Additive only (see §3). |
| Down-migration | `migrations-down/0002_….down.sql` | Outside `migrations/`, so `wrangler d1 migrations apply` never runs it. Tested up → down → up. |
| Async data layer | `src/db.mjs` | `await db.get/all/run(sql, ...args)`, `db.stmt()` and `db.batch()`. Same SQLite SQL and `?` placeholders as `DatabaseSync`, so the call sites port mechanically. No `tx()`. |
| Tenant scope ("RLS") | `src/scope.mjs` | Every PT-owned read/write goes through `scopeFor(db, user)`. The `pt_id` predicate is in the SQL. |
| Serialised writer | `src/writer.mjs` (`Writer` Durable Object) | One global instance with an in-memory promise queue. Every multi-step read-then-write flow runs here and commits with **one** `batch()` of guarded statements. |
| Writer ops | `src/ops/*.mjs` | `reserve` (capacity hold), `handleWebhook` (checkout + payment_failed), `claimCode` (max_uses). |
| Local config | `wrangler.jsonc` | D1 binding `DB` with **placeholder `database_id` `00000000-0000-4000-8000-000000000000` (local only)**. DO binding `WRITER` (SQLite-backed class, Free-plan compatible). `workers_dev:false`, `preview_urls:false`, no account_id, no routes. |

### CR items from spike PR #1
- **import.meta.url define removed.** The Worker path no longer uses `createRequire`, runtime `require(\`${runtimeRoot}/…\`)`, `import.meta.url`, `LAMBDA_TASK_ROOT` or `node:fs` reads of `app/public`. esbuild bundles only what is imported, so the nested v4 `fitspace/` tree is never reached and no CommonJS upload rules are needed. Dry-run bundle: **22.79 KiB / 7.30 KiB gzip**. `netlify/functions/platform.mjs` is untouched; it stays the live Netlify path until cutover and is deleted then.
- **No DDL in the request path.** No `ensureSchema`, no `CREATE TABLE IF NOT EXISTS`, no `PRAGMA table_info` probing at runtime. Schema changes ship only as versioned files in `migrations/` (`wrangler d1 migrations apply`). The admin bootstrap that `app/public-mode.cjs` runs on every request moves to a one-off script in phase 2.
- **Probes.** RC-4 has no `/__spike/*` routes. The Durable Object gate probe (`GateProbe`) exists only in `workers-test/entry.mjs` and is never part of the Worker bundle. If probes are ever added, keep RC-1's localhost-only guard.
- `.gitignore` covers `node_modules/`, `.wrangler/`, `.dev.vars` and `.netlify/`. `.dev.vars.example` lists names only.

## 2. Concurrency rules (no interactive transactions on D1)

D1 rejects `BEGIN` and `SAVEPOINT` (tested: `D1_ERROR: To execute a transaction, please use the state.storage.transaction()…`). `batch()` is atomic, and a failing statement rolls back the whole batch (tested). The replacements:

1. **Single-statement guarded writes** wherever possible. D1 runs one statement at a time, so these are race-free with no queue:
   - Capacity: a count-form guarded insert. `INSERT INTO bookings … SELECT … WHERE (SELECT count(*) … status IN ('paid','pending')) < b.capacity AND b.published=1 AND b.closed=0 RETURNING *`.
   - Discount codes: `UPDATE discount_codes SET uses=uses+1 WHERE id=? AND (max_uses IS NULL OR uses<max_uses) … RETURNING uses`, backed by `CHECK(uses<=max_uses)`.
2. **Unique indexes as locks:**
   - `bookings_one_live_per_customer` (partial, `status IN ('pending','paid')`)
   - `checkout_token` UNIQUE (idempotent retries)
   - `booking_payment_intent` (partial)
   - `webhook_events.id` PK
   - `waitlist_one_live_per_customer`
   - `discount_codes_unique (coalesce(pt_id,''), lower(code))`
3. **Multi-step flows run in the Writer.** Reads come first, then one guarded `batch()` commit. A Durable Object **does not** hold other requests while it awaits D1. In 10 rounds × 20 calls at capacity 5, the un-queued probe held up to 20 rows; the queued one held exactly 5 every round. So the promise queue is required, and it is what gives `BEGIN IMMEDIATE`-like serialisation. Guards stay in the batch anyway, so the commit is also safe against writes that bypass the Writer.
4. **Reads after writes** inside a flow use `RETURNING`, or the commit-time value is computed in SQL (for example `CASE WHEN status='pending' AND expires_at>? THEN 'paid' ELSE 'review' END`).

### Webhook idempotency: the one rule
> **Insert the event key into `webhook_events` in the same `batch()` as the event's effects, as the batch's first statement. If the key already exists, the PRIMARY KEY violation aborts the whole batch, nothing is applied, and the endpoint answers 200 `{duplicate:true}`. If any effect fails, the whole batch (including the key) rolls back, Stripe retries, and the event is applied then.**

There is no separate "insert first, then process" step, and no `processing`/`failed` status row. A key is recorded **only** when its effects committed. The key is `<credential_id>:<evt_id>` for per-PT endpoints, or `<evt_id>` for the platform/Connect endpoint. Effects stay individually guarded too (`WHERE paid_at IS NULL`, `WHERE status='pending'`, `INSERT OR IGNORE` on `email_outbox.dedupe_key`). Tests: 5 concurrent HTTP deliveries → 1 received / 4 duplicate, and the same result when the Writer is bypassed.

## 3. Schema for RC-5..RC-11 (in 0002, additive)
- **RC-5 Connect:** `stripe_connections` gains `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements` (JSON) and `updated_at`.
- **RC-7 subscription:** `pt_subscriptions` (Stripe customer/subscription ids UNIQUE, `status` CHECK, `current_period_end`, `cancel_at_period_end`, `grace_until`, `last_event_created` for out-of-order events).
- **RC-8 discounts:** `discount_codes` (PT/admin owner; scope class/all/subscription; percent/fixed; `max_uses`/`uses` with CHECK; expiry; Stripe coupon/promotion ids) and `discount_redemptions` (`UNIQUE(code_id, booking_id)`). `bookings` gains `list_price_pence`, `discount_pence` and `discount_code_id`.
- **RC-9 class model:** `blocks` gains `kind` (one_off/weekly_block), `weeks` 1–52, `duration_minutes`, `location_type` (in_person/online), `online_url`, `cancellation_policy` (JSON) and `updated_at`.
- **RC-11 waitlist:** `waitlist_entries` with a partial unique live-entry index and a queue index.
- **Worker rate limiting:** `rate_limits`. This replaces the Postgres `checkLimit` and the per-isolate in-memory `Map`.

## 4. Rollback (works on Workers; NOT run against a real database)

Before every remote migration (this needs the real D1 database, which needs approval):
1. `npx wrangler d1 time-travel info DB --remote` and record the **current bookmark** in the release ticket.
2. `npx wrangler d1 export DB --remote --output backup-<date>.sql` for an off-platform copy. Time Travel keeps 7 days on Free and 30 days on Paid.
3. `npx wrangler d1 migrations apply DB --remote`

To roll back, pick one:
- **A. Time Travel restore (full, destructive).** `npx wrangler d1 time-travel restore DB --remote --bookmark=<recorded>`. This overwrites the database in place, **including rows written after the bookmark**, and cancels in-flight queries. The command prints an undo bookmark. Use it when the migration broke data or no writes worth keeping have happened since.
- **B. Down-migration (schema only, keeps other data).** `npx wrangler d1 execute DB --remote --file migrations-down/<n>.down.sql`, then `DELETE FROM d1_migrations WHERE name='<n>.sql'`. Data in the dropped tables/columns is lost, so export first. Locally tested: 0002 down restores exact parity with `app/db.cjs`, and 0002 re-applies cleanly.
- **Code:** roll the Worker back to the previous version with `npx wrangler rollback`. Migrations are additive, so the previous code runs against the newer schema.

Schema rule that keeps B possible: no `REFERENCES` on columns added with `ALTER TABLE` (SQLite cannot drop a foreign-key column). Use a link table or app validation instead.

## 5. Secrets and config inventory (names only)

| Name | Type | Used in today | On Workers | Dev (local) | Prod |
|---|---|---|---|---|---|
| `DB` | D1 binding | — | `src/db.mjs` | local D1 (placeholder id) | real D1 id (needs approval) |
| `WRITER` | DO binding | — | `src/writer.mjs` | local | same |
| `ASSETS` | assets binding | — | `worker/index.mjs` | local | same |
| `APP_URL` | var | server.cjs, payments.cjs (redirects), password-reset.cjs | phases 2–3 | `http://127.0.0.1:8787` | `https://resiliencecoaching.app` |
| `PAYMENT_MODE` | var | platform.mjs, server.cjs | yes | `demo` (wrangler vars) | `stripe_test` until RC-OPS-2 |
| `STRIPE_INTEGRATION` | var | pt-stripe.cjs | yes | `connect` | `connect` (Kieran's decision) |
| `EMAIL_MODE` | var | emails.cjs (forced `preview` in platform.mjs) | yes | `preview` | `preview` until RC-10 approval |
| `RESET_EMAIL_MODE` | var | password-reset.cjs | phase 2 | `preview` | per RC-10 |
| `DEMO_MODE` | var | server.cjs | yes | unset | unset (never demo) |
| `STRIPE_API_VERSION` | var (optional) | payments.cjs | phase 3 | default | pinned |
| `MAIL_FROM` | var | emails.cjs, password-reset.cjs | phase 3 | test domain | per RC-10 |
| `STRIPE_SECRET_KEY` | **secret** | payments.cjs, stripe-mode.cjs | phase 3 | test key in `.dev.vars` | `wrangler secret put` (test key until RC-OPS-2) |
| `STRIPE_WEBHOOK_SECRET` | **secret** | server.cjs, platform.mjs | yes (`/api/stripe/webhook`) | random per run in vitest; Stripe CLI value in `.dev.vars` | `wrangler secret put` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | **secret** | server.cjs | yes | `.dev.vars` | `wrangler secret put` |
| `CREDENTIAL_ENCRYPTION_KEY` | **secret** | pt-stripe.cjs (AES-GCM for legacy `pt_direct` keys) | phase 3, read-only for legacy rows | `.dev.vars` | until `pt_direct` rows are migrated, then removed |
| `AUTH_RESET_SECRET` | **secret** (≥32 chars) | password-reset.cjs (HMAC) | phase 2 | `.dev.vars` | `wrangler secret put` |
| `RESEND_API_KEY` | **secret** | emails.cjs, password-reset.cjs | phase 3 | test key | per RC-10 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | bootstrap | public-mode.cjs (checked on **every** request) | **not a Worker secret**: one-off bootstrap script (phase 2) | local script | run once, then not stored |
| `DATABASE_URL`, `DATA_NAMESPACE` | secret / var | lib/storage.mjs, platform.mjs | **retired** (D1 replaces the snapshot) | — | delete from Netlify at decommission |
| `LAMBDA_TASK_ROOT` | runtime | platform.mjs | **retired** (static imports) | — | — |
| `DATABASE_PATH`, `PORT`, `SITES_MANAGED_LINUX_CONTAINER` | local dev | server.cjs, scripts/dev.mjs | **retired** (`wrangler dev`) | — | — |

## 6. Local commands
```
npm install
npm run db:migrate:local      # wrangler d1 migrations apply DB --local
npm run dev:workers           # wrangler dev --local
npm run test:workers          # vitest + @cloudflare/vitest-plugin (Miniflare)
npm test                      # existing node:test suite (unchanged)
```
Regenerate the schema-parity fixture after any `app/db.cjs` change (until it is deleted):
`node scripts/dump-app-schema.cjs`.

## 7. Phase plan
See the PR description for the live checklist.
