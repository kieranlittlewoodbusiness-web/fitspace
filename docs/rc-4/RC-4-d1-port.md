# RC-4: storage port to Cloudflare D1

Status: **phase 2 of 4, local only** (phase 2 + CR review 5940135102 fixes). Decision: Kieran chose D1 (17 Nov 2026). Base `main` 7cebef2, branch `rc-4-d1`.
Phases 1–4 were local only. Cloudflare was touched only in the approved steps recorded in §12 (real D1 created, empty; remote rehearsal) and §13 (preview Worker, parked behind a disabled workers.dev route). No Stripe call was made.

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
| Local config | `wrangler.jsonc` | D1 binding `DB` → **real database `resiliencecoaching`, id `fd8a613f-4dd4-462b-83e0-d7673031a6fc`, location hint `weur` (created 17 Nov 2026, approved by Kieran; EMPTY until go-live, see §12)**. Local dev/tests still use a local copy. DO binding `WRITER` (SQLite-backed class, Free-plan compatible). `workers_dev:false`, `preview_urls:false`, no account_id, no routes. |

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
| `createPt` | `POST /api/admin/pts` (admin) | unique slug/email; **`create_key` UNIQUE** (phase 3, CR condition 3) | 5 concurrent same slug, different keys → 1×201 / 4×409; same key ×5 concurrent → 1 PT, same pt_id + temporary password; retry after a lost response → same temporary password; no key → 400 `CREATE_KEY_REQUIRED`; PT → 403 |
| `createBlock` | `POST /api/blocks` | PT always uses own `pt_id`; **`create_key` UNIQUE**, replay via `scopeFor().blockByCreateKey` | body `pt_id` of another PT ignored; same key ×5 concurrent (Writer and no Writer) → 1 block; another PT reusing a key → 409 `CREATE_KEY_REUSED` (id not revealed) |
| `updateBlock` | `PUT /api/blocks/:id` | `scopeFor().block`; guards `capacity_not_below_holds`, `dates_unlocked`; allowlisted `updateBlockStmt` | cross-PT → 404; capacity cut vs 4 reservations (Writer and no Writer, 5 rounds) → holds ≤ capacity, a rejected cut asserts 409 + code + `retryable`; cut with 4 holds → 409 `CAPACITY_BELOW_HOLDS` (message, `retry_after_seconds`), then close → holds expire → cut → 200 |
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
- **B. Down-migration (schema only, keeps other data).** Newest first, one command each: `npx wrangler d1 execute DB --remote --file migrations-down/0005_create_hash.down.sql`, then 0004 (`0004_phase3.down.sql`), then 0003 (`0003_guards_and_expiry_index.down.sql`), then 0002. Each file's last statement deletes its own `d1_migrations` row, so there is no manual second step. Data in the dropped tables/columns is lost, so export first. Locally tested: 0005, 0004, 0003 then 0002 down restore exact parity with `app/db.cjs` and remove all three records; all re-apply cleanly.
- **Code:** roll the Worker back to the previous version with `npx wrangler rollback`. Migrations are additive, so the previous code runs against the newer schema.

