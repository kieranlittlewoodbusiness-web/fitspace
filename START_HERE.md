# FITSPACE — Public Netlify version 4

Anyone can browse the homepage, trainer pages, prices, dates and remaining
places. **There is no site-wide password or preview gate.** Customers sign in to
book; PT and admin tools still require their own account login.

Payments remain simulated and email messages remain previews. Public access
does not enable live payments. This package has not been deployed for you.

## Deploy on Netlify

Deploy the complete extracted project using Netlify's Git import or CLI. A
static drag-and-drop upload does not install the backend Functions.

1. Extract the ZIP and put its contents in a private GitHub repository. Keep
   `netlify.toml`, `package.json`, `app/`, `lib/` and `netlify/` at the root.
2. Import that repository into Netlify. The supplied settings are:

   | Setting | Value |
   | --- | --- |
   | Base directory | Repository root; leave blank |
   | Build command | `npm run build` |
   | Publish directory | `site` |
   | Functions directory | `netlify/functions` |
   | Node.js version | `24` |

3. Add these Netlify environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Your PostgreSQL connection URL with your provider's TLS settings |
   | `ADMIN_EMAIL` | Your own admin sign-in email |
   | `ADMIN_PASSWORD` | Your own admin password, 12–200 characters |
   | `ADMIN_NAME` | Optional; your display name |
   | `DATA_NAMESPACE` | `fitspace-public-v4` |
   | `AWS_LAMBDA_JS_RUNTIME` | `nodejs24.x` |

   Scope the database/admin secrets to Functions where scope controls are
   available. Set the runtime variable through Netlify, not TOML. Do not upload
   a real `.env` file or use the old shared demo password for your admin.

4. Deploy or redeploy. Open the public Netlify URL. Browsing needs no password.
5. Select **Sign in** and use your `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
6. In **PT accounts**, create your trainer account, its page name, colours,
   introduction and training highlights. Save the temporary PT password shown.
7. Sign in as that PT, change its temporary password under **My account**, then
   create and publish your classes and blocks. The first published trainer
   becomes the root homepage. Trainers also have `/pt/<slug>` URLs.

Until a trainer has been created, the public page shows a coming-soon message.
There are no seeded demo trainers, customers, bookings or privileged accounts.
Your admin is created securely on the first successful API request.

## Updating an existing v3 deployment

- Replace the source with this version and redeploy.
- Remove `PREVIEW_PASSWORD`; it is no longer read.
- Add your own `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Set **`DATA_NAMESPACE=fitspace-public-v4`**, including when an older namespace
  was explicitly set. This starts a fresh public store without deleting v3 data.
- Do not point this public version at the old demo namespace. It refuses to open
  a store containing shared demo accounts rather than exposing their data.
- Re-create your trainer pages/classes in the new store. This package does not
  migrate the old demo accounts, test bookings or branding automatically.

Changing the admin environment password later does not reset an existing
account. After setup, change account passwords through **My account**.

## Account access

- **Visitors:** browse published trainer pages and class information freely.
- **Customers:** create their own account, book and complete simulated checkout.
  Signup cannot grant PT or admin access.
- **PTs:** accounts are created by Admin. They manage their own classes,
  bookings, attendance and simulated revenue.
- **Admin:** only the owner account created from server environment variables;
  it creates PT accounts and customises branding, pages and blocks.

No shared demo login buttons or credentials are shipped in the public frontend.
Dashboards, bookings and mutations remain protected by server-side role checks,
app-session cookies, CSRF protection, password hashing and sign-in limits.

## Included features

- Black/white/yellow default design and responsive customer, PT and admin views.
- Trainer-specific colours, copy, page names and `/pt/<slug>` page addresses.
- Flexible blocks of 1–52 sessions, exact dates, capacity and upfront prices.
- Shared, persistent bookings and capacity across devices.
- Pending checkout holds expire after 31 minutes.
- Simulated payment success/decline, booking reference and confirmation.
- PT attendance and no-show previews titled “Sorry we missed you at class!”,
  with one of 20 random motivational replies. Repeated marking is deduplicated.

## Payments and email

This public version **does not charge cards or send emails**. It always uses
simulated checkout and saves email previews. Do not add Stripe/Resend keys.
Stripe provider routes and the email worker are disabled in the Netlify wrapper.
The retained local backend source includes earlier optional integration code;
activating external providers requires a separate, tested update. Live payments
remain blocked pending your approval.

## Database and hosting requirements

You need a separate PostgreSQL database and a Netlify account. Use a standard
PostgreSQL connection URL, not a database provider's HTTP API endpoint. The
connection's user needs permission to create tables in its default schema.
Provider usage charges depend on your plans.

PostgreSQL persists a binary snapshot of the existing SQLite booking engine.
Each API request takes a transaction and row lock, opens a disposable working
copy, runs the action, and commits the updated snapshot before returning success.
Temporary function disk is never the durable store. Competing requests to the
same namespace are serialised, protecting capacity and preventing lost updates.

This remains a small test-payment prototype: the snapshot cap is 8 MiB and all
requests to a store are serialised. A commercial launch requires a normal
relational PostgreSQL schema, account recovery/operations and provider testing.
Custom trainer domains are not included.

Keep `DATABASE_URL` and `DATA_NAMESPACE` unchanged to retain data across deploys.
A new namespace creates a separate empty store, without deleting existing data.
Namespaces are not a database security boundary.

## Mac/PC CLI alternative

With Node.js 24 installed, inside the extracted project folder:

```bash
npm ci
npm run build
npx netlify-cli login
npx netlify-cli init
```

Add the environment variables through Netlify, then create a draft deployment:

```bash
npx netlify-cli deploy --build
```

Publish the production URL when you are ready:

```bash
npx netlify-cli deploy --build --prod
```

Both URLs allow public browsing. Production hosting still uses test payments.

## Validation and troubleshooting

```bash
npm ci
npm run build
npm test
npm run test:bundle
```

Tests cover public anonymous access, rejection of demo logins, real owner-account
bootstrap, customer signup, PT account creation, checkout, capacity competition,
attendance, no-show previews, role isolation, persisted sessions/bookings after
reconnect and rollback on failure. Original backend tests also remain included.
The packaged Netlify function is tested against a local PGlite PostgreSQL engine
over its wire protocol. Your remote database and a live Netlify deployment have
not been provisioned or tested here.

After deploying, check anonymous browsing in a private browser window, create a
customer account, complete a simulated booking, and check it from the PT view.

- **No trainer pages yet:** sign in as Admin and create the first PT page.
- **Missing owner setup:** set `ADMIN_EMAIL` and a 12–200-character
  `ADMIN_PASSWORD`, then redeploy. These are admin credentials, not a visitor gate.
- **Store contains demo accounts:** use a fresh `DATA_NAMESPACE`, as above.
- **Could not load/save:** check PostgreSQL reachability, TLS settings, table
  permissions and Node.js 24 in the function logs.
- **Static setup page:** deploy the whole source through Git/CLI, not only `site/`.
- **No-show email doesn't arrive:** expected; messages remain previews.
