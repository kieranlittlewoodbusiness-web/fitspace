# FITSPACE v8 — independent PT Stripe accounts

**The owner does not need a Stripe account.** Default integration is `pt_direct`. Each PT supplies a restricted key from their own Stripe account plus their own webhook signing secret. Customer payments are created in that PT’s account, at the class/block price saved in FITSPACE. There is no application fee or Stripe-Account routing header.

No real Stripe credentials, account configuration, provider-hosted checkout or remote deployment have been used in preparing this package. Automated provider tests are mocked. Validate the following on your deployed site before genuine purchases.

## 1. Owner: deploy and protect credentials

Deploy all source files on Netlify as described in START_HERE.md. Keep your existing database and public namespace. Add these Netlify **Functions** variables:

| Variable | Value |
| --- | --- |
| `STRIPE_INTEGRATION` | `pt_direct` (also the default) |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 random hexadecimal characters; server-only |
| `APP_URL` | Your canonical HTTPS origin, without a path |
| `PAYMENT_MODE` | `demo` initially, then `stripe_test` to exercise Stripe sandbox |
| `STRIPE_API_VERSION` | `2026-09-30.endive` |

Generate CREDENTIAL_ENCRYPTION_KEY locally with a password manager, `openssl rand -hex 32`, or Node 24:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the result in Netlify’s secret environment settings, not in source code or chat. Back it up securely and keep it unchanged across deploys. Saved PT keys and signing secrets use AES-256-GCM with random nonces and authentication tied to the credential ID, PT, payment mode and field. Losing/changing the master key makes existing credentials unreadable. This release has no automatic master-key rotation tool: restore the correct key or carry out an explicit maintenance migration before rotation. Never overwrite the key casually.

No owner STRIPE_SECRET_KEY, Connect platform, OAuth client ID or global signing secret is needed. Those old Connect values are ignored in pt_direct mode. Admin → Stripe setup shows encryption/URL readiness and safe connection metadata; it never displays PT secrets. The owner remains responsible for securing the server, database, backups, staff access and encrypted credential handling.

## 2. PT: create a restricted sandbox key

1. Sign in to your own Stripe account and choose a **sandbox**.
2. Open API keys → Create restricted key. Name it FITSPACE sandbox.
3. Start with these resource permissions:

   | Resource | Access |
   | --- | --- |
   | Account | Read |
   | Checkout Sessions | Write |
   | Payment Intents | Read |
   | Events | Read |
   | Refunds | Write |

   Stripe’s permission labels may vary. Required API calls are GET /v1/account, POST/GET /v1/checkout/sessions, POST /v1/checkout/sessions/{id}/expire, GET /v1/events/{id}, and POST /v1/refunds. Checkout uses inline GBP price_data/product_data. Review Stripe request logs during sandbox testing for any additional permissions required by that request configuration; grant only the required resource. Account lookup alone does not validate checkout/refund permissions. The exact provider permission combination must be validated with the full sandbox journey, not inferred from mocked tests.
4. In FITSPACE, open Payments → Stripe sandbox. Enter the `rk_test_...` key and choose **Save and verify account**. Unrestricted `sk_...` keys and keys from the wrong mode are rejected.
5. Confirm the account ID is yours. Saving pauses new payments. Keys are never returned to the browser after saving. Blank fields preserve existing saved values.

Create/check/save actions are authenticated, CSRF-protected and rate limited. The admin cannot upload an arbitrary account for you. An account can belong to only one PT profile in each mode. Payments use the saved credential ID; the browser cannot choose another account or price.

## 3. PT: register your webhook

After saving the restricted key, FITSPACE displays **Your webhook URL** for that mode. Copy it exactly; it includes a credential ID and is different for each PT and for sandbox/live.

1. In the same Stripe sandbox, open Workbench → Webhooks → Create an event destination.
2. Select **Your account**, not Connected accounts. Use **Snapshot** event payloads with the configured API version.
3. Paste the URL copied from FITSPACE. Subscribe to:
   - checkout.session.completed
   - checkout.session.async_payment_succeeded
   - checkout.session.expired
   - checkout.session.async_payment_failed
   - payment_intent.payment_failed
   - refund.created, refund.updated, refund.failed
   - charge.refunded
   - account.updated
4. Copy that endpoint’s `whsec_...` signing secret into the matching FITSPACE sandbox form. Leave the API key blank to retain it, then save again.
5. Choose **Check account status**, then **Enable sandbox payments** and confirm.

The signing secret is encrypted. The server verifies signatures against the raw body, checks the event’s mode, then retrieves the event from **that PT’s Stripe account** using GET /v1/events/{id}. Only the account-owned event data is processed. Forged metadata, another PT’s signing secret, or an event from the wrong account cannot confirm a booking. Unrelated events can be acknowledged without changing bookings.

