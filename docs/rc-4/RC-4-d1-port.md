# RC-4: storage port to Cloudflare D1

Status: **phase 2 of 4, local only** (phase 2 + CR review 5940135102 fixes). Decision: Kieran chose D1 (17 Nov 2026). Base `main` 7cebef2, branch `rc-4-d1`.
Nothing here has touched a Cloudflare account. No database was created, nothing was deployed, and no Stripe call was made.

## 1. Architecture

| Piece | File | Notes |
|---|---|---|
| Worker entry | `worker/index.mjs` | Static ESM imports only. Bindings read from `env` per request. Static files via Workers Static Assets (`app/public`) with the app's security headers. |
| D1 schema | `migrations/0001_initial_schema.sql` | The 17 tables of `app/db.cjs` as they stand after its v5/v6 in-app migrations. A test checks column-for-column parity against `app/db.cjs` (`workers-test/fixtures/app-schema-7cebef2.json`). |
| Locks + RC-5..RC-11 foundation | `migrations/0002_locks_and_rc5_rc9_foundation.sql` | Additive only (see §3). |
| Guards + expiry index | `migrations/0003_guards_and_expiry_index.sql` | `batch_guards` (commit-time assertions, §2) and `bookings_pending_expiry(status, expires_at)` for the expiry sweep. |
| Down-migrations | `migrations-down/000{2,3}_….down.sql` | Outside `migrations/`, so `wrangler d1 migrations apply` never runs them. Each is ONE `d1 execute --file` step: its last statement deletes its `d1_migrations` row. Tested 3 → 2 down → up → up. |
| Async data layer | `src/db.mjs` | `await db.get/all/run(sql, ...args)`, `db.stmt()` and `db.batch()`. Same SQLite SQL and `?` placeholders as `DatabaseSync`, so the call sites port mechanically. No `tx()`. |
| Tenant scope ("RLS") | `src/scope.mjs` | Every PT-owned read/write goes through `scopeFor(db, user)`. The `pt_id` predicate is in the SQL. |
| Serialised writer | `src/writer.mjs` (`Writer` Durable Object) | **Defence in depth** (§2.3). One instance per key: `block:<id>` for `reserve`/`updateBlock`, `global` for the rest. In-memory promise queue with a 2 s queue-slot timeout (`WRITER_SLOT_MS`). Every multi-step flow still commits with **one** `batch()` of guarded statements. |
| Writer ops | `src/ops/*.mjs` | `reserve`, `completeDemo`, `handleWebhook` (checkout, payment_failed, refund.*, charge.refunded, account.updated), `claimCode` (idempotent per booking), `requestReset`, `resetPassword`, `createPt`, `createBlock`, `updateBlock`, `markAttendance`. |
| Rate limits | `src/ratelimit.mjs` | One D1 upsert … `RETURNING count` per attempt, key `scope:sha256(ip)`. Used on forgot/reset password now; login/signup when ported (phase 3). |
| Validation | `src/validate.mjs` | email/text/password (auth.cjs), toEpoch (db.cjs), num/blockData/colours/branding (server.cjs); errors are 400s. |
| Admin bootstrap | `scripts/bootstrap-admin.mjs` | One-off, outside the request path (§8). |
| Local config | `wrangler.jsonc` | D1 binding `DB` with **placeholder `database_id` `00000000-0000-4000-8000-000000000000` (local only)**. DO binding `WRITER` (SQLite-backed class, Free-plan compatible). `workers_dev:false`, `preview_urls:false`, no account_id, no routes. |

### CR items from spike PR #1
- **import.meta.url define removed.** The Worker path no longer uses `createRequire`, runtime `require(\`${runtimeRoot}/…\`)`, `import.meta.url`, `LAMBDA_TASK_ROOT` or `node:fs` reads of `app/public`. esbuild bundles only what is imported, so the nested v4 `fitspace/` tree is never reached and no CommonJS upload rules are needed. Dry-run bundle: 22.79 KiB / 7.30 KiB gzip at phase 1; **58.84 KiB / 16.54 KiB gzip** at phase 2. `netlify/functions/platform.mjs` is untouched; it stays the live Netlify path until cutover and is deleted then.
- **No DDL in the request path.** No `ensureSchema`, no `CREATE TABLE IF NOT EXISTS`, no `PRAGMA table_info` probing at runtime. Schema changes ship only as versioned files in `migrations/` (`wrangler d1 migrations apply`). The admin bootstrap that `app/public-mode.cjs` runs on every request is now the one-off `scripts/bootstrap-admin.mjs` (§8); the Worker never reads `ADMIN_*`.
- **Probes.** RC-4 has no `/__spike/*` routes. Test probes (`TestWriter`, the real `Writer` class with extra probe ops) exist only in `workers-test/entry.mjs` and are never part of the Worker bundle. If probes are ever added, keep RC-1's localhost-only guard.
- `.gitignore` covers `node_modules/`, `.wrangler/`, `.dev.vars` and `.netlify/`. `.dev.vars.example` lists names only.

