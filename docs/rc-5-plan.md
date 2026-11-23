# RC-5 — Stripe Connect onboarding (plan and contract)

Branch `rc-5-stripe` from `origin/main` (`5fd3e21`). Analysis and implementation for TICKETS.md RC-5. No deploys, no remote D1, no live Stripe calls. Test mode uses mocked Stripe only.

Product constraints (agreed): one PT, one connected account, Stripe-hosted onboarding, direct charges, no application fee, test mode. We never hold PT keys. `MULTI_PT_ENABLED` is `"true"` only when that exact string is set; otherwise off. Kieran stays admin. RC-14's `single_connect` guard is included here so this branch is safe before PR #10 merges; after #10 lands, merge `main` normally (no rebase, no force-push).

## 1. What already exists (RC-4 on main)

| Area | State on main |
| --- | --- |
| `stripe_jobs` queue | Table + `prepare*` / `runJob` / `completeJob` / `failJob`. Deterministic job id is the Stripe `Idempotency-Key`. Writer is not held during the Stripe HTTP call. |
| Retries / backoff / cron | `failJob` sets `status='retry'` on retryable Stripe errors, but `stripe_jobs` has no `attempts`, `next_attempt_at`, or claim column. Cron (`runScheduled`) delivers mail and expires holds only — it does **not** pick up Stripe jobs. Retries happen when the client repeats the action (same idempotency key, 23-hour window). |
| Connect onboarding | `POST /api/pt/stripe/connect` creates a v2 Accounts account (`account:<ptId>`) then an Account Link (`onboard:<uuid>`). Refresh already mints a new link. Return/refresh URLs: `/dashboard?tab=payments&connect=return\|refresh`. |
| Status | `POST /api/pt/stripe/status` GETs the account and writes only `ready` via `bindConnection`. Dashboard exposes `stripe_connected` / `stripe_ready` only. No named dashboard state. |
| `account.updated` | Applied in the Writer. `webhook_events.id` PRIMARY KEY dedupes. `updated_at<=?` ignores stale events. Stores `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements` JSON. |
| Webhook verify | Local HMAC, 5-minute timestamp skew, test/live mode check. Platform endpoint accepts `STRIPE_WEBHOOK_SECRET` or `STRIPE_CONNECT_WEBHOOK_SECRET`. |
| Checkout / refunds | Already ported (closer to RC-6). Checkout payload has no `application_fee`. Direct charge via `Stripe-Account`. |
| Readiness guard | `paymentReadiness` 503s Stripe actions (`connect`, `status`, `admin/stripe/link`) and non-diagnostic APIs before any write or Stripe call, when key / webhook secret / HTTPS `APP_URL` are missing or mismatched. |
| RC-14 `single_connect` | **Not on main** (PR #10, `bb6c889`). Ported into this branch. |

Gaps this ticket closes:

1. Named dashboard state: `not_connected`, `onboarding_incomplete`, `restricted`, `pending`, `active`.
2. Status contract: `charges_enabled`, `payouts_enabled`, `requirements.{currently_due,past_due,disabled_reason}` on dashboard, setup, and status refresh.
3. On-demand refresh must persist the full snapshot (not only `ready`).
4. Authz: PT owner **or** admin (admin passes `pt_id`, or the single PT when multi-PT is off).
5. `{error, code}` on RC-5 routes and the readiness/auth failures they share.
6. `single_connect` + `PLATFORM_LINK_DISABLED` when `MULTI_PT_ENABLED` is not `"true"`.
7. Idempotency/concurrency tests for double-click Connect, duplicate and out-of-order `account.updated`, refresh minting a new link, and the state machine.

Out of scope (left for later tickets, noted only): cron drain/backoff for `stripe_jobs` (jobs stay client-retried); RC-6 checkout/refund product work; RC-7 subscriptions; go-live keys and the webhook endpoint (need Kieran's yes).

## 2. API contract

All errors are `{ "error": "<human message>", "code": "<STABLE_CODE>" }`. Success bodies have no `error`.

### `POST /api/pt/stripe/connect`

Roles: PT (own PT) or admin (`pt_id` in the JSON body; if omitted in single-PT mode, the one PT is used).

Mint a Stripe-hosted onboarding link. First connect creates at most one Connect account for that PT (`stripe_jobs.id = account:<ptId>` or `account:live:<ptId>`). A later call, or `?connect=refresh`, mints a **new** Account Link (`onboard:<uuid>`).

**200:** `{ "url": "https://connect.stripe.com/..." }`

| Status | code | When |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | Not signed in |
| 403 | `FORBIDDEN` | Customer, or PT targeting another PT |
| 403 | `PASSWORD_CHANGE_REQUIRED` | Temporary password not changed |
| 404 | `TRAINER_NOT_FOUND` | Admin `pt_id` does not exist |
| 400 | `PT_REQUIRED` | Admin in multi-PT mode with no `pt_id` |
| 409 | `SINGLE_CONNECT_EXISTS` | Another PT already has the site's one Connect account |
| 409 | `PLATFORM_ACCOUNT_LINKED` | Admin has linked the platform account; use status |
| 409 | `USE_PAYMENTS_SETUP` | `STRIPE_INTEGRATION=pt_direct` |
| 503 | `PAYMENTS_NOT_READY` | Readiness guard (before any write or Stripe call) |
| 503 | `STRIPE_MODE_DISABLED` | `PAYMENT_MODE` is not `stripe_test` / `stripe_live` |

### `POST /api/pt/stripe/status`

Same authz. If no connection, returns the `not_connected` snapshot and does **not** call Stripe. If connected, retrieves the account, persists the snapshot, returns it.

**200:**

```json
{
  "state": "active",
  "account_id": "acct_...",
  "routing": "connected",
  "ready": true,
  "charges_enabled": true,
  "payouts_enabled": true,
  "details_submitted": true,
  "requirements": { "currently_due": [], "past_due": [], "disabled_reason": null },
  "mode": "stripe_test"
}
```

Additional errors: `409 CONNECT_ACCOUNT_MISMATCH` if Stripe returns a different account or livemode.

### `GET /api/pt/stripe/setup`

PT or admin (admin: `?pt_id=`). Read-only, no Stripe call (stays reachable when misconfigured). Adds the same `state` / status fields when `STRIPE_INTEGRATION=connect`.

### `GET /api/dashboard`

PT `pt.stripe` (and each admin `pts[]` entry `stripe`) is the same snapshot, plus existing `stripe_account_id`, `stripe_routing`, `stripe_connected`, `stripe_ready` for current UI.

### `POST /api/admin/stripe/link`

Unchanged, except `409 PLATFORM_LINK_DISABLED` in single-PT mode (platform routing is not used).

### Dashboard state

Derived from the stored snapshot (webhook or refresh):

| state | Rule |
| --- | --- |
| `not_connected` | No connected account |
| `onboarding_incomplete` | Account exists, details not submitted, charges not enabled |
| `restricted` | `requirements.disabled_reason` or any `past_due` |
| `pending` | Details submitted, not restricted, charges not yet enabled |
| `active` | `charges_enabled` and not restricted |

Direct charges, no application fee: checkout already sends `Stripe-Account` and never sets `application_fee`. Account create uses `fees_collector` / `losses_collector` = `stripe`.

## 3. Schema, migration, rollback

**No new D1 migration.** `0001` already has `stripe_jobs`, `stripe_connections`, `webhook_events`. `0002` already added the RC-5 status columns: `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements`, `updated_at`. Dashboard state is computed, not stored. `disabled_reason` / due lists live in `requirements` JSON.

Rollback for this ticket's application behaviour: revert the branch (or set `MULTI_PT_ENABLED=true` only to relax `single_connect`). Do not run `migrations-down/0002_*.down.sql` for an RC-5 rollback — that drops RC-5..RC-9 foundation columns and is not part of this change. No remote `d1 migrations apply`.

## 4. Env var names (names only)

Already used: `PAYMENT_MODE`, `STRIPE_INTEGRATION`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `APP_URL`.

Added (default off): `MULTI_PT_ENABLED` — only the string `"true"` enables multi-PT. Set `"false"` in wrangler default and preview vars.

No new secrets in this PR. Do not put keys in the repo or in prompts.

## 5. Test plan

Workers tests, mocked `fetch` only (no Stripe or Cloudflare network):

- Double-click / 5 concurrent `POST /api/pt/stripe/connect` for a new PT: one `account:` job, one `stripe_connections` row, one account id. Stripe POSTs (if more than one) share the same Idempotency-Key.
- Already connected: connect/refresh mints a new `onboard:` job and a new `url`; return/refresh URLs are the dashboard payments tab.
- `account.updated`: same event ×5 → one apply + duplicates; a newer event then a stale one leaves the newer snapshot; requirements and state follow the table above.
- Status refresh persists the full snapshot and returns the matching `state`.
- Authz: customer 403; other PT 403; owner and admin 200.
- Readiness: missing/mismatched key, webhook secret, or `APP_URL` → 503 `PAYMENTS_NOT_READY`, zero `stripe_jobs` rows, zero `fetch` calls.
- `single_connect` + `PLATFORM_LINK_DISABLED` with `MULTI_PT_ENABLED` not `"true"`.
- Checkout job still has no `application_fee` and routes to the connected account.
- Every RC-5 error body has `error` and `code`.

Also run: `test:workers`, `test`, `test:bundle`, `build`, wrangler config dry-runs (`tests/remote-guards.test.mjs` / `unstable_readConfig`; no deploy), scope lint, `scripts/guard-mutations.mjs` (includes `single_connect`), `workers-test/scope-bypass-mutations.mjs`.

## 6. Needs Kieran's yes (go-live; not this PR)

- Stripe **test** platform key and webhook signing secrets (platform + Connect, if separate).
- Webhook endpoint URL on the preview (or production) origin: `POST /api/stripe/webhook`.
- Cut-off for legacy PT-owned keys (`pt_direct` writes are already 410).
- Remote D1 migrations, production `CRON_ENABLED`, live keys, and Resend remain under the existing go-live approval. This PR does not deploy.
