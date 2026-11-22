# RC-32: Connect retry after a failed account job

Prod incident, 22 Nov 2026 at 22:06 UK (version 70cf2048). The PT tapped "Connect my Stripe account" and live `POST /v2/core/accounts` returned a Stripe 400. That failed the `stripe_jobs` row `account:live:<pt>`, and the row was never retried.

- Every later tap hit the same fixed id (`INSERT OR IGNORE`), and `runJob` replayed the stored failure as a 409.
- Even a reset row would have reused the same Stripe Idempotency-Key, so a cached Stripe response could replay as well.
- Stripe's error body was discarded, so the Worker logs had no cause.

## Changes

1. **Fresh job after a failure** (`src/ops/stripe-jobs.mjs` `accountJobId`, called from `prepareConnect`).
   - The first attempt keeps the fixed id `account:[live:]<pt_id>`.
   - While the PT's latest account job is `pending`, `retry` or `done`, its id is reused. Double taps still share one job and one Idempotency-Key. `prepareConnect` runs in the Writer, so the read-then-insert is serialised.
   - Only when the latest attempt is `failed` (non-retryable) does the next tap create `account:[live:]<pt_id>:<uuid>`. That gives a new job row and a new Idempotency-Key (the job id), so neither the stored failure nor Stripe's cached result is replayed.
   - Completion (`completeJob`), binding (`bindStmts`), the chained onboarding job and the status routes all use `stripe_jobs.target_id` or `stripe_connections`, never the fixed id. Retryable failures (`retry`, from 409/429/5xx/timeouts) keep the same id and key, as before.
   - **No duplicate account (CR M1):** once Stripe has answered 2xx for an account create, every later failure in that run stays retryable (`status='retry'`). That covers the `acct_`/livemode checks, the shared client's livemode check and a failed `completeJob`. The next tap therefore replays the same Idempotency-Key, Stripe returns the same `acct_`, and that account is bound. A fresh id is minted only after a failure where Stripe created nothing: a non-2xx Stripe response, such as a 4xx setup error.
   - **Stale jobs (CR m2):** a `pending`/`retry` account job is retried on the same key whenever the PT taps again, however old it is. The 23-hour "reconcile first" guard in `runJob` still applies to payment jobs (checkout, refund, cancel), but no longer to account jobs, which move no money. Residual risk: Stripe drops idempotency keys after about 24 h. If a create succeeded but was never recorded, and the retry comes more than 24 h later, Stripe could create a second account. That's only possible if the Writer failed and nobody tapped again for a day. It's documented here and not handled in code.
2. **Redacted Stripe error logging** (`src/stripe.mjs` `stripeErrorLog` and `redactStripeText`).
   - Every non-2xx Stripe response logs `console.error('Stripe API error', {status, path, type, code, message, request_id})`.
   - `acct_` ids keep only their first 4 characters. Emails become `[email]`. `sk_`/`rk_`/`pk_` keys and `whsec_` secrets become `[redacted]`. The message is capped at 300 characters.
   - The Authorization header and the key are never logged.
3. **Clearer PT message** (`src/stripe.mjs` `platformNotReady`).
   - Applies to a Stripe 400 `invalid_request_error` whose message says the platform hasn't finished Connect setup: not signed up for Connect, platform profile, responsibilities for managing losses, or account not activated.
   - Response: 409 `{ error: "Stripe Connect isn't set up on the platform yet. Ask the site owner to finish Stripe setup.", code: "STRIPE_PLATFORM_NOT_READY" }`.
   - It is non-retryable, so the next tap gets a fresh job (item 1).
   - All other errors keep the existing generic text. Stripe's raw message is never returned to the client.

## API contract

Unchanged apart from the new error message and code on `POST /api/pt/stripe/connect` (and `POST /api/admin/stripe/link`) when the platform's Connect setup is incomplete. There is no schema change, no migration and no new env var.

## Tests

`workers-test/rc-32-connect-retry.test.mjs`:
- After a failure, a retry gets a new job and a new Idempotency-Key, and then succeeds.
- Pending and retrying jobs are reused; the live namespace is kept separate.
- Five concurrent taps after a failure produce one new job and one key.
- Log redaction, and that no key appears in a real failed call's log line.
- Message mapping, both positive and negative cases, scoped to /v2/core/accounts (CR nit 3).
- M1: a failed done-update and a livemode mismatch after the create both retry on the same key and bind one acct_.
- m2: a 30 h old retry job is retried on the same key.

The scope-lint allowlist has the new `accountJobId` query.

## Rollback

Redeploy Worker version `70cf2048-02a4-4ef0-92b8-73514fb18ea4`. There is no data to revert. `stripe_jobs` rows with the `:<uuid>` suffix are harmless to the old code, because it looks up only the fixed id.

## Ops note (prod, after deploy)

The failed live row `account:live:2ba6e68d-…` stays as history. The next tap creates a fresh job. The platform's live Connect setup still has to be finished in Stripe first, otherwise the PT now sees the new message. The exact Stripe reason will appear in the Worker logs as `Stripe API error`.
