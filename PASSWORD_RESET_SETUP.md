# Customer and PT password resets — v7

The Sign in form includes **Forgot your password?** Customer and PT accounts can request a private email link and choose a new password. The link expires after 30 minutes, is single use, and does not sign the user in automatically. The reset revokes all sessions and outstanding links for that account. Changing a password normally also invalidates existing reset links. Roles, PT ownership, bookings and Stripe connections are retained.

## Configure Netlify

Create a Resend account, verify your sender domain and create a sending API key. Configure these as Netlify **Functions** secrets for the relevant deploy context, then redeploy:

| Variable | Value |
| --- | --- |
| `RESET_EMAIL_MODE` | `send` |
| `RESEND_API_KEY` | Your server-side Resend sending key |
| `MAIL_FROM` | A verified sender, e.g. `FITSPACE <accounts@your-domain>` |
| `AUTH_RESET_SECRET` | A randomly generated secret, at least 32 characters |
| `APP_URL` | Canonical HTTPS origin, e.g. your production Netlify URL; no path |

Generate AUTH_RESET_SECRET with your password manager or locally using `openssl rand -hex 32`. Never paste it or the provider key in chat, commit it or put it in frontend code. Keep it unchanged across ordinary redeployments. Rotating it invalidates previous links. Keep DATABASE_URL and DATA_NAMESPACE unchanged when upgrading.

This dedicated setting enables only reset links and password-change security notifications. Booking confirmations and no-show messages remain previews. No emails were sent or provider credentials configured while preparing this update. Admin → My account indicates whether reset email settings are configured; this flag is not proof of inbox delivery. The public reset page explains when email setup is unavailable.

## Test after deploying

1. Use a customer account with an inbox you control. Sign in on two devices, then choose Forgot your password? and request a link.
2. Confirm the email arrives from your verified sender and links to your real site. Request responses do not disclose whether an email matches an eligible account. Check spam/provider logs if necessary; the UI cannot guarantee delivery. There is no automatic retry scheduler: request a new link if a message does not arrive.
3. Open the link and enter a new password twice (12–200 characters). Merely opening the page does not use the link. The fragment is removed from the address bar once the app reads it. Refreshing that page requires reopening the email link.
4. Check the old password no longer works, both earlier sessions are closed, and the new password works. Bookings and role must be unchanged. A security notification is emailed after a successful reset.
5. Try reusing the link: it must fail. Request another and wait 30 minutes: it must expire. Reset one of multiple outstanding links: all the others must fail.
6. Repeat for a PT account. A PT can recover a temporary password and will retain their own trainer page and classes. Test requests are limited to three per email per hour and have persisted per-IP limits as well.

Reset links are stored as hashes and are never included in staff message previews or API responses. Requests are checked against the application origin. Provider delivery jobs commit before email is attempted; failed responses do not expose private links or provider errors. No payment credentials are involved.

Public self-service recovery is limited to active, non-demo customer and PT accounts. The owner’s admin account uses My account for a known-password change; anonymous admin recovery is not included. Keep the owner’s credentials securely stored.

Official setup references: https://resend.com/docs/dashboard/domains/introduction ; https://resend.com/docs/api-reference/emails/send-email ; https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