## 2. Concurrency rules (no interactive transactions on D1)

D1 rejects `BEGIN` and `SAVEPOINT` (tested: `D1_ERROR: To execute a transaction, please use the state.storage.transaction()…`). `batch()` is atomic, and a failing statement rolls back the whole batch (tested). The replacements:

1. **Single-statement guarded writes** wherever possible. D1 runs one statement at a time, so these are race-free with no queue:
   - Capacity: a count-form guarded insert. `INSERT INTO bookings … SELECT … WHERE (SELECT count(*) … status IN ('paid','pending')) < b.capacity AND b.published=1 AND b.closed=0 RETURNING *`.
   - Rate limits: one upsert with `RETURNING count` (30 concurrent at max 10 → exactly 10).
   - Discount codes (now a batch, see 2b): redemption row first (`UNIQUE(code_id, booking_id)`), a guard that the code is usable, then `uses=uses+1`; backed by `CHECK(uses<=max_uses)`. A retry for the same booking is a replay and never counts twice.
2. **Unique indexes as locks:**
   - `bookings_one_live_per_customer` (partial, `status IN ('pending','paid')`)
   - `checkout_token` UNIQUE (idempotent retries)
   - `booking_payment_intent` (partial)
   - `webhook_events.id` PK
   - `waitlist_one_live_per_customer`
   - `discount_codes_unique (coalesce(pt_id,''), lower(code))`
2b. **Commit-time assertions (`db.guard`).** A batch cannot branch on a read, so a precondition is a statement: `INSERT INTO batch_guards(name,ok) SELECT ?,0 WHERE NOT (<cond>)`. `batch_guards.ok` has `CHECK(ok=1)` named `batch_guard_failed`; if the condition is false at commit time the insert violates the CHECK and D1 rolls back the whole batch (`isGuardFailure(error)`). When it holds nothing is inserted. Used for: `reset_link_valid`, `refund_total_within_payment`, `capacity_not_below_holds`, `dates_unlocked`, `booking_still_paid`, `code_available`.
3. **Multi-step flows read, then commit one guarded `batch()`.** Every shipped op is correct **without** the Writer; each has a test that runs it concurrently with the Writer bypassed (reserve, webhooks, claimCode, requestReset, resetPassword, refunds, updateBlock vs reserve, markAttendance vs cancel).
3b. **The Writer is defence in depth (decision, CR M2).** A Durable Object does **not** hold other requests while it awaits D1, so its promise queue is what serialises. `workers-test/writer.test.mjs` proves it on the real `Writer.run`: an unguarded read-then-write probe held 20/20 places at capacity 5 when called directly and exactly 5 through the Writer (deterministic: the probe yields between read and write). Mutation check: making `write()` skip the queue fails 3 writer tests and none of the shipped-op tests, which is the intended split. What the queue still buys: ordered outcomes on a key (precise "full"/"already booked" messages instead of a guard-abort 409 that needs a retry) and protection for any future op whose guard is incomplete. New ops must still ship with a no-Writer concurrency test.
3c. **Keying and timeout (decision, CR M3).** `writerKey()`: `reserve` and `updateBlock` (the contended pair) use `block:<blockId>`, so one trainer's busy block never queues another's. All other ops use `global` (cross-block, low volume, or system: webhooks, auth, admin, attendance, demo pay, codes). Each op holds its queue slot from when it **starts** until it settles or `WRITER_SLOT_MS` (default 2000 ms) passes. After the timeout later ops proceed; the slow op is not cancelled and its caller still gets its real result (no ambiguous "timed out but committed" response). This is safe only because of 3: correctness never depended on the queue. Tested: with a 150 ms slot a fast op finished at ~155 ms while a 1.2 s op was still running; a slow op on `block:A` did not delay `block:B`; removing the timeout fails the slot test.
4. **Reads after writes** inside a flow use `RETURNING`, or the commit-time value is computed in SQL (for example `CASE WHEN status='pending' AND expires_at>? THEN 'paid' ELSE 'review' END`).