**Cutover import gate (CR minor 4; PM ruling 17 Nov 2026).** Load the source data into a LOCAL scratch database at schema 0001 and run `node scripts/cutover-import.mjs --persist-to <scratch>`. If any customer has more than one live (pending/paid) booking on a block (which would make 0002's `bookings_one_live_per_customer` fail), the import **STOPS** (exit 2) and writes `cutover-reports/duplicates-<ts>.json` (mode 0600, gitignored) with booking id, customer id, block id, payment status (`status`, `paid_at`, `refund_status`) and created time. No card data, payment ids, emails or secrets. `scripts/cutover-precheck.sql` is the same query (tested identical).
- **Never auto-delete or auto-refund.** The only resolution is opt-in: `--mark-duplicates-for-review --confirm mark-duplicates-for-review`. Per group it keeps the **earliest PAID** booking live (by `paid_at`; if none is paid, the earliest created) and moves the others to status **`review`**, each with an `audit_log` row (`action='cutover_duplicate_review'`) for the manual refund decision. Payments are untouched.
- **Why `review`, not a new `needs_review`:** `bookings.status` has a CHECK constraint; adding a value means rebuilding the bookings table (SQLite cannot alter a CHECK), which is risky at cutover. `review` already means "payment needs a manual decision" in the app (late payment after hold expiry) and already appears in the admin/PT dashboards; the audit row records the cutover reason. If the PM wants a distinct value, it is a table-rebuild migration in phase 4.
- Tested: workers-test/cutover.test.mjs (gate halts, exact report fields, nothing sensitive, refusal without the phrase, correct rows marked, audit rows, nothing deleted, gate then passes and the index is created, re-run is a no-op). Script run locally once on a scratch DB: exit 2 + report, refusal without `--confirm`, opt-in → gate passed.

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
| `STRIPE_API_VERSION` | var (optional) | payments.cjs | `src/stripe.mjs` | default | pinned |
| `MAIL_FROM` | var | emails.cjs, password-reset.cjs | `src/mail.mjs` | test domain | per RC-10 |
| `PT_INVITE_SECRET` | **secret** (≥32 chars) | — (new) | `worker/index.mjs` createPtRoute: HMAC(create_key) → retry-safe temporary PT password; 503 if unset | random per run in vitest; `.dev.vars` | `wrangler secret put` |
| `STRIPE_SECRET_KEY` | **secret** | payments.cjs, stripe-mode.cjs | `src/stripe.mjs` (Worker only) | vitest: random `sk_test_dummy…`, fetch mocked; test key in `.dev.vars` | `wrangler secret put` (test key until RC-OPS-2) |
| `STRIPE_WEBHOOK_SECRET` | **secret** | server.cjs, platform.mjs | yes (`/api/stripe/webhook`) | random per run in vitest; Stripe CLI value in `.dev.vars` | `wrangler secret put` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | **secret** | server.cjs | yes | `.dev.vars` | `wrangler secret put` |
| `CREDENTIAL_ENCRYPTION_KEY` | **secret** | pt-stripe.cjs (AES-GCM for legacy `pt_direct` keys) | `src/pt-credentials.mjs`, read-only for legacy rows (random per run in vitest) | `.dev.vars` | until `pt_direct` rows are migrated, then removed |
| `AUTH_RESET_SECRET` | **secret** (≥32 chars) | password-reset.cjs (HMAC) | yes (`src/ops/password-reset.mjs`) | random per run in vitest; `.dev.vars` | `wrangler secret put` |
| `RESEND_API_KEY` | **secret** | emails.cjs, password-reset.cjs | `src/mail.mjs` (Cron Trigger) | random dummy in vitest (fetch mocked) | per RC-10 |
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

## 7. Scoping rule (CR minor 6; per query since CR 5940418854 condition 1; hardened for CR 5940914487 M4)
PT-owned and per-tenant tables (`blocks`, `bookings`, `class_sessions`, `attendance`, `email_outbox`, `discount_codes`, `discount_redemptions`, `waitlist_entries`, `stripe_refunds`, `stripe_jobs`, and since M4 `pts`, `users`, `stripe_connections`, `pt_stripe_credentials`, `pt_subscriptions`) may only be queried through `scopeFor()`, except for **individually allowlisted queries**. `workers-test/scope-lint-core.mjs` extracts every SQL string/template literal in `src/`, `worker/` and `scripts/`, finds its enclosing function (`outer` or `outer>inner`) and fingerprints the normalised SQL. `workers-test/scope-lint.test.mjs` lists each allowed `file::function` with a reason and its exact query fingerprints. A new query, an edited query or a query moved to another function fails, and so does a stale entry. `worker/index.mjs` is scanned and must have **no** PT-owned SQL (asserted). A test injects `SELECT * FROM bookings` into `worker/index.mjs` and into an allowlisted function (`views.mjs::dashboard`) and asserts the lint catches both. To update after a reviewed change: `node workers-test/scope-lint-core.mjs` prints the current keys. Every route has a cross-tenant test (see §10).

**M4 hardening (CR 5940914487).** Table names match when quoted (`"x"`, `` `x` ``, `[x]`), schema-qualified (`main.x`) or separated from `FROM/JOIN/UPDATE/INTO` by comments (`FROM/**/x`, `FROM -- c` + newline); literal escapes (`\n`) are decoded before matching. Four more structural rules: (1) `worker/index.mjs` makes **no** SQL calls at all (`db.get/all/run/stmt/guard/exec`, `.prepare/.batch/.exec`); (2) every SQL call whose SQL is not one plain literal (concatenation or any other expression, a template with `${}`, an identifier) is listed in `NONLITERAL` with a reason and argument fingerprint; (3) raw access (`db[...]`, method references, destructuring `all/stmt/guard/batch/prepare/d1`, `.d1`, `env.DB` other than `createDb(env.DB)`) is forbidden outside `src/db.mjs`; (4) any use of a module-level SQL constant outside its own file must be listed in `CONST_USES`. Each CR bypass (concatenated, template, quoted, backtick, schema-qualified, block and line comments, `pt_stripe_credentials`, `users`, `pts`, the allowlisted `DUPLICATE_REPORT_SQL` constant) and each aliasing form has its own failing-case test, injected both into `worker/index.mjs` and into an allowlisted `src` function. Residual limit: JavaScript reflection (e.g. `Reflect.get(db, 'all')`) cannot be linted statically; review plus the cross-tenant route tests cover it.

**Guard mutations (CR 5940914487 M5).** `node scripts/guard-mutations.mjs` disables one guard at a time, runs the Workers suite without the scope lint and restores the file. The first 16 (11 `db.guard`s, the auth-mail claim, the two `create_key` unique indexes, the PT webhook event-match check, the `PT_INVITE_SECRET` length check) are killed by a behavioural test; with the later additions (6 in §14, 3 in §15) the current run is **25/25**. Tests in `workers-test/guards-direct.test.mjs` call the ops directly on D1 (Writer bypassed) with concurrent callers, or interleave a competing commit between an op's reads and its batch.


**CR 5941600057 M4 (structural guarantee, plus lint).** Static checks kept losing, so the main defence is now structural.
- **Structural:**
  - `createDb()` returns a frozen wrapper that does not expose the raw binding (no `.d1`).
  - `handle()`, the Writer (`appEnv`) and the cron (`cronTick`) hand routes, ops and views an env built by `withoutDb()`, which is frozen and has no `DB`. So `env.DB`, `const { DB: x } = env` and `env['DB']` downstream are `undefined`, and the only D1 handle there is the wrapper.
- **Lint additions:**
  - `\xHH`, `\uHHHH` and `\u{…}` escapes and line continuations are decoded.
  - `,` is a table lead-in (comma joins).
  - `get/all/run/stmt/exec/prepare/batch/guard` calls on any receiver other than `db` (or a statement from `prepare`/`stmt`) are reported and must be in `RECEIVERS`. There are 4 today: two node:sqlite calls in the import CLI, and the Durable Object `get`/RPC `run`.
  - Banned: `db` aliases (`= db`, `: db`, `=> db`, `? db`); the identifier `DB` except in `createDb(env.DB)`; destructured or computed `env`; `this.env`; `Reflect`; any `cloudflare:workers` import except the Writer's `DurableObject`.
- **Tests:**
  - 15 new lint bypass cases (CR's 6 plus neighbours).
  - `workers-test/scope-runtime.test.mjs`: one runtime test per CR case. It runs `GET /api/dashboard` as each of two PTs: exactly its own bookings, and no id of the other PT. It also checks the structure (frozen wrapper without `d1`; `DB` read exactly twice per request, both at the entry point; the Writer's `appEnv` has no `DB`).
- **Mutation run:** `node workers-test/scope-bypass-mutations.mjs` injects each CR case into `views.mjs` and `index.mjs`: those 12 are killed (the lint and the runtime test both fail). The current run is **20/20**: these 12, the paired case below, the 6 QA D2 file cases and CR 5943169048's `lib/zzhelper.mjs` repro (§15). With the env case in `index`, the request fails closed (503); removing `withoutDb` turns the same injection into a cross-PT leak (paired case, killed).
- `Reflect.get` stays the documented residual risk, and is now banned by the lint as well.
```
ADMIN_EMAIL=you@example.com ADMIN_NAME="Site Admin" node scripts/bootstrap-admin.mjs --local [--persist-to <dir>]
# password from ADMIN_PASSWORD or stdin; never printed or written in plain text
```
Inserts an admin **only if none exists** (`INSERT … SELECT … WHERE NOT EXISTS(admin)`), rejects the old demo password and passwords under 12 characters, hashes with scrypt, writes the SQL to a 0600 temp file, runs `wrangler d1 execute DB --local --file`, and deletes the file. **`--remote --confirm-remote` is OWNER-ONLY: the owner runs it, and only with Kieran's explicit yes for that run. Agents and CI never run it** (also in the script header and `--help`). **Not run.** Tested locally: two runs → 1 admin; `--remote` without confirm and the demo password are refused; no temp file left.

## 9. Phase plan and ETA
See the PR description for the live checklist. Phase 3 is done (§10). Phase 4 local work is done (§11). Remaining phase 4 work needs approval (see the approvals list in the PR): cutover rehearsal on a real D1 **with approval** (Time Travel drill, `wrangler d1 migrations apply --remote`, owner-run bootstrap), CPU check of scrypt on the chosen plan (RC-12 decision), Stripe test-mode end-to-end with real test keys (approval), the Netlify decommission plan, and main merge after #2 and #5 land. Code-complete estimate unchanged: **Wed 25 – Fri 27 Nov 2026**, assuming the real-D1/Workers Paid decisions arrive by then.

## 10. Phase 3 (routes, Stripe jobs, pt_direct read path, PT webhook, Cron Trigger)
**Routes.** Every `app/server.cjs` route is now in `worker/index.mjs`, which holds no SQL. Reads go through `scopeFor()` (`src/views.mjs`, `src/scope.mjs`), public reads through `src/public.mjs` (published PTs and blocks only), and multi-step writes through `write()` (Writer DO). Unknown `/api/*` → 404 (the phase 1–2 501 stubs are gone). Login (rate limit 15 per 15 min per IP) and signup (10) run in the Worker: each is one batch, the unique email gives 409, and scrypt stays out of the Writer queue. Unknown emails verify against a fixed dummy hash (same CPU, no enumeration). Password change goes through the Writer with guard `password_unchanged` (409 `PASSWORD_CHANGED_ELSEWHERE`). Cross-tenant tests: `workers-test/phase3-routes.test.mjs` and `phase3-stripe.test.mjs` (dashboard per role, public pages hide unpublished, admin routes 403 for PT/customer, booking GET/pay/cancel/checkout/refund 404 across customers and PTs, attendance 404 across PTs, PT payments setup shows own PT only).

**Stripe jobs (`src/ops/stripe-jobs.mjs`, `src/stripe-jobs.mjs`).** A Stripe call never runs inside the Writer. `prepare*` Writer ops validate under `scopeFor()` and `INSERT OR IGNORE` a `stripe_jobs` row with a deterministic id (`checkout:<booking>`, `cancel:<booking>`, `refund:<booking>:<token>`, `account:<pt>`, `onboard:<uid>`, `link:<uid>`). The id is also the Stripe `Idempotency-Key`. The Worker's `runJob` calls Stripe (12 s timeout), validates the response (mode, `cs_test_`/`cs_live_`, `checkout.stripe.com`/`connect.stripe.com` redirects, `acct_` ids) and commits through `completeJob`: one batch guarded by `job_not_done`, so concurrent or retried runs apply effects once and late runs get the stored result. Failures go through `failJob`: retryable (5xx/409/429, timeouts, owner key misconfiguration) → `retry` (hold kept, same key reused), otherwise `failed` (checkout booking → failed, refund → refund failed). One active refund per booking (guard `one_active_refund`). Tests mock `fetch`: 5 concurrent `runJob` → 5×200, 1 distinct Idempotency-Key, 1 effect; 5 concurrent refund requests → 1 job; 500 → retry, 400 → failed; cancel → GET + expire with `cancel:<id>`; connect chains account → onboarding link; admin link binds the platform account.

**Legacy `pt_direct` (read path only).** `src/pt-credentials.mjs` decrypts legacy rows (AES-256-GCM, AAD `id:pt_id:mode:field`, `CREDENTIAL_ENCRYPTION_KEY`) so existing pt_direct bookings can still be refunded or cancelled with the PT's own key (no `Stripe-Account`), and their webhooks verified. Ownership is re-checked per job (credential ↔ booking ↔ block PT, 403 on mismatch). Writes (`/api/pt/stripe/credentials|check|enable|disconnect`) → 410 `PT_DIRECT_WRITES_RETIRED`. Wrong master key → 503.

**PT webhook** `POST /api/stripe/pt/:credentialId/webhook`: signature with that PT's secret, `event.account` rejected, then the authoritative copy is fetched (`GET /v1/events/:id` with the PT key) and must match id/type/object. Applied with `handleWebhook({credentialId})` (event key `credentialId:eventId`), then `webhook_seen_at` is set. Tested: bad signature 400, `event.account` 400, authoritative mismatch 400, applied once then `{duplicate:true}`.

**Refund before payment success (CR condition 2).** A refund/`charge.refunded` event whose booking (from `metadata.booking_id` or an expanded PaymentIntent's metadata) has no recorded `payment_intent` yet → **409 `REFUND_BEFORE_PAYMENT`, nothing recorded**, so Stripe retries after the payment event. Tested end to end. Limitation: an event that names no booking is recorded as before (legacy behaviour).

**Cron Trigger** (`"triggers": {"crons": ["* * * * *"]}`, `scheduled()` → `runScheduled`): booking emails (`EMAIL_MODE=send` only; `@example.com` suppressed to `preview`; reply-to is the PT; backoff `min(1 h, 2^attempts min)`, max 5 attempts), password-reset/changed emails (dropped if the link is no longer valid), then hold expiry and `rate_limits` pruning. Each row is claimed by one guarded `UPDATE … RETURNING` lease (5 min) and Resend gets an Idempotency-Key (`dedupe_key` / `fitspace-auth:<id>`). Reset emails now go out on the next cron tick (≤ about 1 min) instead of inline. Logs carry counts only. Tests: two overlapping runs → each email sent once; failure → backoff, then sent with the same key; preview mode sends nothing; used reset link dropped; `scheduled()` wired.

**Capacity-cut playbook (PM ruling; CR condition 5).** Lowering capacity below live holds is refused with a clear retryable error, never by cancelling holds:
- `409 {code:"CAPACITY_BELOW_HOLDS", retryable:true, retry_after_seconds:<until the next hold expires>}`. The message gives paid/reserved counts. With only paid places it is `retryable:false` (cancel or refund first).
- `409 {code:"BOOKINGS_CHANGED", retryable:true, retry_after_seconds:1}`: a reservation landed between the check and the commit (guard `capacity_not_below_holds`). Refresh and retry.
- **Playbook:** 1) close the block to new holds (`closed: true` in `PUT /api/blocks/:id`); 2) wait for holds to expire (`retry_after_seconds`, at most the 30-minute checkout window) or for customers to finish or cancel; 3) cut the capacity (and reopen if wanted). Tested: cut with 4 holds → 409 with code/message/hint; close → new booking refused → holds expire → cut → 200.

**Retry-safe creates (CR condition 3).** Migration 0004 adds `pts.create_key` and `blocks.create_key` (partial UNIQUE indexes, NULL for old rows). Clients send a fresh `create_key` per create form. A retry or concurrent duplicate returns the same row (`replay:true`). For PTs, the temporary password is `HMAC(PT_INVITE_SECRET, create_key)`. It is never stored, so a retry after a lost response returns the same password while `must_change_password` is still set (afterwards `temporary_password: null`). scrypt runs in the Worker, not the Writer.

**Create-key reuse (CR 5940914487 minor 1).** Migration 0005 adds `pts.create_hash` and `blocks.create_hash` (sha256 of the normalised create payload). The same `create_key` with the same details replays the original record; with different details it returns **409 `CREATE_KEY_REUSED`** and changes nothing. Rows from before 0005 have NULL and are not checked.

## 11. Phase 4 (local only): snapshot import, ported tests, duplicate-import reason

### Snapshot → D1 import (`scripts/snapshot-import.mjs`)
The live app stores the whole SQLite database as one `bytea` row (`fitspace_preview_state.snapshot`, `lib/storage.mjs`). The import copies the snapshot to a private temp dir (the source is never modified), upgrades the copy with `app/db.cjs connect()` (the app's own migrations, so older snapshots are upgraded exactly as the live app would), checks tables and columns against `migrations/0001`, runs the cutover duplicate gate, and writes explicit-column `INSERT`s in FK order to a 0600 file. With `--persist-to <dir>` it applies every migration in `migrations/` to that **local** D1, refuses a non-empty target, executes the file and verifies row counts for all 17 tables. `--remote` is refused; the script uses `node_modules/.bin/wrangler` (no npx download).

| Step | Who | Command |
|---|---|---|
| 1. Export snapshot (reads production data) | **Owner only, needs Kieran's approval** | `psql "$DATABASE_URL" -At -c "SELECT encode(snapshot,'base64') FROM fitspace_preview_state WHERE namespace='<DATA_NAMESPACE>'" > fitspace.b64` |
| 2. Rehearse locally | anyone with the file (keep it off shared drives) | `node scripts/snapshot-import.mjs --snapshot fitspace.b64 --base64 --persist-to .rc4-import --out import.sql --report-dir cutover-reports` |
| 3. Duplicates found (exit 2) | PM decision | Re-run with `--mark-duplicates-for-review --confirm "<phrase>"` (see §10) |
| 4. Load the real D1 | **Owner only, after approval** | `wrangler d1 migrations apply DB --remote`, then `wrangler d1 execute DB --remote --file import.sql` |

Demo rehearsal (no production data): `scripts/demo-snapshot.mjs` builds a snapshot from `app/db.cjs` connect + seed. Locally verified: "row counts verified for 17 tables", source sha256 unchanged, output mode 600, second run refused ("Target D1 is not empty"), `--remote` refused.

### Duplicate imports (PM ruling)
Duplicates keep the existing `review` status (CHECK unchanged). `bookings` has no notes or metadata column (checked 0001–0005), so the reason is an `audit_log` row: `action='duplicate_import:kept=<kept booking id>'`, `target_id=<review booking>`, id `cutover-review-<booking>`. PT and admin dashboards show `review_reason` per booking: `{code:'duplicate_import', kept_booking_id}` or `{code:'payment_review'}` for other reviews; the customer view has no such key. Tested in `workers-test/cutover.test.mjs` and `tests/snapshot-import.test.mjs`.

### Fail closed on a mismatched platform key
Like `netlify/functions/platform.mjs:47`, with the Connect integration a configured `STRIPE_SECRET_KEY` that does not match `PAYMENT_MODE` now answers 503 on every `/api/` route except `/api/auth/*`, before any write (previously only the Stripe call failed, after the hold was written).

### Old test → Workers test mapping
The old suites still run in `npm test` (they test the Netlify path, which stays live until cutover). "Ported" = same scenario re-written against the Worker + D1.

| Old test | Workers coverage |
|---|---|
| `app/tests/platform.test.cjs` (10) | Ported 1:1: `workers-test/legacy-platform.test.mjs` on the imported demo snapshot, + demo login refused without `DEMO_MODE` |
| `tests/postgres.test.mjs` (5) | Ported: `legacy-postgres.test.mjs` (owner-setup 503 → bootstrap is outside the request path, §8; "storage failure" → failing D1 batch returns 503, nothing committed) |
| `tests/password-reset.test.mjs` (6) | 2 in `password-reset.test.mjs` (phase 2) + 4 gaps ported in `legacy-postgres.test.mjs` (rotated secret checked on the op: the Writer reads deployment secrets) |
| `tests/stripe-netlify.test.mjs` 1 sandbox onboarding | `phase3-stripe` "PT connect: account job then onboarding link"; `refunds-accounts` account.updated |
| 2 server price, pending until signed success | Ported: `legacy-stripe.test.mjs` |
| 3 lost responses / failed persistence → one session | `phase3-stripe` "concurrent runJob" + "Stripe 500 → retry"; `guards-direct` job_not_done |
| 4 expired / failed checkout release, decline keeps place | Ported: `legacy-stripe.test.mjs` |
| 5 refunds: who, pending/failed keep place, success releases, net revenue | Ported: `legacy-stripe.test.mjs`; `phase3-stripe` "another PT gets 404" |
| 6 late success → review; external partial/full refunds | `webhooks` "late success → review"; `refunds-accounts` (6 tests) |
| 7 competing reservations, other trainer cannot refund | `capacity.test` (reserve is mode-independent) + `phase3-stripe` "another PT gets 404" |
| 8 invalid modes, mismatched keys, setup without webhook secrets | Ported: `legacy-stripe.test.mjs` (+ fail-closed change above) |
| 9 live connected payments | Ported: `legacy-stripe.test.mjs` (dummy live key, fetch mocked) |
| 10 admin platform link, no connected header, routing match | `phase3-stripe` admin link; ported header/routing: `legacy-stripe.test.mjs` |
| `tests/pt-direct.test.mjs` 1, 2, 7, 8 (credential save/check/enable/disconnect, live enablement) | **Not ported by design**: pt_direct WRITE routes answer 410 (Kieran chose Connect, §10); `phase3-routes` asserts 410 |
| pt-direct 3 webhooks: PT secret, account-owned lookup, binding, duplicates | `phase3-stripe` PT webhook test; `guards-direct` event-match |
| pt-direct 4 refunds in the original PT account | `phase3-stripe` "refund uses the decrypted PT key"; "credential owned by another PT → 403" |
| pt-direct 5 replay without storing keys in operations | `phase3-stripe` (new assertion: job payloads hold `credential_id`, never a key) |
| pt-direct 6 cancellation/failure/expiry/late payment with PT keys | Mode-independent paths: `legacy-stripe`, `webhooks`, `capacity`; PT-key checkout itself is a retired write path |
| `tests/migration-v6.test.mjs` (1) | Not ported: D1 starts at the current schema (0001 = `app/db.cjs` at 7cebef2, parity in `migrations-rollback`). Older snapshots are upgraded by `app/db.cjs connect()` inside the import, and this test keeps running in `npm test` |

Also new: `route-parity.test.mjs` (every `app/server.cjs` route reaches a Worker handler while signed in; no 501 in `src/` or `worker/`).

## 12. Real D1 database and remote rehearsal (17 Nov 2026, approved by Kieran 15:27 UK)

Done through the Cloudflare connector's API (wrangler is not logged in). Scope was exactly the three approved items; no Worker, deploy, preview, secrets, Access, bootstrap, Stripe, Resend, DNS or Netlify.

1. **Real database**: `resiliencecoaching`, uuid `fd8a613f-4dd4-462b-83e0-d7673031a6fc`, `primary_location_hint: weur` (Western Europe, closest to the UK; no `jurisdiction`, because the `eu` jurisdiction excludes the UK and adds placement limits we don't need). Created 15:29 UK, running in WEUR, read replication disabled. **No migrations applied**: `sqlite_master` has no user objects (0 tables). Migrations wait for the go-live step (`wrangler d1 migrations apply DB --remote`).
2. **Rehearsal** on `resiliencecoaching-rehearsal-20261117` (uuid `23a1910b-7fe8-450d-9e7b-c1d694dc0c67`, WEUR), scripts from `docs/rc-4/d1-rehearsal/generate.mjs` (outside the scope-lint paths on purpose: unscoped rehearsal DDL, not app code):
   - Applied 0001 (21 statements), 0002 (26), 0003 (2), 0004 (6) and 0005 (2) in order via `/query` batches. Each batch ends with `INSERT INTO d1_migrations(name)` (wrangler's table shape), so 5 rows are recorded. The result is 23 tables and 12 indexes. The schema fingerprint `5610bf7e` is identical to the same migrations in local SQLite.
   - Synthetic data only (`example.com` users, a `REHEARSAL PT`, one block, session and booking). The `batch_guards` CHECK rejected a failed guard remotely (`batch_guard_failed`).
   - Down 0005 → 0004 → 0003 → 0002: each removed its own `d1_migrations` row. At the 0001 level there are 17 tables, the column parity with `app-schema-7cebef2.json` has 0 mismatches, and the synthetic rows are kept.
   - Re-applied 0002 → 0005: 5 migrations recorded again, fingerprint `5610bf7e`, and the `sqlite_master` diff is empty.
   - Note: the up files contain `--` comments with `;` in them. A line-based splitter breaks 0002, so the generator uses a comment- and string-aware splitter (wrangler handles this itself).
3. **Time Travel drill**:
   - Bookmark `00000000-00000028-00005126-dcbfb1dbecb3b686300635beea6025cd`.
   - Change: the PT brand_name was set to `CHANGED AFTER BOOKMARK` and the synthetic user `tt-drill-user` was added (users 2 → 3).
   - Restored to the bookmark (previous_bookmark `00000000-ffffffff-00005126-b3a489e1808605e8d65e87bfa054ae7c`). After the restore, brand_name is `REHEARSAL PT`, there are 2 users, the drill user is gone and d1_migrations still has 5 rows.
   - The rehearsal database was then **deleted**. The account list now shows only `resiliencecoaching`, and GET by id returns 404.


## 13. workers.dev preview (17 Nov 2026, item 6 approved 15:27/15:36 UK; Access approved 15:37 UK)

Everything was done through the Cloudflare connector's API (no wrangler login, no API tokens). Only the `preview` env was uploaded. The top-level/default env, which is bound to the production database `fd8a613f-…`, has **not** been deployed, and no Worker or cron is bound to the production database.

- **Plan check: NOT RUN through the API.** `GET /accounts/{id}/subscriptions`, `GET /user/subscriptions` and `GET /accounts/{id}/billing/profile` all return HTTP 403: the connector's OAuth scopes don't cover billing. Per the PM ruling (15:38 UK), Kieran's word that Workers Paid ($5/month) is active stands in for the check.
- **Preview D1:** `resiliencecoaching-preview`, uuid `81379d2e-c718-48b7-870d-1d189feea966`, WEUR.
  - 0001–0005 are applied and recorded in `d1_migrations` (23 tables).
  - The seed is synthetic only: one published PT `preview-trainer`, its trainer login at `example.com` (the password is in the git-ignored 0600 file `.secrets/preview.json`), one block and one session.
  - There's no admin user; the admin bootstrap stays owner-only.
  - Script: `docs/rc-4/d1-rehearsal/preview-apply.mjs`.
- **Worker:** `resiliencecoaching-preview` (`env.preview` in `wrangler.jsonc`).
  - Bindings: `DB` → `81379d2e-…` (preview only), `WRITER` → Durable Object namespace `cf8aedd7f82b4337bfbe8921daf0b2be` (SQLite class `Writer`, migration tag v1).
  - Vars: `EMAIL_MODE=preview`, `PAYMENT_MODE=stripe_test` (the app's test-mode value; there's no Stripe key, so Stripe calls fail closed before any request), `STRIPE_INTEGRATION=connect`, `APP_URL`.
  - Cron `* * * * *`. Observability is on.
  - Secret: `PT_INVITE_SECRET`. There's no Stripe or Resend secret.
- **Assets:** the connector can't run the static-assets direct-upload step (it needs the upload-session JWT as bearer, and the connector always sends its own credentials, so the call returned 401).
  - Instead, the upload ships `app/public` as Text modules, with `docs/rc-4/preview/entry.mjs` giving the unchanged Worker an `env.ASSETS` that serves the exact file, `/` → index.html, and index.html otherwise (SPA).
  - This was checked locally with `wrangler dev`: assets, the SPA fallback, security headers and the API all work.
  - Production keeps the real assets binding via `wrangler deploy`.
  - Generator: `docs/rc-4/preview/gen-upload.mjs`. It refuses to run if the production database id appears in the upload.
- **workers.dev:** `enabled:false`, `previews_enabled:false` (it was disabled on an inert 404 stub before the real upload). The would-be URL is `https://resiliencecoaching-preview.littlk.workers.dev`.
- **Access: BLOCKED.** The account has no Zero Trust organisation: `GET /access/organizations` returns 403 `access.api.error.not_enabled`. Per the brief, no organisation, Access app or policy was created, and **the workers.dev route stays OFF**.
  - Planned policy once the owner enables Zero Trust: a self-hosted app on the workers.dev hostname, Allow, include owner email (1 address), login method One-time PIN only, session 24h.
- **CPU check (scrypt, about 27 ms): NOT RUN.** There's no way to invoke the deployed Worker without the public route, other than an edge-preview session, which needs a preview token and so isn't used.
  - It will run after Access is in place and the route is on: the owner signs in once, then the Worker's telemetry is read for `exceededCpu` / 1102.

## 14. CR 5941600057 fixes (on top of c386472)

- **M4:** see §7 (structural guarantee, lint, runtime tests, bypass mutations 13/13 at the time; 20/20 after §15).
- **M6, Stripe readiness** (`worker/index.mjs` `paymentReadiness`, legacy `platform.mjs:47-49`).
  - Every non-diagnostic API route in Stripe mode needs:
    - a key matching the mode (pt_direct: `CREDENTIAL_ENCRYPTION_KEY`);
    - `STRIPE_WEBHOOK_SECRET` (Connect);
    - an https origin-only `APP_URL`.
  - It answers 503 before rate limits, Stripe or any row. This also closes the "missing or empty key writes a `stripe_jobs` row" gap.
  - Diagnostic routes are unchanged: `/api/me`, `/api/auth/*`, `/api/dashboard`, `/api/admin/*`, `/api/public/*`, `/api/pt/stripe/*` and the PT webhook.
  - Test: 7 misconfigurations, then 0 Stripe calls, 0 bookings and 0 jobs; diagnostics return 200; the control reaches Stripe; pt_direct is covered too.
- **Cron:** off unless `CRON_ENABLED` is exactly `"true"` (`cronTick`). Only `env.preview` sets it. Production sets it at the approved go-live step, so a deploy of the default env (real D1 id) runs nothing on a schedule. Tests: `cron-guard` (3), `tests/remote-guards` (3).
- **Generators:** `generate.mjs` (its step 2 runs down migrations) and `preview-apply.mjs` refuse the production id and non-uuids.
- **Snapshot import:**
  - `run()` is exported, with an injectable wrangler; the real one refuses anything without `--local`.
  - Freshness (no tables at all) is checked first, before migrations or reading the snapshot.
  - The persist dir is 0700.
  - A count mismatch deletes the imported rows again.
  - `.rc4-import/` and `import.sql` are gitignored.
  - 5 new tests; mutating out each of the 5 refusals fails a test.
- **Route parity:** (method, route) pairs are parsed from `app/server.cjs`, in all four forms. Changing a legacy method (POST→PUT, POST→GET) fails the test; 3 mutations were checked.
- **Weak ports strengthened:**
  - password-reset #6: the request limit persists with an identical answer; with reset off, `password_reset_available=false`, the generic 200 is returned and nothing is written (the route no longer calls the Writer when reset is off).
  - stripe-netlify #4: `payment_error` is asserted after a decline.
- **Guard mutations:** 22/22 killed at the time (25/25 after §15) (16 earlier plus 6 new: payment readiness ×2, reset-off, cron gate, Writer env, wrapper). The route env one is an equivalent mutant on its own and is covered by the paired bypass case above.
- **Preview (parked, not redeployed):** the next upload must carry `CRON_ENABLED` (added to `gen-upload.mjs`). With M6, its Stripe-mode payment routes answer 503 by design, because there's no key or webhook secret.
- **Merge of `origin/main` (1de6264: #2, #5, #6 RC-20) — normal merge commit `e16be05`:**
  - `package.json`: RC-4's Workers devDependencies and scripts + #5's `@netlify/zip-it-and-ship-it` ^16.6.0 and the `minimatch` ^11.0.1 / `glob` ^14.0.2 overrides. Lockfile = main's + `npm install`; only minimatch and glob moved in the Workers tree. `npm audit` 0, `npm ls --all` exit 0.
  - `app/public/app.js` auto-merged: RC-20 wording plus RC-4's `create_key` fields (lines 60/63); it differs from main only on those two lines.
  - RC-20 copy carried into the Worker port: auth email subjects/bodies ("Resilience Coaching", "contact your coach") in `src/mail.mjs`, and the public 404 "This page is not available." in `src/public.mjs`. Internal HMAC/Idempotency-Key prefixes (`fitspace-…`) are unchanged on purpose: changing them would invalidate live reset tokens and PT temporary passwords. Test: `tests/worker-copy-parity.test.mjs`.
- **Follow-ups (not fixed here):**
  - Minors 2–4 (mail backoff and attempt cap, the Resend key after an error, a refund-validation failure after the Stripe refund).
  - `bootstrap-admin --remote --confirm-remote` can reach the real id (owner-only by design).
  - A browser test of `app.js` `create_key`.

## 15. QA fixes (QA FAIL at f978692, 17 Nov 2026)

- **D1 (M6), Stripe actions under the legacy "diagnostic" prefixes.**
  - Legacy `platform.mjs:46` treats all of `/api/pt/stripe/*` and `/api/admin/*` as diagnostic. The port copied that, so `POST /api/pt/stripe/connect` wrote a `stripe_jobs` row (`kind=account`, `status=retry`) before `stripe()` answered 503.
  - Audit of every Stripe-touching route:
    - `POST /api/admin/stripe/link` had the same gap (a job row, then Stripe).
    - `POST /api/pt/stripe/status` called Stripe, then wrote `stripe_connections`.
  - These three are now `STRIPE_ACTIONS` in `worker/index.mjs` and run `paymentReadiness` (the checkout check) first, so they answer 503 before any write or Stripe call.
  - Still diagnostic, on purpose:
    - `GET /api/pt/stripe/setup` and `GET /api/admin/stripe/setup` (read-only).
    - `POST /api/admin/stripe/check` (one `GET /v1/account`, no write; `stripe()` refuses a missing or mismatched key before fetch).
    - The retired pt_direct writes (410, no write).
    - The PT webhook (the PT's own signing secret is verified before any Stripe call or write).
  - Test: `workers-test/stripe-actions-readiness.test.mjs`. For 7 misconfigurations × 3 routes: 503, 0 fetch calls, 0 `stripe_jobs`, and no `stripe_connections` or `audit_log` change. The diagnostics stay reachable, and a configured control does reach Stripe.
  - Guard mutations: +3.
- **D2 (M4), lint file discovery.**
  - The lint read only `*.mjs` under `src/`, `worker/` and `scripts/`.
  - It now reads:
    1. Every file reachable through the import graph from the Worker entry (`main` in `wrangler.jsonc`), the preview upload entry (`docs/rc-4/preview/entry.mjs`, whose `./index.js` is the Worker bundle) and every script. Relative imports resolve for `.js/.mjs/.cjs/.ts/.mts/.cts/.jsx/.tsx`, extensionless, `index.*`, and TS-style `./x.js` → `x.ts`.
    2. A backstop of every JS/TS file under `src/`, `worker/` and `scripts/`, excluding tests.
  - The graph fails closed on anything it cannot follow:
    - a relative import that does not resolve;
    - a non-literal `import()`/`require()`;
    - an absolute, `#`, `file:` or URL specifier;
    - Worker code importing the legacy app (`app/`, `netlify/`);
    - a script importing legacy code through an edge that isn't listed (4 are listed, all Node CLIs on legacy SQLite/Postgres, never D1).
  - Tests (`workers-test/scope-lint.test.mjs`, "file discovery"): QA's two misses, every extension (backstop and graph), a transitive `.js` → `.ts` chain, the `.ts` cases, and each fail-closed rule.
  - Runtime: `workers-test/scope-bypass-mutations.mjs` adds 6 file cases (`src/*.js`, `lib/*.mjs`, `lib/*/index.js`, `src/*.ts`, `lib/*.ts`, and QA's `src/*.js` reading `env.DB` imported from the Worker), each killed by the lint **and** the runtime cross-PT test.
- **D3, cron on the production config.** The top-level `triggers.crons` is removed: the default env (real D1 id) has no cron trigger and no `CRON_ENABLED`, and only `env.preview` has both. `wrangler deploy --dry-run` does not print schedules, so the check and `tests/remote-guards.test.mjs` read the config through wrangler's own resolver (`unstable_readConfig`, inheritance applied as a deploy would): default `crons=[]`, preview `["* * * * *"]`. The go-live step adds both to production, with approval.

### CR 5943169048 (APPROVE with merge conditions), folded into the same push

- **C1, scope lint and helpers outside the roots.**
  - CR's repro was `lib/zzhelper.mjs` with `export const q=(db,s)=>db.all(s)`, called from `src/views.mjs`. It is now caught twice:
    - The D2 graph scans the helper, which fails the non-literal SQL rule.
    - **Any relative import from the scanned code that resolves outside `src/`, `worker/` and `scripts/` fails** (`import outside the scanned roots`), even with harmless content, unless the edge is listed in `outsideEdges` (none today; a listed file is still scanned).
  - Tests: the exact repro and the outside-roots rule in `workers-test/scope-lint.test.mjs`. The runtime case `cr_zzhelper` in `scope-bypass-mutations.mjs` is killed: the lint fails, and the runtime test sees PT B's bookings.
- **C2, normalised production-id guard.**
  - New shared `docs/rc-4/d1-rehearsal/guard.mjs` (trim + lowercase, then exact id or 8-hex prefix). It is used by `generate.mjs`, `preview-apply.mjs` and `gen-upload.mjs`, and none of them keeps a private copy of the id.
  - `preview-apply.mjs` used a case-sensitive `startsWith` and, in a checkout with `.secrets/preview.json`, would have written a script for the upper-case production id. It is now refused by the guard itself, before reading secrets or writing.
  - Tests (`tests/remote-guards.test.mjs`): 7 spellings (upper case, leading/trailing space, tab/newline, mixed case, same prefix) × both generators, plus the guard on its own.
- **Nits:**
  - The backup `--local` check in `pinnedWrangler` (`scripts/snapshot-import.mjs`) is exported and tested on its own; removing it fails the test.
  - `tests/snapshot-import.test.mjs` and `tests/remote-guards.test.mjs` remove their `/tmp/rc4-*` folders in `after()`.
  - Stale counts fixed (guard mutations 25/25, scope mutations 20/20).
  - The `scope-runtime.test.mjs` header now points to `workers-test/scope-bypass-mutations.mjs`.

