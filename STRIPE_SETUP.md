# FITSPACE v7 — PT Stripe payments

This package adds live-capable Stripe checkout; it does not contain your Stripe account details or credentials and has not been deployed to your Netlify account. Automated checks use mock Stripe responses. Complete the provider sandbox checks below on your own deployment before enabling genuine purchases. Emails remain previews.

## 1. Platform owner: set up Stripe Connect

1. Sign in to your Stripe Dashboard and create/select a sandbox. Enable Connect for your platform and complete Stripe’s platform setup. Configure Connect branding and bank-information collection for hosted onboarding.
2. This version onboards UK merchants, charges GBP, uses Accounts v2 with full Stripe Dashboard access, requests card payments, and creates direct charges on each trainer’s account. Confirm your platform is eligible for this configuration. Stripe collects processing fees; FITSPACE adds no application fee.
3. In Netlify, configure these variables for Functions (and the deploy context you use). Never put secrets into frontend code, commit them to Git or send them in chat.

| Variable | Sandbox | Genuine live purchases |
| --- | --- | --- |
| `PAYMENT_MODE` | `stripe_test` | `stripe_live` |
| `STRIPE_SECRET_KEY` | Platform `sk_test_...` | Platform `sk_live_...` |
| `APP_URL` | Canonical HTTPS Netlify/custom-domain origin | Canonical HTTPS production origin |
| `STRIPE_WEBHOOK_SECRET` | Sandbox connected-account destination `whsec_...` | Live connected-account destination `whsec_...` |
| `STRIPE_API_VERSION` | `2026-09-30.endive` | Same supported version |

A sufficiently permitted `rk_test_`/`rk_live_` restricted key is also accepted. It needs the account, account-link, Checkout and Refund permissions used by this integration, including connected-account access. No publishable key is required for hosted Checkout redirects.

4. Create a Stripe webhook destination for **Connected accounts**, using snapshot events, at `https://YOUR-SITE/api/stripe/webhook`. Subscribe to:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`, `checkout.session.async_payment_failed`
   - `payment_intent.payment_failed`
   - `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`
   - `account.updated`
5. Copy that destination’s signing secret into `STRIPE_WEBHOOK_SECRET`, then redeploy Netlify. Sandbox/live destinations and secrets are separate. A CLI forwarding secret is not the Dashboard destination secret.
6. Admin → **Stripe setup** shows key/mode and configuration checks, saved trainer accounts, and **Check server Stripe account**. Flags only show configuration presence; webhook delivery must still be tested in Stripe.

Keep the database, owner-account variables, runtime and namespace from START_HERE.md. Do not change DATA_NAMESPACE when upgrading v4/v5 to v7.

## 2. Each PT: add their Stripe details

1. Admin creates the PT account. The PT signs in and changes their temporary password.
2. PT opens **Payments → Connect my Stripe account**.
3. Stripe opens its secure onboarding page. The PT provides/verifies business, identity and bank/payout details there. Stripe may offer reuse of business information from an existing Stripe account through networked onboarding. This integration creates a connected merchant account; it does not provide legacy OAuth attachment of an arbitrary existing account ID.
4. Return to FITSPACE and select **Check account status**. Finish any requirements until card payments are enabled. Payout eligibility and bank details are managed in Stripe; accepting a card payment does not guarantee payout readiness.
5. PT creates/publishes a class or block, chooses dates/capacity, and sets **Total upfront price (£)**. Customers pay the full block price once, not once per session.
6. Share `/pt/YOUR-PAGE-NAME`. Each trainer’s bookings route to that trainer’s saved connected account. Trainers never enter API keys into FITSPACE and cannot claim another trainer’s account by entering an account ID.

Example: six sessions priced at £90 produce a single GBP 9,000-pence Checkout charge to that PT. £123.45 produces 12,345 pence. The server reads the class price, snapshots it in the booking and sends that amount to Stripe. A browser-supplied price is ignored. Subsequent price edits affect new bookings; existing checkouts retain their agreed total. Stripe fees reduce the PT’s payout and are not included in dashboard net-before-fees totals.

## 3. Validate in the sandbox

Use Stripe’s test cards only. A real Stripe-hosted sandbox checkout exercises the provider integration without moving real money. Stripe prohibits testing live mode using real payment-method details: use live mode for genuine service purchases only.

1. Complete PT onboarding; verify the saved account ID belongs to the right PT.
2. Create a block at £123.45. As a separate customer, book it. Verify Checkout shows £123.45 and the correct merchant, then pay with `4242 4242 4242 4242`, a future expiry and any three-digit CVC.
3. Before successful webhook delivery, the booking must remain pending, including on the return URL. Verify Stripe delivers a signed `checkout.session.completed` to Netlify with HTTP 200, then the booking becomes confirmed once.
4. Confirm the payment exists in the PT’s connected Stripe account, the amount/currency are correct, capacity fell by one and PT/admin show the same booking and revenue.
5. Use decline card `4000 0000 0000 9995`. A retryable decline must not confirm the booking. Retry with a valid test card or cancel. Check expiry/cancellation releases the place; a completed payment cannot be cancelled without a refund.
6. Test authentication with `4000 0025 0000 3155`. Confirmation still requires the signed paid event.
7. PT/admin → **Bookings → Refund payment**. Confirm the remaining amount. A pending/failed refund retains the place; full successful refund cancels it, restores capacity and updates net revenue. Verify it in Stripe. Partial external refunds must retain the place and show the refunded amount.
8. Resend the same Stripe event; totals and confirmations must not duplicate. Check a second PT receives only their own payments and cannot access/refund the first PT’s bookings.
9. Restart/redeploy Netlify and check the bookings/connections persist. Review failed deliveries in Stripe and resend them after correcting configuration.

## 4. Enable genuine purchases deliberately

Complete the sandbox checklist and your platform/live merchant activation. Resolve outstanding sandbox checkouts/jobs first. Set PAYMENT_MODE=stripe_live, the matching live server key, canonical production APP_URL and live webhook secret, then redeploy. Each PT must complete **live** onboarding separately; sandbox accounts are never reused for live purchases. The interface clearly labels live charges and refunds. Keys and webhook events that do not match the active mode are rejected.

No real charges, refunds, account activation or deployment were performed while preparing this package. Keep demo or sandbox mode until you choose to enable live. Review privacy/refund terms, password reset email delivery, support and database/operations requirements before commercial use; this is still a small prototype with a serialized snapshot store.

## Optional: owner’s own training business

Admin → Stripe setup → expand **Use the platform owner’s Stripe account for one trainer**, choose that trainer and confirm. This verifies the account behind the server key and links it in the current mode. Other PTs should use their own Connect onboarding.

For owner-account payments, add a **Your account** webhook destination with the same payment/refund events. Put its secret in STRIPE_WEBHOOK_SECRET; if you also serve connected trainers, put their separate Connected-accounts destination secret in STRIPE_CONNECT_WEBHOOK_SECRET. Both target `/api/stripe/webhook`. Owner charges omit Stripe-Account; connected PT charges use the PT account header. A single owner account can be assigned to only one PT per mode. Replacing a binding affects future bookings; historical payments keep their original account/routing for reconciliation and refunds.

Official references: https://docs.stripe.com/connect/accounts-v2 ; https://docs.stripe.com/connect/hosted-onboarding ; https://docs.stripe.com/connect/direct-charges ; https://docs.stripe.com/webhooks ; https://docs.stripe.com/testing