A webhook secret being saved is not delivery verification. The status becomes **Verified webhook received** only after an actual signed, account-owned event is retrieved and processed. Use a genuine sandbox checkout event; a synthetic Dashboard fixture that cannot be retrieved through /v1/events/{id} will not verify the account.

## 4. Test real Stripe sandbox checkout

The owner must set `PAYMENT_MODE=stripe_test` and redeploy for customer bookings to use saved sandbox accounts. Leaving it at demo uses the simulator even when PT credentials are configured.

1. PT creates a future block, e.g. eight sessions, seven participants, £123.45 total upfront. Publish it.
2. Sign up as a customer using a separate account. Book the block. Check Stripe Checkout shows £123.45 for all sessions and the right merchant. Use test card `4242 4242 4242 4242`, any future expiry and a three-digit CVC.
3. Returning to the website must not itself confirm the booking. Check Stripe sends the event to that PT’s endpoint with HTTP 200; then check the booking is confirmed once, capacity decreases and the payment appears in the correct PT’s Stripe Dashboard.
4. PT/admin requests **Refund payment**. Check Stripe records a successful full refund, the booking is cancelled, the place is restored and net revenue changes. This gives the PT their sandbox payment-and-refund pass required for live enablement.
5. Try decline card `4000 0000 0000 9995`, authentication card `4000 0025 0000 3155`, expiry and cancellation. A retryable card failure must not confirm the place. Expired/terminally failed/cancelled holds release capacity. Late successful payments after release require review rather than silently confirming a place.
6. Test another PT separately, with their own sandbox credentials and endpoint. Check each receives only their own payments and cannot view/refund the other PT’s bookings.
7. Resend events to verify duplicate protection. Test provider delivery errors and inspect Stripe delivery/request logs. Fix permissions/credentials and resend the event; do not manually treat a browser redirect as proof of payment.

The price is owned by the server and frozen in the booking at reservation time. Browser-supplied amounts are ignored. Subsequent price edits affect new checkouts. Net revenue is gross payments minus refunds **before Stripe fees**; payout readiness is displayed separately. Currency remains GBP and session times remain Europe/London.

## 5. Enable genuine purchases explicitly

Only after deployed sandbox validation and merchant activation:

1. PT chooses their live Stripe account and creates a matching restricted `rk_live_...` key with the required permissions.
2. Save it in FITSPACE → Payments → Live Stripe. Register its separate **Your account** live endpoint using the displayed live URL, and save its live signing secret.
3. Check account status. Complete Stripe’s business/bank/verification requirements as needed. Card readiness and payout readiness are distinct.
4. Choose **Enable live payments** and explicitly confirm. The server requires that PT to have completed a paid, signed sandbox booking and a successful full refund first.
5. Owner sets PAYMENT_MODE=stripe_live in Netlify and redeploys when ready. Both the site mode and PT’s live enablement must permit new live bookings.

Live is for genuine service purchases, not testing with real payment details. Stripe’s sandbox is the test environment. No live charge or refund was performed while building this update.

## Pause, replace or remove

- **Pause new payments** prevents new reservations for that account/mode. Existing prepared checkouts, refunds and signed updates can still finish using the original credentials.
- **Replace a restricted key** by saving a new key from the same Stripe account. Recheck/enable afterward; saving pauses new payments. Stripe idempotency keys stay attached to frozen operations. Keep permission access needed for historical refunds and event retrieval.
- **Replace the webhook secret** by saving it in the same form and updating Stripe. Confirm new event delivery. Blank fields preserve saved credentials.
- **Remove credentials** requires typing the account ID and resolving active checkouts first. It clears active encrypted key/secret values, stops automated updates/refunds and preserves booking history. Manage unresolved payments in Stripe manually, or reconnect the same account. Revoke the key and delete/disable its webhook in Stripe separately; removal cannot erase old database backups.
- After any payments have used a binding, a different account cannot replace it. Use a separate trainer profile for a different business/account. This prevents old refunds or payment notifications being redirected to a new account.

## Upgrading from Connect versions

Accounts/classes/bookings are retained, but legacy Connect bookings are not relabelled as independent PT payments. Finish or reconcile pending Connect operations before switching. Historical Connect refunds need the original Connect configuration or direct management in Stripe; an independent PT key must never be substituted automatically. Legacy support remains behind explicit STRIPE_INTEGRATION=connect for an existing owner platform; it is not required for the default v8 setup. Back up the database first and keep DATA_NAMESPACE unchanged.

Official references: https://docs.stripe.com/keys/restricted-api-keys ; https://docs.stripe.com/webhooks ; https://docs.stripe.com/api/checkout/sessions/create ; https://docs.stripe.com/testing
