# RC-1: Workers runtime spike (findings)

**Project:** Resilience Coaching (resiliencecoaching.app) · **Ticket:** RC-1 · **Owner:** Backend
**Date:** 17 November 2026, 13:40–14:00 Europe/London (GMT)
**Base:** `main` at `7cebef2` · **Branch:** `rc-1-workers-spike`
**Scope:** local only (`wrangler dev` / workerd via Miniflare, and `wrangler deploy --dry-run`). Nothing was deployed, no Cloudflare account calls or logins, no Cloudflare resources, DNS, Netlify, Stripe or Resend changes.

## Verdict: (B) the snapshot approach does NOT work on Workers

`node:sqlite` is only a **stub** in the Workers runtime: `import 'node:sqlite'` succeeds, but `new DatabaseSync(...)` throws `TypeError: Illegal constructor`. The app creates a `DatabaseSync` on every API request (`app/db.cjs:9` via `app/server.cjs:27`), so every `/api/*` request fails with the app's 503. Everything around SQLite does work: the Worker boots via a thin adapter, `/tmp` files round-trip, `pg` connects from workerd to Postgres, and the Postgres snapshot read/write (row lock + bytea) round-trips correctly, including under concurrency. The blocker is SQLite itself, so the recommendation is to **port state to real Postgres tables via Hyperdrive** (plan and estimate below).

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

## Rollback

Spike only, with no runtime or data changes outside this branch. To roll back, close the draft PR and delete branch `rc-1-workers-spike`, or delete `wrangler.jsonc`, `worker/`, `docs/spikes/RC-1-workers-runtime.md`, `.dev.vars.example` and `.gitignore`. Locally: `git worktree remove /workspace/resiliencecoaching/worktrees/RC-1` and stop the throwaway Postgres.
