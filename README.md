# FITSPACE Netlify v7

Start with **START_HERE.md**, then **STRIPE_SETUP.md**. Each PT connects their own Stripe account securely, sets class/block prices, receives direct payments and sees bookings/refunds. Separate sandbox/live connections and verified paid webhooks protect booking confirmation. No credentials or live activation are included.

Build and deploy the complete repository on Netlify using Node 24. See QA_V7.md for verification and limits.

Customer and PT password recovery: **PASSWORD_RESET_SETUP.md**. Configure reset email delivery before relying on it. Class forms independently set weeks/session dates and maximum participants; occupied places cannot exceed the saved limit.
