# FITSPACE v7 — verification

Executed locally on 22 October 2026 with Node 24.

- Build source/runtime/routing checks passed.
- `npm test`: 32 passed.
- `npm run test:bundle`: 21 passed against the bundled Netlify Function, local PostgreSQL-compatible engine and mocked provider responses.
- Browser inspection: customer/PT password recovery page, clear missing-email-configuration message, and independent Number of weeks / sessions and Maximum participants fields in the PT class form. Existing responsive CSS retained. Isolated fixture preview stopped; this is not a deployment.

New reset tests cover generic public responses, canonical private links, hashed token storage, no token in API/staff previews, single use, expiry, tampering, secret rotation, all-device session revocation, invalidation after normal password changes, PT temporary-password recovery, preserved roles/ownership, delivery failures, durable request limits and explicit configuration availability. Email delivery is mocked: no actual inbox was used or email sent.

New capacity integration test creates nine weeks with seven participants and submits ten competing requests. Exactly seven reservations succeed and three are rejected. Pending and paid places count toward capacity. Lowering below occupied places fails; increasing capacity permits another reservation; expiry restores only unpaid places. Zero, fractional and above-100 capacities fail validation. Existing tests retain Stripe expiry/refund/review and cross-trainer isolation coverage.

Prior Stripe coverage remains: exact server-owned price, account routing, signed-only confirmations, duplicates, failure/refund handling, live/test separation and safe retry operations. Existing v5-to-v6 database migration checks still pass; v7 adds reset tables without deleting accounts or bookings.

No Netlify deployment, remote database, email provider or Stripe account was configured or exercised here. Follow START_HERE.md, STRIPE_SETUP.md and PASSWORD_RESET_SETUP.md for real deployment/provider validation. Defaults remain simulated payments and reset email off. Live purchases and actual email delivery require deliberate owner configuration.

Remaining limits: serialized 8 MiB PostgreSQL snapshot prototype; 1–100 participants and 1–52 session dates per block; UK/GBP Stripe onboarding; booking/no-show emails remain previews; no custom trainer domains or anonymous owner-admin recovery. Email jobs have no automatic retry scheduler; request a new link if delivery is not confirmed. Keep original database and namespace when upgrading.
