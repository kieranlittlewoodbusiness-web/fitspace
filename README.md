# FITSPACE Netlify v8

Start with **START_HERE.md** and **STRIPE_SETUP.md**. No owner Stripe account is needed. Each PT securely configures their own restricted Stripe key and webhook; credentials are encrypted, sandbox/live are separate and payments use the server-owned class price. Signed, account-owned events confirm bookings; refunds, expiry, failures and participant limits remain integrated.

Use **PASSWORD_RESET_SETUP.md** for customer/PT recovery. Deploy all source files through Netlify Git/CLI using Node 24. New server setting: CREDENTIAL_ENCRYPTION_KEY, 64 random hexadecimal characters; keep it stable and private. No credentials, deployment, live activation or provider transactions are included. See **QA_V8.md** for tests and limitations.
