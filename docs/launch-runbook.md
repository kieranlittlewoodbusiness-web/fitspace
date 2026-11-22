# Resilience Coaching: production launch runbook

Written 22 Nov 2026 at 01:00 UK, based on main `a9d32297` (RC-4, RC-14 and RC-5 are merged). This document only describes the steps. **None of them has been run.**
Target: live by Mon 23 Nov, real customer bookings by Wed 25 Nov. Launch is upfront payment only, and RC-30 instalments come after launch.

Who does each step:
- **[Backend]**: done by an agent, locally or in a PR.
- **[Kieran yes]**: needs Kieran's explicit approval for that step.
- **[Kieran hands]**: Kieran works in a dashboard (Cloudflare, Stripe, Resend), handles keys, or changes DNS.
- **[PT]**: done by the coach.

Wrangler is **not** logged in on the box. Every prod command below runs in one of two ways:
- (a) Kieran runs it on his own machine with `npx wrangler login`.
- (b) Kieran creates a scoped API token and an agent runs it with `CLOUDFLARE_API_TOKEN` set on the box.

The token needs these permissions: Account › Workers Scripts:Edit, D1:Edit, Account Settings:Read; Zone (resiliencecoaching.app) › Workers Routes:Edit, DNS:Edit.
Default in this runbook: (b) for D1 and deploy, with each run approved separately. Admin bootstrap is always (a), because it's owner-only by design.

## 0. Facts checked on 22 Nov at about 01:00 UK (read-only)
- Account `a56fd9d0…` (Workers Paid). Workers: `resiliencecoaching-preview` (preview D1 `81379d2e`), plus a stray Worker `fitspace` (RC-27, the stale Git integration). Prod D1 `fd8a613f-…` is empty.
- **The resiliencecoaching.app zone is already on Cloudflare.** It is `active` on the Free plan, the nameservers are `gerardo`/`julissa.ns.cloudflare.com`, and there are **0 DNS records**. Public DNS confirms the Cloudflare NS records and no A record for the apex or `www`.
  - So the domain **does not currently point at Netlify, or anywhere**. The "cutover" is really "attach the Worker". The Netlify rollback would mean adding records, not restoring them. See §6.
- Readiness guards in the code (`worker/index.mjs paymentReadiness`, `src/stripe.mjs validatePlatformKey`):
  - With `PAYMENT_MODE=stripe_live`, every non-diagnostic API returns 503 unless all of these hold: the key starts `sk_live_`/`rk_live_`, `STRIPE_WEBHOOK_SECRET` is set, and `APP_URL` is `https://host`.
  - Password reset is enabled only when `RESET_EMAIL_MODE=send`, `RESEND_API_KEY` and `MAIL_FROM` are set, `AUTH_RESET_SECRET` is at least 32 characters, and `APP_URL` is https.
  - The cron does nothing unless `CRON_ENABLED="true"`.
  - Prod-id guards (`docs/rc-4/d1-rehearsal/guard.mjs`) block the preview tooling from ever targeting `fd8a613f`.

## 1. Critical path (UK times, assuming Kieran is available from Sun 09:00)
| # | When | Step | Who | Est. |
|---|---|---|---|---|
| 1 | Sun 09:00 | Answer the decision list (§10) | [Kieran yes] | 15 m |
| 2 | Sun 09:15 | **Blocker L1**: prod env config PR (§2), CR, QA, merge | [Backend] | 1.5–2 h |
| 3 | Sun 09:15 (parallel) | **Blocker L2**: privacy, terms and cookies pages plus footer (RC-21). Kieran OKs the copy | Web, then [Kieran yes] | 2–3 h |
| 4 | Sun 09:15 (parallel) | Set up Resend: add the domain, add DNS records (§5), wait for verification | [Kieran hands] | 20 m + up to a few h waiting |
| 5 | Sun 09:15 (parallel) | Stripe live: activate the platform account, enable Connect in live, branding (§4.1) | [Kieran hands] | 30–60 m (Stripe review can take longer) |
| 6 | Sun 10:00 | **Blocker L3**: Stripe **test-mode** end-to-end on the preview with real test keys: connect, book, webhook marks it paid, refund, emails in preview | [Kieran yes] for test keys, [Kieran hands] to paste them, QA | 1.5 h |
| 7 | Sun 12:00 | Create the scoped API token (above) | [Kieran hands] | 10 m |
| 8 | Sun 12:15 | Prod D1: Time Travel bookmark, export, migrations 0001–0005, verification (§3) | [Backend] via token, [Kieran yes] | 15 m |
| 9 | Sun 12:30 | Admin bootstrap on prod D1 (§3.3) | [Kieran hands] | 5 m |
| 10 | Sun 12:35 | Set Worker secrets (§2.3) | [Kieran hands] for values; [Backend] can run `secret put` with piped stdin only if Kieran pastes into a form | 15 m |
| 11 | Sun 12:50 | Deploy the prod Worker and attach the custom domain (§2.4, §6) | [Backend] via token, [Kieran yes] | 15 m + certificate issuance of a few minutes |
| 12 | Sun 13:10 | Create live webhook endpoints, then set the secrets (§4.2) | [Kieran hands] | 15 m |
| 13 | Sun 13:30 | Kieran signs in and creates the single PT (§3.4). PT signs in, changes password, presses Connect Stripe, completes live onboarding | [Kieran hands], then [PT] | 30 m + Stripe verification (**hours to 2 days: the biggest schedule risk**) |
| 14 | When PT is `active` | £1 live smoke booking, then refund (§4.5) | [Kieran hands] + [Backend] watches | 20 m |
| 15 | Mon am | Go/no-go (§8) | [Kieran yes] | 15 m |
| 16 | Mon–Tue | Monitor, then retire old keys and Netlify (§4.7, RC-OPS-1) | [Kieran hands] | 30 m |

