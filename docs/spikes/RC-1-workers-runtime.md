# RC-1: Workers runtime spike (findings)

**Project:** Resilience Coaching (resiliencecoaching.app) · **Ticket:** RC-1 · **Owner:** Backend
**Date:** 17 November 2026, 13:40–14:00 Europe/London (GMT)
**Base:** `main` at `7cebef2` · **Branch:** `rc-1-workers-spike`
**Scope:** local only (`wrangler dev` / workerd via Miniflare, and `wrangler deploy --dry-run`). Nothing was deployed, no Cloudflare account calls or logins, no Cloudflare resources, DNS, Netlify, Stripe or Resend changes.

## Verdict: (B) the snapshot approach does NOT work on Workers

`node:sqlite` is only a **stub** in the Workers runtime: `import 'node:sqlite'` succeeds, but `new DatabaseSync(...)` throws `TypeError: Illegal constructor`. The app creates a `DatabaseSync` on every API request (`app/db.cjs:9` via `app/server.cjs:27`), so every `/api/*` request fails with the app's 503. Everything around SQLite does work: the Worker boots via a thin adapter, `/tmp` files round-trip, `pg` connects from workerd to Postgres, and the Postgres snapshot read/write (row lock + bytea) round-trips correctly, including under concurrency. The blocker is SQLite itself, so the recommendation is to **port state to real Postgres tables via Hyperdrive** (plan and estimate below).