### Webhook idempotency: the one rule
> **Insert the event key into `webhook_events` in the same `batch()` as the event's effects, as the batch's first statement. If the key already exists, the PRIMARY KEY violation aborts the whole batch, nothing is applied, and the endpoint answers 200 `{duplicate:true}`. If any effect fails, the whole batch (including the key) rolls back, Stripe retries, and the event is applied then.**

There is no separate "insert first, then process" step, and no `processing`/`failed` status row. A key is recorded **only** when its effects committed. The key is `<credential_id>:<evt_id>` for per-PT endpoints, or `<evt_id>` for the platform/Connect endpoint. Effects stay individually guarded too (`WHERE paid_at IS NULL`, `WHERE status='pending'`, `INSERT OR IGNORE` on `email_outbox.dedupe_key`). Tests: 5 concurrent HTTP deliveries → 1 received / 4 duplicate, and the same result when the Writer is bypassed.

### Phase 2 flows (all through `write()`, each one guarded batch)
| Flow | Route | Key guards | Tests (concurrency / duplicates / scope) |
|---|---|---|---|
| `completeDemo` | `POST /api/bookings/:id/pay` | `UPDATE … WHERE status='pending' AND expires_at>? RETURNING`; confirmation `INSERT OR IGNORE` dedupe | 5 concurrent pays → 5×200, 1 email; success vs fail race → one final state; expired → 409; other customer → 404 |
| `requestReset` | `POST /api/auth/forgot-password` (rate limit `forgot` 10/15 min/IP) | 3/hour limit row inserted `WHERE count<3 RETURNING`; reset + mail job `WHERE EXISTS(limit row)` | 10 concurrent → 3 links (with and without Writer); 11th request from one IP → 429 |
| `resetPassword` | `POST /api/auth/reset-password` (rate limit `reset` 15/15 min/IP), clears cookie | guard `reset_link_valid` (unused, unexpired, hash unchanged) | 5 concurrent uses → 1 ok / 4×400 (with and without Writer); sessions deleted |
| Refunds (`applyRefund` without SAVEPOINT) | webhook `refund.created/updated/failed` | upsert only replaces an older non-succeeded state; guard `refund_total_within_payment`; booking totals recomputed in SQL only when this event's state is stored | duplicate ×5 → 1; out-of-order stale event ignored; over-refund aborts event (key not recorded); 4 racing refunds (no Writer) → 1 commits |
| `charge.refunded` | webhook | monotonic `max()` | stale smaller total ignored |
| `account.updated` | webhook | `updated_at<=?` (event.created) | stale event ignored; duplicate ×5 → 1; mismatched account → 400 |
| `createPt` | `POST /api/admin/pts` (admin) | unique slug/email | 5 concurrent same slug → 1×201 / 4×409; PT → 403 |
| `createBlock` | `POST /api/blocks` | PT always uses own `pt_id` | body `pt_id` of another PT ignored |
| `updateBlock` | `PUT /api/blocks/:id` | `scopeFor().block`; guards `capacity_not_below_holds`, `dates_unlocked`; allowlisted `updateBlockStmt` | cross-PT → 404; capacity cut vs 4 reservations (Writer and no Writer, 5 rounds) → holds ≤ capacity |
| `markAttendance` | `POST /api/attendance` | `scopeFor().booking`; guard `booking_still_paid`; no-show email dedupe | 5 concurrent no-shows → 1 email, 1 row; cross-PT → 404 |

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
- **B. Down-migration (schema only, keeps other data).** Newest first, one command each: `npx wrangler d1 execute DB --remote --file migrations-down/0003_guards_and_expiry_index.down.sql`, then the 0002 file. Each file's last statement deletes its own `d1_migrations` row, so there is no manual second step. Data in the dropped tables/columns is lost, so export first. Locally tested: 0003 then 0002 down restore exact parity with `app/db.cjs` and remove both records; both re-apply cleanly.
- **Code:** roll the Worker back to the previous version with `npx wrangler rollback`. Migrations are additive, so the previous code runs against the newer schema.

