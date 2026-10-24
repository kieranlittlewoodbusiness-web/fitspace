# FITSPACE v6 validation

Executed locally with Node 24 on 22 October 2026.

- `npm run build`: source/runtime/routing checks passed.
- `npm test`: 25 tests passed, including public/auth/role/capacity tests and v5-to-v6 migration preserving attendance and refund references.
- `npm run test:bundle`: 14 integration tests passed against the packaged Netlify Function, exercising a local PostgreSQL-compatible database over its wire protocol.
- Browser QA of an isolated, fixture-only preview: PT Payments instructions and connection action; admin Stripe setup/configuration status; customer price/date summary and explicit live-card acknowledgement. Existing responsive styles retained. The preview has been stopped and is not a deployment.

Payment coverage: PT onboarding/capability checks; direct connected-account routing; exact server-owned price, including £123.45; frozen checkout amounts after price changes; signed-only confirmation; forged/wrong-account/wrong-mode/wrong-amount event rejection; duplicate events; failures, cancellation and expiry; late payment review; partial/full refunds; refund role isolation; recovery from lost provider responses and failed database commits; separate live/test bindings; optional owner-account routing without connected-account header; no secret values in setup responses.

All provider responses and signing secrets are test fixtures. No real Stripe account was linked, no provider-hosted checkout was completed, no real money moved, and no Netlify/remote database was provisioned or deployed. The project defaults to simulated payments. Complete STRIPE_SETUP.md on your own deployment for provider sandbox validation before enabling genuine purchases.

Remaining prototype limits: serialized PostgreSQL snapshot storage with an 8 MiB cap; no password recovery or custom PT domains; messages saved as previews rather than automatically sent. UK/GBP merchant onboarding only. Existing Stripe business information may be reused via Stripe-hosted networked onboarding; legacy OAuth attachment of arbitrary existing Stripe accounts is not implemented.