> **Update, 17 Nov 2026 13:54 GMT (PM):** the storage target is now **open: Cloudflare D1 or Postgres via Hyperdrive**, and Kieran will decide. The RC-1 finding stands either way: the `node:sqlite` snapshot cannot run on Workers, so state must move to real tables. The Hyperdrive plan below is one of the two options. The [RC-5 to RC-8 addendum](#addendum-how-rc-5-to-rc-8-fit-the-storage-verdict) is written to hold for both.

Cloudflare's own docs agree: the Node.js compatibility page lists `node:sqlite` in the **stub modules** table (enabled by default from compatibility date `2026-01-29`, flag `enable_nodejs_sqlite_module`). Source: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (page last updated 12 Aug 2026, read 17 Nov 2026).

## Results at a glance

| # | Check | Result |
|---|---|---|
| 1 | Worker boots under `wrangler dev` | **FAIL unmodified** (`platform.mjs` as entry crashes at load). **PASS with the thin adapter + config** in this branch (`platform.mjs` itself not edited). |
| 2 | `node:sqlite` imports and works in workerd | **FAIL.** Imports; `DatabaseSync` constructor throws `Illegal constructor` (native stub). With a compat date before 2026-01-29 it falls back to the unenv polyfill: `[unenv] sqlite.DatabaseSync is not implemented yet!` |
| 3 | Temp-file snapshot path (`os.tmpdir()` + `node:fs/promises`) | **PASS** for fs: `mkdtemp`/`writeFile`/`readFile`/`rm` work, 1 MiB and 8 MiB files round-trip byte-exact (8 MiB write+read ≈ 10–14 ms wall locally). `/tmp` is **per-request**: a file written in request 1 is not visible in request 2. Opening those files with `DatabaseSync`: **NOT RUN** (blocked by #2). |
| 4 | `pg` from workerd → local Postgres; snapshot read/write round-trip | **PASS** (Postgres 18.6 on 127.0.0.1): schema creation, `withSnapshot()` load → modify file → save bytea → commit, verified by a marker in the stored bytes. 8 concurrent round-trips serialise correctly (no lost writes). **But** a module-level pool (as in `platform.mjs`) **hangs on the 2nd request**; pools/clients must be per request. |
| 5 | Bundle size vs limits | **PASS.** `Total Upload: 299.72 KiB / gzip: 70.19 KiB` vs 64 MiB uncompressed limit. |
| 6 | Other §9.3 risks | See risk table. |
| 7 | Static assets from `app/public` | **PASS.** `/`, `/app.js`, `/styles.css` and SPA routes (e.g. `/dashboard`) serve 200 with the app's security headers (CSP, `X-Frame-Options`, `no-store`, …); `POST /` → 405. |

### Worker size limits (re-checked)

The ticket quoted "Free 3 MB / Paid 10 MB compressed". The current Cloudflare limits page (https://developers.cloudflare.com/workers/platform/limits/, "Last updated Nov 13, 2026", read 17 Nov 2026) now says: **Worker size (uncompressed) 64 MiB on both Free and Paid; "There is no compressed size limit"; the gzip figure is shown for reference only.** Startup time limit is 1 second. The spike bundle is far inside either the old or the new limits.

## What is in this branch

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Minimal config: `main: worker/index.mjs`, `compatibility_date: 2026-11-01`, `compatibility_flags: ["nodejs_compat"]`, static assets from `app/public` (`run_worker_first: true`, SPA fallback), `workers_dev: false`, `preview_urls: false`, no `account_id`, no bindings to Cloudflare resources. Plus the adapter settings below. |
| `worker/index.mjs` | Thin adapter around **unmodified** `netlify/functions/platform.mjs`: `/api/*` → `createHandler({ getStorage })` with a **per-request** pg pool; other GET/HEAD → `env.ASSETS` + the app's `securityHeaders`; `/__spike/*` → probes (only on `127.0.0.1`/`localhost`). |
| `worker/probes.mjs` | Isolated runtime probes: `sqlite`, `fs`, `node`, `pg`, `snapshot`, `sqlite-snapshot`, `app`, `all`. Never return credential values. |
| `worker/probe-entry.mjs` | Probe-only entry (no app code) so one failing import cannot hide the others. |
| `.gitignore` | New (repo had none): ignores `.dev.vars`, `.env*`, `node_modules/`, `.wrangler/`, `.netlify/`, `dist-spike/`. |
| `.dev.vars.example` | Env var **names** only. |

Adapter settings needed to run `platform.mjs` unedited on workerd (each one is a porting finding):

1. `define: { "import.meta.url": "\"file:///netlify/functions/platform.mjs\"" }`: workerd leaves `import.meta.url` **undefined**, so `new URL('../../', import.meta.url)` throws `TypeError: Invalid URL string` at module load (boot crash, experiment E1).
2. `find_additional_modules` + `rules: [{ type: "CommonJS", globs: ["app/*.cjs"] }]`: `platform.mjs` loads `app/*.cjs` with runtime-computed `require()` paths that esbuild cannot follow, so they must be uploaded as separate CommonJS modules. Workerd registers them as `app/server.cjs`; `require('/bundle/app/server.cjs')` fails (`No such module "bundle/app/server.cjs"`), while the `//app/server.cjs` produced by the define above resolves.
3. Text/Data/CompiledWasm/ESModule rules with `fallthrough: false` and no-match globs: otherwise the default module rules scan `node_modules/` and the nested v4 `fitspace/` tree into the upload (first attempt was `9729.71 KiB`).
4. Per-request pg pool injected through `createHandler({ getStorage })`. `platform.mjs`'s own module-level `pool` cannot be reused across requests on Workers.

## Commands and output

Environment: Node v24.22.1, npm 11.21.1, wrangler 4.164.0 (workerd 1.20261117.1), installed **outside** the repo (`/workspace/resiliencecoaching/tools`) so `package.json`/`package-lock.json` are untouched. `WRANGLER_SEND_METRICS=false`. Postgres 18.6 from the `embedded-postgres` npm binaries, listening on 127.0.0.1:55432 with a throwaway local user/password (the apt mirror was unavailable from the box: `500 Internal Server Error`). Credentials live only in the git-ignored `.dev.vars`; wrangler prints them as `(hidden)`.

### E1: unmodified `platform.mjs` as the Worker entry (FAIL)

```
$ wrangler dev netlify/functions/platform.mjs --port 8787 --ip 127.0.0.1
⎔ Starting local server...
✘ [ERROR] service core:user:resiliencecoaching-rc1-spike: Uncaught TypeError: Invalid URL string.
    at null.<anonymous> (platform.js:5732:18)
✘ [ERROR] The Workers runtime failed to start. There was likely a problem with the workerd binary or your configuration.
```
`dist` shows the offending lines: `var sourceRoot = new URL("../../", import.meta.url);` and `createRequire(new URL("../../package.json", import.meta.url))`. The E1 dry-run bundle (`Total Upload: 196.43 KiB / gzip: 41.92 KiB`) also silently **omits** `app/*.cjs`, because of the dynamic `require()` paths.

### E2: isolated probes (`worker/probe-entry.mjs`)

```
$ curl -s http://127.0.0.1:8789/__spike/sqlite
{ "exports": ["DatabaseSync","StatementSync","backup","constants","default"],
  "DatabaseSyncType": "function", "ok": false, "name": "TypeError", "message": "Illegal constructor" }

$ wrangler dev worker/probe-entry.mjs --compatibility-date 2025-12-01 ...
$ curl -s http://127.0.0.1:8792/__spike/sqlite
{ "exports": ["DatabaseSync","StatementSync","constants","default"],
  "DatabaseSyncType": "function", "ok": false, "name": "Error",
  "message": "[unenv] sqlite.DatabaseSync is not implemented yet!" }

$ curl -s http://127.0.0.1:8789/__spike/fs     # request 2 in the same isolate
{ "tmpdir": "/tmp/", "folder": "/tmp/fitspace-preview-13", "roundTripEqual": true, "size": 1048576,
  "listing": ["working.sqlite"], "big8MiBEqual": true, "big8MiBMs": 11,
  "previousRequestFileVisible": false, "removed": true, "ok": true }

$ curl -s http://127.0.0.1:8789/__spike/pg
{ "serverVersion": "18.6", "schema": "ok", "ok": true }

$ curl -s http://127.0.0.1:8789/__spike/snapshot    # twice
{ "loadedFromPostgresBytes": 0,  "withSnapshotMs": 3, "status": 200, "bytesBefore": null, "bytesAfter": 37, "markerPersisted": true, "ok": true }
{ "loadedFromPostgresBytes": 37, "withSnapshotMs": 3, "status": 200, "bytesBefore": 37,   "bytesAfter": 74, "markerPersisted": true, "ok": true }

$ curl -s "http://127.0.0.1:8789/__spike/snapshot?pool=shared"   # module-level pool, like platform.mjs; 2 requests
HTTP 200 0.021878s
HTTP 500 0.006534s
Error: The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.

$ curl -s http://127.0.0.1:8789/__spike/sqlite-snapshot
{ "ok": false, "name": "TypeError", "message": "Illegal constructor" }
```

8 concurrent snapshot round-trips (per-request pools), each appending a 37-byte marker under `SELECT … FOR UPDATE`:
```
ok=True loaded=444 after=481
ok=True loaded=481 after=518
...
ok=True loaded=703 after=740
start=444 expected=740 actual=740
```

Node API probe (`/__spike/node`), all under `nodejs_compat`:

| API | Result |
|---|---|
| `crypto.scryptSync`, `randomUUID`, `timingSafeEqual`, `createHash`, `createHmac` | ok |
| `crypto` AES-256-GCM seal/open, same pattern as `app/pt-stripe.cjs` (AAD + utf8 + auth tag) | ok (`"rk_test_example"` round-trips) |
| `stream.Readable.from` (used by `lib/bridge.mjs`) | ok |
| `import.meta.url` | `undefined` (no define) |
| `module.createRequire(import.meta.url)` | throws `ERR_INVALID_ARG_VALUE` |
| `module.createRequire('/bundle/x.js')` | ok |
| `require('/bundle/app/server.cjs')` | `No such module "bundle/app/server.cjs"` |
| `fs.readdir('/bundle')` | ok |
| `process.env` populated from `.dev.vars` | ok (booleans only) |
| `import('node:http')` | resolves (`createServer` is a function); not used on the Function path |
| `crypto.randomBytes(n > 65536)` | throws `QuotaExceededError` (workerd caps `getRandomValues` at 64 KiB; the app only uses 12/16/32 bytes) |

### E3: full app through the adapter (`wrangler dev`, default entry)

```
$ wrangler dev --port 8789 --ip 127.0.0.1
Using secrets defined in .dev.vars
[wrangler:info] Ready on http://127.0.0.1:8789
GET / -> HTTP 200 text/html; charset=utf-8
GET /app.js -> HTTP 200 text/javascript; charset=utf-8
GET /styles.css -> HTTP 200 text/css; charset=utf-8
GET /dashboard -> HTTP 200 text/html; charset=utf-8
GET /api/me -> HTTP 503 application/json
GET /__spike/pg -> HTTP 200 application/json
GET /__spike/pg with Host: spike.example -> HTTP 404

$ curl -sI http://127.0.0.1:8789/
Cache-Control: no-store
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN

$ curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:8789/api/me
{"error":"The preview could not save or load its data. Check DATABASE_URL, Node 24 and the function logs, then try again."}
HTTP 503
✘ [ERROR] FITSPACE request failed: TypeError

$ curl -s http://127.0.0.1:8789/__spike/app      # same require + createApp path, with the error exposed
{ "requireServerCjs": "function", "ok": false, "name": "TypeError", "message": "Illegal constructor",
  "stackTop": [ "TypeError: Illegal constructor",
    "at new DatabaseSync (node:sqlite:8:15)",
    "at connect (file:///…/RC-1/app/db.cjs:9:130)",
    "at createApp (file:///…/RC-1/app/server.cjs:27:10)" ] }
```
Postgres confirms the Workers `/api/*` attempts rolled back (no `rc1-spike` row came from workerd).

**Control (Node 24, same handler, same local Postgres):** `/api/me 200`, `/api/public/pts 200 {"pts":[]}`, and a 221,184-byte SQLite snapshot saved for namespace `rc1-spike`. So the database setup and the app are fine; only the runtime differs.

### Bundle size (dry run only, no upload)

```
$ wrangler deploy --dry-run --outdir dist-spike/worker
Attaching additional modules:
│ app/auth.cjs … app/stripe-mode.cjs  (9 CommonJS modules)  │ Total (9 modules) │ 92.40 KiB │
✨ Read 3 files from the assets directory …/RC-1/app/public
Total Upload: 299.72 KiB / gzip: 70.19 KiB
--dry-run: exiting now.
```
`index.js` 212,162 bytes (45,285 bytes `gzip -9`). Static assets (3 files, ~93 KiB) are separate and do not count toward Worker size.

### Existing suites (Node 24, unchanged code)

`npm run build` → "Netlify source checks passed." · `npm test` → `tests 40 / pass 40 / fail 0` · `npm run test:bundle` → `tests 29 / pass 29 / fail 0`.

## §9.3 risk table

| §9.3 risk | Result | Evidence / reason | Next action |
|---|---|---|---|
| 1. `node:sqlite` (`DatabaseSync`) | **FAIL** | Native stub, `Illegal constructor`; unenv polyfill `not implemented` on older dates; listed as a stub module in Cloudflare docs. | Port to Postgres tables via Hyperdrive (plan below). |
| 2a. Temp files under `os.tmpdir()` (`mkdtemp`/`writeFile`/`readFile`/`rm`) | **PASS** | 1 MiB + 8 MiB byte-exact; per-request `/tmp` confirmed. | None if the snapshot design is kept (it isn't recommended). |
| 2b. `DatabaseSync` opening a VFS `/tmp` file | **NOT RUN** | Blocked by risk 1. | Moot after the Postgres port. |
| 2c. CPU/time at 8 MiB load/save per request | **NOT RUN** | Local workerd does not enforce production CPU limits. Free plan is 10 ms CPU/request, Paid 30 s default. A whole-DB load/save per request is a poor fit for 10 ms. | Moot after the Postgres port; otherwise measure on a deployed preview (needs PM approval). |
| 3a. `pg@8.16.3` from workerd → Postgres | **PASS (local, direct TCP)** | Connect, DDL, row lock, bytea read/write, 8-way concurrency. | — |
| 3b. Connection reuse across requests | **FAIL as written** | Module-level `pool` in `platform.mjs` hangs on request 2. | Create the client/pool per request (as the adapter does); with Hyperdrive use `env.HYPERDRIVE.connectionString` per request. |
| 3c. Hyperdrive in front of Postgres | **NOT RUN** | Creating Hyperdrive is not approved. | After approval: create a Hyperdrive config for a **test** DB and repeat `/__spike/pg` + `/__spike/snapshot` via `wrangler dev` with `localConnectionString`, then on a preview. |
| 3d. TLS / `sslmode` from the provider URL | **NOT RUN** | Local Postgres has no TLS. Hyperdrive terminates TLS to the origin. | Test against the real provider via Hyperdrive. |
| 4a. `node:crypto` (scrypt, randomUUID, timingSafeEqual, hash, hmac, AES-256-GCM) | **PASS** | Probe table above. | Note: `randomBytes` > 64 KiB throws; app usage is ≤ 32 bytes. |
| 4b. `node:module` `createRequire` + CommonJS `app/*.cjs` | **PASS with config** | Requires `find_additional_modules` + CommonJS rule and the `import.meta.url` define; absolute `/bundle/...` specifiers fail. | In the real port, replace runtime `require()` with static imports so esbuild bundles everything (no define/rules). |
| 4c. `import.meta.url` / `node:url` / `LAMBDA_TASK_ROOT` | **FAIL as written** | `import.meta.url` undefined → boot crash (E1). | Remove path arithmetic; static imports. |
| 4d. `node:stream.Readable` (`lib/bridge.mjs`) | **PASS** | Probe + bridge used on the `/api/*` path up to SQLite. | — |
| 4e. `node:fs` reading `app/public` | **PASS (replaced)** | Served by Workers Static Assets with the app's security headers; the Function's `readFile` path is no longer used. | Keep Static Assets. |
| 5. `node:http` / `setInterval` (local server, email worker) | **NOT RUN (out of scope)** | Not on the Function path (`startEmailWorker: false`). `node:http` import resolves. | If real email sending is enabled later, use a Cron Trigger or Queue. |
| 6. Snapshot store not production-ready | **FAIL by design** | Whole-DB serialisation per request and a global lock; docs already say to migrate to relational tables. | Same as risk 1. |
| Extra: Worker boots | **PASS with adapter** | `Ready on http://127.0.0.1:8789`. | — |
| Extra: bundle size | **PASS** | 299.72 KiB raw / 70.19 KiB gzip vs 64 MiB. | — |
| Extra: static assets + SPA fallback | **PASS** | See E3. | — |

## Plan if (B): port to real Postgres tables via Hyperdrive

**Schema sketch.** One Postgres table per existing SQLite table (17): `pts`, `users`, `sessions`, `blocks`, `class_sessions`, `bookings`, `attendance`, `email_outbox`, `webhook_events`, `audit_log`, `stripe_jobs`, `stripe_refunds`, `stripe_connections`, `password_resets`, `password_reset_limits`, `auth_mail_jobs`, `pt_stripe_credentials`, in a `fitspace` schema. Type mapping: `TEXT` ids → `text` (UUID strings kept); integer epoch columns → `bigint` (keep epoch to avoid touching business logic; `timestamptz` later); 0/1 flags → `boolean` or `smallint`; JSON-in-TEXT (e.g. `pts.features`) → `jsonb`. Keep FKs, UNIQUE constraints and indexes as in `app/db.cjs`. Keep `fitspace_preview_limits` for rate limits. Retire `fitspace_preview_state` after migration (keep it read-only for rollback).

**Code changes.**
- `app/db.cjs`: replace `DatabaseSync` with a small async DB layer over `pg` (`get/all/run`, `?` → `$n`), and `tx()` (`BEGIN IMMEDIATE`) → a `BEGIN … COMMIT` on one client with `SELECT … FOR UPDATE` on capacity rows (booking oversell and Stripe reservation races are covered by existing tests).
- ~140 `prepare()` call sites across 9 modules become `await`; their callers become `async` (`payments.cjs` 61, `password-reset.cjs` 18, `server.cjs` 14, `pt-stripe.cjs` 12, `emails.cjs` 11, `db.cjs` 11, `auth.cjs` 5, `stripe-mode.cjs` 5, `public-mode.cjs` 3).
- SQLite-isms: `INSERT OR IGNORE` (3) → `ON CONFLICT DO NOTHING`; `PRAGMA` (8) removed; `BEGIN IMMEDIATE` (2) → explicit locking.
- `lib/storage.mjs`: drop `withSnapshot`/temp files; keep `checkLimit`.
- `platform.mjs` → Worker entry: static imports (no `createRequire`/`import.meta.url`/`LAMBDA_TASK_ROOT`), per-request `pg.Client` from `env.HYPERDRIVE.connectionString`, Static Assets for `app/public`.
- Tests: run the 40 + 29 suites against Postgres (PGlite is already a devDependency) and add a Workers smoke run under `wrangler dev`.
- Data migration script: a one-off Node 24 script reads the latest `fitspace_preview_state` snapshot with `node:sqlite` and inserts rows into the new tables in one transaction. Idempotent, with row counts checked; rollback is to keep reading the untouched snapshot table.

**Estimate (Backend):** about **10 developer-days** (range 9–12): schema + migration script 1.5 d; DB layer + transactions 1 d; module conversion 4–5 d (payments is the bulk); Worker entry + Hyperdrive wiring 0.5 d; tests 2 d; migration rehearsal + rollback notes 1 d. Plus about 2 QA days. Needs PM approval for a Hyperdrive config on a **test** database before the preview.

**Alternative considered, not recommended (not tested):** a WASM SQLite (e.g. sql.js) would keep the snapshot design, but it adds a WASM blob, still loads and saves the whole DB per request (risky against the Free 10 ms CPU limit), and keeps the global write lock.

## Environment variable names

Used by this spike (in git-ignored `.dev.vars`; see `.dev.vars.example`): `DATABASE_URL`, `DATA_NAMESPACE`, `PAYMENT_MODE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`. Set in `wrangler.jsonc` `vars`: `EMAIL_MODE` (`preview`, matching the Netlify function's override). Tooling only: `WRANGLER_SEND_METRICS=false`. No other names were added or changed. For the port, `DATABASE_URL` would become a Hyperdrive binding (`HYPERDRIVE`) in production, and `LAMBDA_TASK_ROOT` would be dropped.

## How to run locally

```bash
# 1. Wrangler outside the repo (keeps package-lock.json untouched until RC-2)
mkdir -p ../tools && (cd ../tools && npm init -y && npm i wrangler@4.164.0)
# 2. App deps without rewriting the out-of-sync lockfile (RC-2)
npm install --no-package-lock
# 3. A local, throwaway Postgres (any local server, docker, or embedded-postgres)
cp .dev.vars.example .dev.vars   # fill DATABASE_URL etc. with LOCAL values only
# 4. Run
export WRANGLER_SEND_METRICS=false
../tools/node_modules/.bin/wrangler dev --ip 127.0.0.1 --port 8789
curl -s http://127.0.0.1:8789/__spike/all          # all probes
curl -s http://127.0.0.1:8789/__spike/sqlite       # one probe
../tools/node_modules/.bin/wrangler dev worker/probe-entry.mjs --port 8788   # probes without app code
../tools/node_modules/.bin/wrangler deploy --dry-run --outdir dist-spike/worker   # size only, no upload
```
Do **not** run `wrangler deploy` without `--dry-run`, `wrangler login`, or any resource-creating command; none is approved.

## Blockers and notes

- **RC-2 (lockfile):** did not block. Worked around with `npm install --no-package-lock`; `package.json` and `package-lock.json` are unchanged.
- **RC-3 (nested v4 `fitspace/` tree):** did not block, but it **was pulled into the Worker upload** by wrangler's default module rules until they were overridden (`9729.71 KiB` → `299.72 KiB`). Removing the tree in RC-3 removes that foot-gun.
- `/__spike/*` routes are spike-only and must not ship; they answer only on `127.0.0.1`/`localhost`.

## Addendum: how RC-5 to RC-8 fit the storage verdict

*Added 17 Nov 2026, about 14:00 GMT, at the PM's request. Sources are `TICKETS.md` (Kieran's decisions, 13:47 UK), the repo code at `7cebef2`, and the public Stripe and Cloudflare docs. **Test mode only.** No Stripe account access, no Stripe API calls and no keys were used. The storage target (D1 or Postgres via Hyperdrive) is open, so everything below holds for both, and differences are called out inline.*

**Model (Kieran):**
- Stripe Connect **direct charges**: the PT is the merchant of record and has the full Dashboard. Stripe collects its fees from the PT and is liable for losses.
- **Stripe-hosted onboarding** (account links).
- **No application fee.**
- Platform revenue is only a **monthly PT subscription** on the platform account (Billing + Customer Portal), with the price configurable.
- Discount codes.
- The paste-your-own-keys `pt_direct` flow is retired for new PTs, and existing records are migrated.

**What already exists in the repo:** the legacy `STRIPE_INTEGRATION=connect` path already matches most of this model, so RC-5 and RC-6 are a revive-and-harden job, not a rewrite.
- `payments.cjs` `prepareConnect` creates a **v2 Account** with `dashboard:'full'`, `fees_collector:'stripe'`, `losses_collector:'stripe'`, GBP and `en-GB`, then `/v2/core/account_links` with return/refresh URLs.
- Checkout already routes with the `Stripe-Account` header.
- Stripe calls use plain `fetch` with `Idempotency-Key`, through a durable `stripe_jobs` queue.
- `verifyWebhook` does HMAC-SHA256 with a 300 s tolerance.
- `webhook_events` dedupes by event id.
- There is **no** application fee anywhere today.

### Tables and columns (both storage options)

Types are written for Postgres. On D1 use `TEXT` / `INTEGER` (epoch seconds, 0/1 flags) and `TEXT` JSON, since D1 is SQLite. Every Stripe-facing row carries `mode` (`stripe_test`/`stripe_live`) so test and live data never mix.

| Table | Key columns | Notes / ticket |
|---|---|---|
| `stripe_accounts` (replaces `stripe_connections` + `pt_stripe_credentials` for new PTs) | `pt_id`, `mode`, `account_id` (UNIQUE per mode), `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements_currently_due` (json), `requirements_past_due` (json), `disabled_reason`, `status_source_ts`, `updated_at`; PK `(pt_id, mode)` | RC-5. `status_source_ts` guards against out-of-order status updates. Keep `pt_stripe_credentials` read-only for historical `pt_direct` bookings and refunds until migrated. |
| `stripe_webhook_events` (replaces `webhook_events`) | PK `(endpoint, event_id)`, `type`, `account_id` (null for platform), `object_id`, `received_at`, `processed_at`, `status` (`processing`/`done`/`failed`), `attempts`, `last_error` | All tickets. Idempotency is `INSERT … ON CONFLICT DO NOTHING` (both Postgres and D1/SQLite support it), and "inserted 0 rows" means a duplicate. Also store `(type, object_id)` to catch the rare "two Event objects for one change" case Stripe documents. |
| `stripe_jobs` (existing) | as today | Kept: outbound calls stay idempotent and retryable. |
| `bookings` (existing, extended) | add `list_price_pence`, `discount_code_id`, `discount_pence`. `amount_pence` = the final charged amount. Keep `checkout_session` UNIQUE, `stripe_account_id`, `refund_status`, `refunded_pence` | RC-6, RC-8. Capacity holds stay as today (`status='pending'` + `expires_at`). |
| `platform_customers` | PK `(pt_id, mode)`, `customer_id` UNIQUE | RC-7. Stripe Customer on the **platform** account for each PT. |
| `pt_subscriptions` | PK `(pt_id, mode)`, `subscription_id` UNIQUE, `customer_id`, `price_id`, `status`, `current_period_end`, `cancel_at_period_end`, `grace_until`, `status_source_ts`, `updated_at` | RC-7. `grace_until` = first unpaid time + grace days. A scheduled job unpublishes `blocks`/`pts` once `now > grace_until`. |
| `billing_settings` | `mode`, `price_id`, `grace_days` (default 7), `updated_by`, `updated_at` | RC-7. The amount lives in Stripe (Product/Price), so Kieran's price change means a new Price id here and no code change. |
| `discount_codes` | `id`, `code` (normalised upper-case, UNIQUE per `mode`), `owner` (`pt`/`admin`), `pt_id` (null = admin, any PT), `kind` (`percent`/`fixed`), `value`, `currency`='gbp', `applies_to` (`all`/`classes`), `starts_at`, `expires_at`, `max_uses`, `uses`, `active`, `created_by` | RC-8 (a)(b). These are **local** codes, not Stripe coupons, because with direct charges the price is set by us and passed to Checkout as the final `unit_amount`. |
| `discount_code_classes` | PK `(code_id, block_id)` | RC-8 per-class scope. |
| `discount_redemptions` | `code_id`, `booking_id` UNIQUE, `customer_id`, `amount_off_pence`, `status` (`held`/`redeemed`/`released`) | RC-8. Held with the capacity hold, redeemed on `checkout.session.completed`, and released on expiry/failure. `max_uses` is enforced with a conditional `UPDATE discount_codes SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)` that must affect 1 row. |
| `subscription_promotion_codes` | `promotion_code_id` UNIQUE, `coupon_id`, `code`, `mode`, `active`, `created_by`, `created_at` | RC-8 (c). This **mirrors/references** Stripe Coupons + Promotion Codes on the platform account. Stripe is the source of truth, and Checkout (subscription mode) gets `discounts:[{promotion_code}]` or `allow_promotion_codes`. |
| `pts` / `blocks` (existing) | add `pts.bookings_paused_reason` | RC-7 lapse handling. `published` already exists. |

### Webhook handling on Workers

- **Endpoints and secrets:**
  - **Platform endpoint** (scope "Your account"), signed with `STRIPE_WEBHOOK_SECRET`. It carries `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed` and subscription-mode `checkout.session.completed`. It also gets `v2.core.account.*` events, which for v2 Accounts arrive on the **platform** scope as v2 events.
  - **Connect endpoint** (scope "Connected accounts"), signed with `STRIPE_CONNECT_WEBHOOK_SECRET`. It carries direct-charge `checkout.session.completed/expired/async_payment_*`, `charge.refunded`/`refund.updated`, and v1 `account.updated`. Stripe's Connect docs say v2 Accounts emit **both** v1 and v2 events with different scopes, so RC-5 should handle `account.updated` on the Connect endpoint and treat v2 account events as a trigger to re-read the account.
  - Both env names already exist in the repo.
  - The per-PT webhook endpoint (`/api/stripe/pt/:id/webhook`) is retired with `pt_direct`.
- **Raw body and signature:**
  - Read the body **once** as raw bytes before any parsing. `lib/bridge.mjs`'s `boundedBody` already does this, with a 1 MiB cap on webhook routes.
  - Then verify with `stripe.webhooks.constructEventAsync(raw, sigHeader, secret, undefined, Stripe.createSubtleCryptoProvider())`.
  - The synchronous `constructEvent` **does not work** on Workers (see the probe below).
  - The repo's own `verifyWebhook` (Node `crypto.createHmac` + `timingSafeEqual`) also runs under `nodejs_compat` (RC-1 node probe: `createHmac` and `timingSafeEqual` ok), so either is viable. I recommend the SDK, for one maintained implementation.
  - Keep the 300 s tolerance and the `livemode` vs `mode` check the code already has.
- **Per-request DB:**
  - **Postgres via Hyperdrive:** open a `pg` client from `env.HYPERDRIVE.connectionString` **inside** the request and close it in `ctx.waitUntil`. RC-1 showed a module-level pool hangs on the 2nd request.
  - **D1:** use the `env.DB` binding directly; there is no pool to manage.
- **Duplicates:**
  - Insert into `stripe_webhook_events` first (`ON CONFLICT DO NOTHING`). If 0 rows were inserted, the event has already been processed, so return 200.
  - If the row exists with `status='failed'`, reprocess it; Stripe retries.
  - Effects must be idempotent anyway, for example `UPDATE bookings SET status='paid' … WHERE id=? AND status='pending'`.
- **Out-of-order events:**
  - Stripe documents that it doesn't guarantee order, and that `created` must not be used for ordering.
  - For **state mirrors** (account status, subscription status), treat the event as a trigger and **re-retrieve the object** from Stripe, then upsert, guarded by `status_source_ts`. Stripe's Billing docs recommend retrieving the subscription after `invoice.paid` to confirm `active`.
  - For **booking transitions**, only allow forward moves (`pending → paid|expired|failed`, `paid → refunded`). Late `expired` events after `paid` are ignored.
- **Concurrency:**
  - **Postgres:** one transaction per event: `INSERT event … ON CONFLICT DO NOTHING RETURNING`, then `SELECT … FOR UPDATE` on the booking/subscription row, apply the effects, `COMMIT`. This gives the same serialisation the snapshot used, but per row.
  - **D1:** there are **no interactive transactions**; the only atomic unit is `env.DB.batch([...])`, which the D1 docs say runs as one SQL transaction. So express each event's effects as one batch of conditional statements (`WHERE status='pending'`, `uses < max_uses`, `INSERT … ON CONFLICT DO NOTHING`), read affected-row counts from the batch results, and avoid read-then-write across `await`s.
  - Capacity holds and discount `max_uses` are the two places where D1 needs the most care. Allow +0.5–1 day across RC-6 and RC-8 if D1 is chosen.
- **Response time and CPU:** verify, write and return 2xx quickly. Anything slow, such as a Stripe re-retrieve or email, can run through the existing `stripe_jobs` queue, `ctx.waitUntil`, or later a Queue/Cron (RC-10). Signature verification uses async Web Crypto, which is cheap.

### Does the `stripe` npm SDK run on Workers?

**Yes, per the package and docs, and verified offline.**
- `stripe@23.1.0` (latest on npm, 17 Nov 2026) declares a **`workerd`** export condition that maps to `stripe.esm.worker.js`, which initialises `WebPlatformFunctions` (fetch HTTP client + SubtleCrypto).
- Its source explicitly throws for Node-only helpers ("Please use `createFetchHttpClient()`" / "`createSubtleCryptoProvider()`").
- Offline probe in workerd: no API key used, no network to Stripe, dummy local webhook secret. It ran from a scratch folder outside the repo, and the SDK isn't added to `package.json` (RC-2):

```
$ wrangler deploy --dry-run --outdir dist      # probe worker importing stripe@23.1.0
Total Upload: 736.29 KiB / gzip: 86.57 KiB
$ curl -s http://127.0.0.1:8795/
{"valid":{"ok":true,"id":"evt_probe_1","account":"acct_probe"},
 "tampered":{"ok":false,"type":"StripeSignatureVerificationError"},
 "syncConstructEvent":{"ok":false,"msg":"SubtleCryptoProvider cannot be used in a synchronous context.\nUse `await constructEventAsync(...)` instead of `constructEvent(...)`"}}
```

- Bundle impact is about +440 KiB raw, far under the 64 MiB limit.
- The repo's current `fetch`-based client already works without the SDK. Adopting the SDK is optional; I recommend it for webhook verification and typed v2 Accounts calls.
- **Not verified:** live API calls through the SDK. There are no keys yet, so this is RC-40 (test-mode E2E).

### Dependencies and ordering

1. **RC-2** (lockfile), then **RC-3** (remove nested v4): small, unblock clean installs and bundles.
2. **RC-4** storage port (**D1 or Hyperdrive**, Kieran to decide). It's a prerequisite for everything below, because every ticket adds tables and needs real transactions/batches. **Not started**, per the PM.
3. **RC-5** Connect onboarding. It also builds the shared webhook framework: the event log, both endpoints, and signature verification.
4. **RC-9** class model. Can run alongside RC-5. It's needed before RC-6 pricing/policies and RC-8 per-class scope.
5. **RC-6** class checkout (direct charges). Needs RC-5 (`charges_enabled` account) and RC-9.
6. **RC-7** PT subscription. Needs RC-4 and the webhook framework from RC-5. It's independent of RC-6, so it can run in parallel.
7. **RC-8**: (a) and (b) after RC-6; (c) after RC-7.
8. **RC-12** (workers.dev preview + secrets, Kieran's OK) is needed before any Stripe-sent webhook can reach us. The alternative, `stripe listen` forwarding, needs a Stripe CLI login. Until then, tests use signed fixture events, as the repo's tests already do. **RC-40** runs the test-mode E2E after keys are arranged.
9. **`pt_direct` migration:** new PTs get Connect only. Existing `pt_direct` rows keep their stored key **only** to refund historical bookings, then they're archived. This needs Kieran's sign-off on the cut-off, and it sits inside RC-5/RC-6.

### Estimates (Backend dev-days, after RC-4; tests included)

| Ticket | Estimate | Main work |
|---|---|---|
| RC-5 Connect onboarding + webhook framework + `pt_direct` retirement plan | **3** | Revive the v2 Account + account-link flow, status mirror and dashboard state API, both webhook endpoints + event log, SDK verification, migration plan for existing records. |
| RC-6 Class checkout (direct charges, no fee), refunds, holds | **3** | Checkout on `Stripe-Account` with final `unit_amount`, no `application_fee_amount`, forward-only state machine, refunds from the PT's balance, hold expiry, Connect-scope events. |
| RC-7 PT subscription + Customer Portal + grace/unpublish | **3.5** | Platform Product/Price from `billing_settings`, subscription-mode Checkout, Portal session, invoice/subscription events with re-retrieve, grace job (Cron Trigger) that pauses bookings and unpublishes after N days. |
| RC-8 Discount codes (a) PT, (b) admin, (c) subscription promo codes | **3** | Local code CRUD + server-side validation and price calculation, holds/redemptions with `max_uses`, admin Coupon/Promotion Code create + mirror, Checkout `discounts`. |
| **Total RC-5 to RC-8** | **12.5** (range 11–15) | Add **+0.5–1 d** if D1 is chosen (batch-only atomicity for holds and `max_uses`). Excludes RC-4 itself and RC-9/10/12, and about 3 QA days in RC-40. |

### Key risks

- **D1 vs Postgres concurrency:** with D1 the oversell and `max_uses` guarantees rest on single conditional statements/batches, not row locks. They need targeted concurrency tests whichever option is picked.
- **Out-of-order or duplicate events** on subscriptions and accounts: mitigated by the event log + re-retrieve + `status_source_ts`.
- **v1/v2 event duality for v2 Accounts:** the same account change can arrive as both v1 and v2 events on different endpoints. Both are handled idempotently by re-reading the account.
- **No webhook delivery until a public URL exists** (RC-12 needs Kieran's OK). Until then everything is fixture-tested only.
- **Customer Portal and Product/Price setup** need someone with test-mode Dashboard/API access. No keys are arranged yet.
- **Discounts on direct charges** are applied by lowering the Checkout amount. The PT's Stripe Dashboard shows only the final amount, so our `bookings` row is the record of list price vs discount.
- **Refunds on direct charges** come out of the PT's Stripe balance. With `losses_collector:'stripe'`, negative balances are Stripe's risk per Kieran's model, but the refund UX must say the PT pays it.
- **`pt_direct` historical data:** encrypted PT keys must be kept and readable until historical refunds are no longer possible, then deleted. This needs a sign-off date.

## Rollback

Spike only, with no runtime or data changes outside this branch. To roll back, close the draft PR and delete branch `rc-1-workers-spike`, or delete `wrangler.jsonc`, `worker/`, `docs/spikes/RC-1-workers-runtime.md`, `.dev.vars.example` and `.gitignore`. Locally: `git worktree remove /workspace/resiliencecoaching/worktrees/RC-1` and stop the throwaway Postgres.