**Cutover import pre-check (CR minor 4).** Before importing live data, load it into a scratch database at schema 0001 and run `scripts/cutover-precheck.sql`; it must return zero rows. Any `duplicate_live_booking` row would make 0002's `bookings_one_live_per_customer` fail. Resolving duplicates (keep the paid row, expire other holds) is a product decision to agree before cutover. Tested locally.

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
| `RESET_EMAIL_MODE` | var | password-reset.cjs | yes (reset is "configured" only when `send` + key + from + secret + https APP_URL) | `preview` (vitest: `send` with dummies) | per RC-10 |
| `WRITER_SLOT_MS` | var (optional) | — | `src/writer.mjs` queue-slot timeout | default 2000 | default 2000 |
| `DEMO_MODE` | var | server.cjs | yes | unset | unset (never demo) |
| `STRIPE_API_VERSION` | var (optional) | payments.cjs | phase 3 | default | pinned |
| `MAIL_FROM` | var | emails.cjs, password-reset.cjs | phase 3 | test domain | per RC-10 |
| `STRIPE_SECRET_KEY` | **secret** | payments.cjs, stripe-mode.cjs | phase 3 | test key in `.dev.vars` | `wrangler secret put` (test key until RC-OPS-2) |
| `STRIPE_WEBHOOK_SECRET` | **secret** | server.cjs, platform.mjs | yes (`/api/stripe/webhook`) | random per run in vitest; Stripe CLI value in `.dev.vars` | `wrangler secret put` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | **secret** | server.cjs | yes | `.dev.vars` | `wrangler secret put` |
| `CREDENTIAL_ENCRYPTION_KEY` | **secret** | pt-stripe.cjs (AES-GCM for legacy `pt_direct` keys) | phase 3, read-only for legacy rows | `.dev.vars` | until `pt_direct` rows are migrated, then removed |
| `AUTH_RESET_SECRET` | **secret** (≥32 chars) | password-reset.cjs (HMAC) | yes (`src/ops/password-reset.mjs`) | random per run in vitest; `.dev.vars` | `wrangler secret put` |
| `RESEND_API_KEY` | **secret** | emails.cjs, password-reset.cjs | presence checked now; delivery phase 3 | random dummy in vitest (never called) | per RC-10 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | bootstrap | public-mode.cjs (checked on **every** request) | **not a Worker secret**: `scripts/bootstrap-admin.mjs` | local script | run once with approval, then not stored |
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

## 7. Scoping rule (CR minor 6)
PT-owned tables (`blocks`, `bookings`, `class_sessions`, `attendance`, `email_outbox`, `discount_codes`, `discount_redemptions`, `waitlist_entries`, `stripe_refunds`) are queried directly only by the modules allowlisted in `workers-test/scope-lint.test.mjs`, each with its reason: `src/scope.mjs` (the layer itself), `src/emails.mjs` and `src/ops/webhooks.mjs` (system paths), `src/ops/bookings.mjs` (public block lookup; customer-own rows), `src/ops/manage.mjs` (keyed by an id first returned by `scopeFor`), `src/ops/codes.mjs` (keyed by code + booking; route scoping with RC-8), `worker/index.mjs` (the expiry sweep). Any other module that touches these tables fails the test until it is reviewed and added. Cross-PT tests: GET booking, updateBlock, attendance → 404.

## 8. Admin bootstrap (outside the request path)
```
ADMIN_EMAIL=you@example.com ADMIN_NAME="Site Admin" node scripts/bootstrap-admin.mjs --local [--persist-to <dir>]
# password from ADMIN_PASSWORD or stdin; never printed or written in plain text
```
Inserts an admin **only if none exists** (`INSERT … SELECT … WHERE NOT EXISTS(admin)`), rejects the old demo password and passwords under 12 characters, hashes with scrypt, writes the SQL to a 0600 temp file, runs `wrangler d1 execute DB --local --file`, and deletes the file. `--remote` also needs `--confirm-remote` and Kieran's approval; **not run**. Tested locally: two runs → 1 admin; `--remote` without confirm and the demo password are refused; no temp file left.

## 9. Phase plan and ETA
See the PR description for the live checklist. Phase 3 (login/signup/sessions, Stripe Checkout + stripe_jobs, mail worker/Resend, remaining server.cjs routes, rate limits on login/signup, cron for expiry/prune) ≈ 3.5 days; phase 4 (cutover rehearsal on a real D1 with approval, Time Travel drill, CPU check, Netlify decommission plan) ≈ 2 days. Code-complete estimate: **Wed 25 – Fri 27 Nov 2026**, assuming the real-D1/Workers Paid decisions arrive by then.
