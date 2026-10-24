# FITSPACE v5 validation

Validated 22 October 2026.

- Source build/syntax checks: passed (Node.js 24).
- Automated backend and public/sandbox transport tests: 22 passed.
- Actual Netlify function bundle: 12 transport tests passed.
- Local PostgreSQL engine: PGlite, accessed through PostgreSQL wire protocol.
- Stripe API calls: mocked; no real Stripe credentials were available.
- Webhook tests: real HMAC generation and raw-body verification using fixture secrets.
- Browser checks: PT bookings/refund confirmation, admin bookings/refunds and booking details.

Payment coverage includes Accounts v2 onboarding/capability checks, direct-account
hosted Checkout requests, server-owned prices, signed success-only confirmation,
forged/incorrect/live event rejection, repeated delivery, lost provider response,
failed snapshot commit and recovery, card/terminal failure, expiry/cancellation,
refund permissions, pending/failed/succeeded refunds, external partial refunds,
remaining-balance refund, late-payment review, competing reservations, trainer
isolation, net revenue and retained confirmation/email-preview deduplication.

Actual Stripe-hosted onboarding, hosted card/3DS interaction, remote sandbox
webhook delivery and the user's Netlify/remote PostgreSQL environment remain
unverified until sandbox credentials and hosting are configured. Follow
STRIPE_SANDBOX_SETUP.md. Live payments are blocked; email is preview-only.
