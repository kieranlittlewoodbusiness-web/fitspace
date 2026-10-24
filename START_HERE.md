# FITSPACE — Netlify v7

Public, responsive customer pages; protected customer, PT and admin accounts. Black/white/yellow default branding, custom trainer pages, flexible class blocks, limited places, upfront payment and attendance. Stripe Connect lets each PT provide their details securely at Stripe and receive their own payments at the class price they set.

## Deploy the complete source

1. Extract this ZIP. Put its contents in your private Git repository with **package.json and netlify.toml at the repository root**. An extra enclosing folder requires that folder as Netlify’s base directory. Do not solve a missing-package.json error by creating an empty npm project.
2. Import the repository into Netlify. Use Node 24, build `npm run build`, publish `site`, Functions `netlify/functions`, base directory blank when files are at the repository root. Static drag-and-drop does not install this backend.
3. Add Netlify Functions environment variables:

| Variable | Value |
| --- | --- |
| DATABASE_URL | Your PostgreSQL connection URL with provider TLS settings; never setup instructions |
| ADMIN_EMAIL | Your owner sign-in email |
| ADMIN_PASSWORD | Your own 12–200-character password, used for first-account bootstrap |
| ADMIN_NAME | Optional owner display name |
| DATA_NAMESPACE | Keep existing public namespace, default `fitspace-public-v4` |
| AWS_LAMBDA_JS_RUNTIME | `nodejs24.x` |
| PAYMENT_MODE | `demo` initially, then `stripe_test` for sandbox |

4. Deploy/redeploy and visit the Netlify URL. There is no site-wide password. Sign in using your owner credentials. In **PT accounts**, create each trainer’s account, branding and named page. Save the temporary PT password and share it privately yourself; no invitation is sent.
5. PT signs in, changes their temporary password and creates classes with dates, capacity and a total upfront price. The first published PT becomes the homepage; each has `/pt/<slug>`. Customers sign up to book. Customer signup cannot grant staff access.
6. Follow **STRIPE_SETUP.md** to configure Connect, webhooks and sandbox checkout. Each PT opens **Payments** to connect their account and check readiness. Admin’s **Stripe setup** page checks server configuration. Do not send secret keys in chat.

No Stripe details or credentials are bundled. No deployment or provider transaction has been performed for you. Demo payments need no card; Stripe sandbox uses hosted Checkout. Live capability is available through explicit stripe_live configuration, matching live keys, webhooks and separate PT live onboarding. Use sandbox for tests and live only for genuine purchases. Email confirmations and no-show messages remain previews.

## Password resets and participant limits

Customer and PT sign-in now includes **Forgot your password?** Configure the dedicated reset email settings in **PASSWORD_RESET_SETUP.md**; reset emails do not work until the provider, verified sender and server reset secret are configured. Resetting signs out every device, invalidates outstanding links and keeps the account’s role, trainer and bookings. No reset links are exposed in staff message previews.

In Classes & blocks, set **Number of weeks / sessions** (1–52 dates) and **Maximum participants** (1–100) independently. A nine-week block may have seven places, for example. Confirmed bookings and active checkout holds use places. Full blocks reject further bookings. You can raise capacity; lowering it below occupied places is rejected. Expired, failed or cancelled holds release places; fully successful Stripe refunds also release them.

## Upgrade and data

Keep DATABASE_URL and DATA_NAMESPACE unchanged when upgrading public v4/v5. v7 preserves users, class dates, bookings, attendance and refunds, adds separate live/test connections and migrates the booking mode constraint. Back up your database first. Existing test accounts remain test-only. Changing bootstrap ADMIN_PASSWORD does not reset an existing account; change it in My account.

Upgrading from the old password-protected demo requires a fresh public namespace such as fitspace-public-v4, your own owner variables and recreating trainers/classes. The public app refuses stores containing shared demo accounts. Remove PREVIEW_PASSWORD; it is unused. Never expose the old demo namespace.

PostgreSQL must be reachable from Netlify with table-creation permissions. The prototype stores the SQLite engine as a transactional PostgreSQL snapshot; API calls are serialized with an 8 MiB snapshot cap. It is appropriate for small-scale validation, not a finished high-traffic commercial platform. Custom trainer domains and automatic email sending are not included. Keep original database backups; namespaces are not a security boundary.

## Validate

With Node 24:

```bash
npm ci
npm run build
npm test
npm run test:bundle
```

The tests exercise the actual bundled Netlify Function and a local PostgreSQL-compatible engine, with mocked Stripe responses and signed webhook fixtures. See QA_V6.md. They do not replace the deployed Stripe sandbox checklist. No remote Netlify/database/Stripe account has been configured here.

Troubleshooting: missing package.json means the repository/base folder is wrong; database errors usually mean DATABASE_URL, reachability, TLS or permissions; missing trainers means Admin has not created/published a PT; failed payments require matching mode/key, a ready PT and a correctly signed webhook destination. Check provider delivery logs. No-show emails are previews by design.