Earliest realistic "live and working": **Sun afternoon**, if PT verification is quick. Otherwise Mon/Tue. That still fits Wed bookings.

## 2. Prod Worker deploy
### 2.1 Blocker L1 (config PR, [Backend])
The default env in `wrangler.jsonc` is deliberately non-deployable: no `APP_URL`, no route, no cron, `PAYMENT_MODE=demo`, `EMAIL_MODE=preview`.
`tests/remote-guards.test.mjs` asserts that the default env has no cron. One small PR (`launch-config`) should:
- add `env.production` with `name: "resiliencecoaching"`, the prod D1 binding (`fd8a613f-…`), the `WRITER` DO and DO migration `v1`, `triggers.crons ["* * * * *"]` and `observability.enabled: true`;
- add `routes: [{ "pattern": "resiliencecoaching.app", "custom_domain": true }, { "pattern": "www.resiliencecoaching.app", "custom_domain": true }]` (see §6 for www);
- strip the prod D1 binding from the top-level env, or point it at a local placeholder, so a bare `wrangler deploy` can't hit prod;
- update the guard tests so they assert: the prod cron appears only in `env.production`; `D1_DATABASE_ID` is **not** set in production, so the preview out-of-band reset stays fail-closed; and `PAYMENT_MODE=stripe_live` appears only in production.

