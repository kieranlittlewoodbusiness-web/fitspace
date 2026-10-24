# FITSPACE v8 verification — 24 October 2026

- `npm run build`: passed.
- `npm test`: 40 passed, including eight new independent-PT integration tests.
- `npm run test:bundle`: 29 passed against the packaged Netlify Function and local PostgreSQL-compatible database over its wire protocol.
- Browser QA inspected the independent PT Payments screen, separate sandbox/live masked credential forms, setup guidance and status. Existing responsive CSS and customer pages retained. Isolated fixture preview stopped after inspection.

New coverage: no owner Stripe credentials; rejection of missing encryption, unrestricted/mismatched keys, CSRF and unauthorized configuration; AES-GCM field/PT binding and secret redaction; correct PT key selection; server-owned decimal price; signed webhooks plus event retrieval from the PT’s account; rejection of wrong signature/account/mode/amount and cross-PT booking confirmation; duplicate protection; original-account full/partial refunds; safe retries after provider-response loss or failed persistence; cancellation/decline/expiry/late-payment rules; key replacement, pause, erasure safeguards and encryption-key mismatch; explicit live acknowledgement and sandbox payment/full-refund gate. Existing role, capacity, password reset and legacy migration/Connect tests remain passing.

All Stripe/Resend responses are mocked; fixture keys are not usable credentials. No provider account was linked, payment/refund performed, message sent or Netlify deployment created. Actual restricted-key permissions, Stripe-hosted checkout, webhook delivery, remote database connectivity and live merchant readiness must be validated through STRIPE_SETUP.md on the deployed site.

Prototype limits remain: serialized 8 MiB PostgreSQL snapshot storage, GBP/UK-time class presentation, 1–100 participants, 1–52 session dates, no custom PT domains, booking/no-show email previews, and no anonymous owner-admin recovery. Provider account lookup does not prove every checkout/refund permission. No automatic credential master-key rotation or security audit is claimed. Credential removal preserves payment history and does not revoke keys in Stripe or erase historical backups. Legacy Connect payments retain their original binding and require original configuration/manual Stripe reconciliation.
