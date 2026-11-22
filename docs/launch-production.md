# Production Worker config (L1)

This is the config and command reference for `env.production` in `wrangler.jsonc`. **Do not deploy, set secrets, or touch prod D1 from this document.** Those steps need Kieran's yes and are in the launch runbook.

The default env stays as it is today: no cron, no `CRON_ENABLED`, `PAYMENT_MODE=demo`, `EMAIL_MODE=preview`, no routes. A production target is allowed only with an explicit `--env production`.

## Deploy and bootstrap (after approval)

```
npx wrangler deploy --env production --dry-run
npx wrangler deploy --env production
npx wrangler d1 migrations apply DB --env production --remote
printf %s "$ADMIN_PW" | ADMIN_EMAIL=<kieran's address> ADMIN_NAME="Kieran" \
  node scripts/bootstrap-admin.mjs --remote --confirm-remote --env production --confirm-production
```

The bootstrap script never prints emails or secrets. `--remote` without `--env production` is refused.

## Vars (committed in `wrangler.jsonc`, not secrets)

| Name | Production value |
|---|---|
| `APP_URL` | `https://resiliencecoaching.app` |
| `PAYMENT_MODE` | `stripe_live` |
| `STRIPE_INTEGRATION` | `connect` |
| `MULTI_PT_ENABLED` | `false` |
| `EMAIL_MODE` / `RESET_EMAIL_MODE` | `send` |
| `CRON_ENABLED` | `true` |
| `MAIL_FROM` | `bookings@mail.resiliencecoaching.app` |
| `D1_DATABASE_ID` | the production D1 id (same as the `DB` binding) |

`MAIL_FROM` is a platform var, not a secret. The coach's reply-to comes from PT settings (a separate PR) and is passed to Resend as `reply_to` once email is live.

**No inbound mail at launch.** Do not add MX records or Resend inbound/receiving. Sending from `bookings@mail.resiliencecoaching.app` is enough.

The preview-only password-reset shortcut stays fail-closed on production: `EMAIL_MODE` is `send`, `APP_URL` is the apex, and `D1_DATABASE_ID` is the production id.

## Secrets (names only)

Set each with `npx wrangler secret put <NAME> --env production` and paste the value at the prompt. Never put a value in a shell argument, in git, or in chat. Check names only with `npx wrangler secret list --env production`.

| Name | What to set |
|---|---|
| `STRIPE_SECRET_KEY` | Restricted live key (`rk_live_…`). See below. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the platform webhook endpoint |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret for the Connect webhook endpoint |
| `RESEND_API_KEY` | Sending-only Resend key |
| `AUTH_RESET_SECRET` | `openssl rand -base64 48` (32+ characters) |
| `PT_INVITE_SECRET` | `openssl rand -base64 48` (32+ characters) |

Do not set `CREDENTIAL_ENCRYPTION_KEY` unless legacy `pt_direct` rows are imported. Prod starts empty, so this is not needed.

Deploying with secrets missing is safe: payment APIs answer 503 `PAYMENTS_NOT_READY`.

## Restricted Stripe key permissions

Use a restricted live key (`rk_live_…`), not an unrestricted `sk_live_…` key. Create it in live mode: [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys). Permission names are from the [API permissions reference](https://docs.stripe.com/keys/permissions-reference).

In the Dashboard, grant **Write** on these resources, including the **connected accounts** column where the Dashboard offers one (checkout and refunds use the `Stripe-Account` header):

| Dashboard resource | Permission | Why |
|---|---|---|
| Checkout Sessions | Write (`checkout_session_write`) | Create, retrieve and expire Checkout Sessions on the coach's connected account |
| Charges and refunds | Write (`charge_write`) | Create refunds on the coach's connected account |
| Accounts (v2) | Write (`v2_account_storer_write`) | Create a connected account, create v2 account onboarding links, and read account status (`GET /v2/core/accounts/{id}`) |

The Worker also calls `GET /v1/account` for the platform Stripe check. If that returns 403, grant the Dashboard permission that covers retrieving your own account.

Do not grant Billing, Application fees, or payouts. `event_read` is only used by the legacy PT-owned webhook path, which is not the launch path.

## Domain

The apex `resiliencecoaching.app` is the canonical address (`APP_URL`). `www.resiliencecoaching.app` is attached as a second Worker custom domain in `wrangler.jsonc`. The Worker responds to `www` with a **301** to the matching apex path and query (`wwwToApexRedirect` in `worker/index.mjs`). This does not change files under `app/public`. There is no Netlify fallback.