Vars for `env.production`:
```
APP_URL=https://resiliencecoaching.app   PAYMENT_MODE=stripe_live   STRIPE_INTEGRATION=connect
MULTI_PT_ENABLED=false   EMAIL_MODE=send   RESET_EMAIL_MODE=send   CRON_ENABLED=true
MAIL_FROM="Resilience Coaching <bookings@mail.resiliencecoaching.app>"   (address per decision D4)
```
Not set in prod: `D1_DATABASE_ID`, `DEMO_MODE` and `STRIPE_API_VERSION` (leave them unset unless they're pinned in test).

### 2.2 Build check (local, [Backend])
`npm ci && npm test && npm run test:workers && npx wrangler deploy --env production --dry-run --outdir /tmp/rc-prod`

### 2.3 Secrets (names only, `npx wrangler secret put <NAME> --env production`, value pasted at the prompt, never in a shell argument)
`STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (platform endpoint), `STRIPE_CONNECT_WEBHOOK_SECRET` (Connect endpoint), `RESEND_API_KEY`, `AUTH_RESET_SECRET` (`openssl rand -base64 48`), `PT_INVITE_SECRET` (`openssl rand -base64 48`).
Only set `CREDENTIAL_ENCRYPTION_KEY` if legacy `pt_direct` rows are ever imported. That isn't the plan, because prod starts empty.
Check with `npx wrangler secret list --env production`, which lists names only.
Deploying with secrets missing is safe: every payment API answers 503 `PAYMENTS_NOT_READY`.

### 2.4 Deploy
`npx wrangler deploy --env production` creates the version and attaches the custom domains.
Check `curl -s https://resiliencecoaching.app/health` returns `{"ok":true}`.
Record the version ID in TICKETS.md.

**Rollback:** `npx wrangler rollback --env production` to the previous version. Before any customer is live, `npx wrangler delete --env production` removes the Worker and its custom domains, which leaves D1 intact. Migrations are additive, so older code runs on the newer schema.

## 3. Prod D1 (`DB` → `fd8a613f-…`)
### 3.1 Before each remote step
```
npx wrangler d1 time-travel info DB --env production            # record the bookmark in TICKETS.md
npx wrangler d1 export DB --env production --remote --output backups/prod-$(date +%Y%m%d-%H%M).sql
```
Keep `backups/` off git and set it to mode 0700.

### 3.2 Migrations
#11 added **no** new migration, so the set is 0001–0005.
```
npx wrangler d1 migrations list DB --env production --remote     # expect 5 unapplied
npx wrangler d1 migrations apply DB --env production --remote
npx wrangler d1 execute DB --env production --remote --command "SELECT name FROM d1_migrations ORDER BY id"            # 5 rows
npx wrangler d1 execute DB --env production --remote --command "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"   # 23 + d1_migrations
```
Rollback: either `npx wrangler d1 time-travel restore DB --env production --bookmark=<recorded>`, or the down files newest-first (`migrations-down/0005…0002`). The DB is empty, so a restore is lossless.

### 3.3 Admin bootstrap ([Kieran hands], owner-only)
```
ADMIN_EMAIL=<kieran's address> ADMIN_NAME="Kieran" node scripts/bootstrap-admin.mjs --remote --confirm-remote
# password typed at the stdin prompt (12+ chars); never printed or stored
```
The script refuses if an admin already exists.
Verify: `... --command "SELECT count(*) FROM users WHERE role='admin'"` returns 1.
Rollback: bootstrap from the restored bookmark, or delete the single admin row before any other data exists.

### 3.4 The single PT ([Kieran hands], in the app, not SQL)
Kieran signs in at https://resiliencecoaching.app, goes to Admin › Trainers › create, and enters the PT's name, email and slug. A second PT is refused with 409 `SINGLE_PT_EXISTS`.
The app shows a temporary password once. Kieran gives it to the PT out of band, never in chat, and the PT must change it at first sign-in.
Verify: `SELECT count(*) FROM pts` returns 1, and `GET /api/public/site` shows the coach once at least one block is published.

## 4. Stripe live (RC-OPS-2)
### 4.1 Platform and Connect settings ([Kieran hands], Stripe Dashboard, live mode)
- Activate the platform account: business details and bank account.
- Connect › Settings, live mode:
  - Branding: name "Resilience Coaching", icon, brand colour (yellow/black).
  - Onboarding: **Stripe-hosted** (account links).
  - Connected accounts: Stripe pays the fees and is liable for losses. The code creates accounts with `fees_collector`/`losses_collector = stripe` and full Dashboard access.
- Charges are **direct** (`Stripe-Account` header) with **no application fee**. The code never sets `application_fee_amount`, so nothing needs configuring there.
- Create the live secret key. The code accepts `sk_live_` or `rk_live_` (decision D2).

### 4.2 Webhooks ([Kieran hands])
Both endpoints point at **`https://resiliencecoaching.app/api/stripe/webhook`**. Use the API version that the test-mode E2E used.
- **Connect endpoint ("Events on connected accounts")**, which carries all booking traffic for direct charges. Its signing secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`. Events:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `account.updated`.
- **Platform endpoint ("Your account")**. Its signing secret goes in `STRIPE_WEBHOOK_SECRET`; the readiness guard requires it. Events: `account.updated`, plus the same checkout/refund set as a harmless fallback.
- Check during the step 6 test run: whether `account.updated` arrives for a v2-created account. If it doesn't, the PT's "Refresh status" button (`POST /api/pt/stripe/status`) still updates readiness.

### 4.3 PT live onboarding ([PT])
PT dashboard › Payments › **Connect Stripe**, then Stripe-hosted onboarding (identity, bank account). Back in the dashboard, the state should go `onboarding_incomplete` → `pending` → `active`. Bookings work once `card_payments` is `active`.

### 4.4 Past-due retry setting (needed for RC-30 only, not at launch) ([PT])
In the PT's own Stripe Dashboard: Billing › Revenue recovery › Retries. Set "If all retries for a payment fail" to **leave the subscription past-due**. Kieran agreed the coach does this. W3/B3 will show a reminder.

### 4.5 £1 live smoke test
1. PT creates a hidden test class (or a published one with 1 place) at £1.
2. Kieran signs up as a customer and books it. Pays by real card on Stripe Checkout.
3. Expect: the booking becomes `paid` within seconds through the Connect webhook; the confirmation email arrives; the payment shows in the PT's Stripe Dashboard with no application fee.
4. PT refunds it from the dashboard. Expect: refund `succeeded` and the booking shows as refunded.
5. Unpublish or delete the test class.

The £1 is net of Stripe fees, which the PT bears (about 22p, not returned on refund).

### 4.6 Rollback
Set `PAYMENT_MODE=stripe_test` (or `demo`) in `env.production` and redeploy, or `wrangler rollback`. This stops new live checkouts. Existing paid bookings stay paid, and the PT can refund from their own Stripe Dashboard. To stop all traffic, roll the live key in Stripe; the API then returns 503.

### 4.7 Old-key cut-off ([Kieran hands], Tue after launch)
Delete the Stripe and `DATABASE_URL` env vars from Netlify. Roll any test or live keys that Netlify or legacy `pt_direct` ever held. Keep the preview's **test** keys. Delete the stray `fitspace` Worker or its Git integration (RC-27).

## 5. Real email (Resend, already wired: `src/mail.mjs`, cron-delivered)
- Wired today: booking confirmation, no-show, password reset link and "password changed". **Not built**: day-before reminder and PT invite email (RC-10 remainder, deferrable).
- [Kieran hands] Create a Resend account and add the domain **`mail.resiliencecoaching.app`** (a subdomain keeps the apex free; decision D4). Add these records in Cloudflare DNS exactly as Resend shows them, all **DNS-only (grey cloud)**:
  - DKIM: TXT `resend._domainkey.mail` (the value comes from Resend).
  - SPF / return path: MX `send.mail` → `feedback-smtp.<region>.amazonses.com` priority 10, and TXT `send.mail` → `v=spf1 include:amazonses.com ~all`.
  - DMARC: TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:<kieran's dmarc address>`. Start at `p=none` and tighten to `quarantine` after 2 clean weeks.
  - Optional: if Kieran wants to receive mail at the apex, add MX records for his mailbox provider (decision D5).
- Secrets and vars: `RESEND_API_KEY` (a sending-only key), `AUTH_RESET_SECRET`, `MAIL_FROM`, `EMAIL_MODE=send`, `RESET_EMAIL_MODE=send`, `CRON_ENABLED=true`. Addresses at `@example.com` are always suppressed.
- Test: use "Forgot password" for Kieran's admin; the email arrives within about a minute and the link works once. The step-4 booking sends the confirmation, with reply-to set to the PT.
- Rollback: set `EMAIL_MODE=preview` and `RESET_EMAIL_MODE=preview` and redeploy. Mail stops and the outbox rows are kept. Reset then shows the generic message and sends nothing.

## 6. DNS / domain (RC-OPS-1)
- The zone is already active on Cloudflare with **no records** (§0), so there's no TTL to lower and nothing on Netlify to cut over from DNS. The Netlify site is just orphaned. A TTL step only matters if Kieran wants a Netlify fallback first (D6).
- Attach the Worker with custom domains, through the routes in §2.1 or Dashboard › Workers › resiliencecoaching › Domains. Cloudflare creates the proxied DNS record and the edge certificate. Do this for both:
  - **apex** `resiliencecoaching.app`: the canonical host (`APP_URL`);
  - **`www`**: also a Worker custom domain. Then add a redirect rule (Rules › Redirect Rules: `www.resiliencecoaching.app/*` → `https://resiliencecoaching.app/${1}`, 301), or let the app serve it. A redirect is preferred for SEO.
- SSL check: SSL/TLS mode **Full (strict)** and "Always Use HTTPS" on. Then `curl -sI https://resiliencecoaching.app` should show 200 with the app's security headers, `curl -sI http://…` should give a 301 to https, and the certificate is issued by Google or Let's Encrypt for both hosts. **HSTS stays off**: not approved, and the code doesn't send it.
- `.app` is on the HSTS preload list at TLD level, so browsers force https whatever we do. That's fine.
- Rollback: remove the custom domains, which takes the site offline. If Netlify is wanted as a fallback, add `CNAME @`/`www` → `<netlify-site>.netlify.app` (DNS-only) and set the Netlify domain. That needs D6.

## 7. Rollback summary
| Section | Fast rollback |
|---|---|
| Worker | `wrangler rollback --env production`, or remove the custom domain |
| D1 | `d1 time-travel restore --bookmark=<recorded>`, or the down files, plus the export file |
| Stripe | `PAYMENT_MODE=stripe_test` and redeploy; roll the live key; disable the webhook endpoints |
| Email | `EMAIL_MODE`/`RESET_EMAIL_MODE=preview` and redeploy; revoke the Resend key |
| DNS | Remove the Worker custom domains; optionally add the Netlify CNAME |

## 8. Go/no-go and post-launch smoke tests
Go only if every item holds:
- L1–L3 are merged or passed.
- `/health` is ok on the apex, www redirects, and the certificate is valid.
- `GET /api/me` shows `payment_mode:"stripe_live"`, `email_mode:"send"`, `password_reset_available:true` and `multi_pt_enabled:false`.
- `wrangler secret list` shows all 6 names.
- The PT's Connect state is `active`.
- The £1 smoke test was paid then refunded, with emails received.
- The privacy and terms links work in the footer.
- Webhook endpoints show 2xx deliveries in Stripe.
- Logs show the cron running (`RC-4 cron:` counts) with no errors.

Daily for the first week: check Stripe webhook failures, the Worker error rate (observability), the D1 bookings count against Stripe payments, and any outbox rows stuck in `failed`.

## 9. Launch blockers in code (main `a9d32297`, which includes #11)
| Area | State on main | Launch? |
|---|---|---|
| Bookings plus Stripe Checkout as direct charges, capacity holds, expiry | Ported (RC-4 phase 3). Tested **with mocks only** | OK, but needs L3 |
| Connect onboarding and status (RC-5) | Merged in #11 | OK |
| Refunds (PT/admin, from the dashboard) plus refund webhooks | Ported, with guards | OK |
| Customer cancel | Pending bookings only. A paid booking returns "Contact your coach to refund" | OK for launch; state it in the terms |
| Emails: confirmation and reset | Wired via Resend and the cron | OK once §5 is done |
| Password reset | Needs `RESET_EMAIL_MODE=send` plus the secrets; the preview out-of-band path is fail-closed in prod | OK |
| Admin and PT dashboards | Single-PT mode (RC-14), class builder, attendance, refunds | OK; RC-22 polish deferrable |
| Stripe job retries | Retried by the client; no cron drain | OK |

**Must-have before real customers**
- **L1**, prod env config in `wrangler.jsonc` plus guard tests. [Backend], ~1 cycle (1.5–2 h with CR and QA).
- **L2**, RC-21 privacy, terms (including the cancellation and refund policy) and cookie pages, with footer links. Web, ~1 cycle (2–3 h); Kieran approves the copy. UK GDPR and consumer law expect these before taking payments and personal data.
- **L3**, real Stripe **test-mode** end-to-end (part of RC-40) on the preview: connect → checkout → webhook → paid → refund. QA plus Backend, ~1.5 h. Needs Kieran's yes for the test keys and webhook. No live money should move before this passes.

**Deferrable after launch**
- RC-7 (platform subscription; hidden in single-PT mode)
- RC-8 (discount codes)
- RC-9 extras (per-class policy UI)
- RC-10 remainder (reminders, invite emails)
- RC-11 (waitlist)
- RC-22 polish
- RC-23 (add to calendar)
- RC-29 (theme)
- RC-30 (instalments)
- SEO ticket (sitemap and canonical; cheap, do it in week 1)
- RC-27 (stray Worker)

## 10. Decisions for Kieran
- **D1:** Go for the plan and timings in §1, including the scoped API token (option b) versus running the wrangler commands yourself (option a).
- **D2:** Stripe live key type. A restricted `rk_live_` key is safer but must be proven in the test E2E. A standard `sk_live_` key is simpler.
- **D3:** Yes to the Stripe **test** keys and webhook on the preview now (L3).
- **D4:** Sender address and domain (suggested `bookings@mail.resiliencecoaching.app`), and the reply-to (the PT's email).
- **D5:** Do you need to receive email at @resiliencecoaching.app? If so, which mailbox provider (it needs MX records)?
- **D6:** Canonical host: apex, with www redirecting. And is a Netlify fallback wanted at all? Today the domain points nowhere.
- **D7:** Approve the privacy, terms and cancellation copy (L2), including the refund policy shown to customers.
- **D8:** Each prod step needs its own yes: D1 migrations, the bootstrap, secrets, deploy, the custom domain, live webhooks, the £1 test, and turning off Netlify.
