# RC-14: Single-coach mode (`MULTI_PT_ENABLED`)

Resilience Coaching runs as one published coach by default. Multi-trainer features stay in the tree (schema, tests and route code) but are hidden until `MULTI_PT_ENABLED` is exactly `"true"`.

Single-PT mode applies on the Worker only, and legacy Netlify is unchanged until cutover.

## Environment

| Name | Type | Default | Meaning |
|---|---|---|---|
| `MULTI_PT_ENABLED` | var (string) | `false` (unset or any value other than `"true"` is off) | `"true"` turns the public trainer directory, extra PT creates, RC-7 platform subscription routes, subscription-scope discount codes and legacy `pt_direct` key routes back on. |

Set in `wrangler.jsonc` (`vars` and `env.preview.vars`) and optionally in `.dev.vars` for local `wrangler dev`. The Worker reads it per request; nothing is cached.

## API contract

### `GET /api/public/site`

Unauthenticated. Response:

```json
{
  "multi_pt_enabled": false,
  "pt": {
    "id": "...",
    "slug": "local-coach",
    "brand_name": "...",
    "tagline": "...",
    "description": "...",
    "about": "...",
    "accent": "#ffd43b",
    "background": "#111111",
    "foreground": "#ffffff",
    "features": ["..."],
    "published": true,
    "booking_path": "/pt/local-coach"
  },
  "default_slug": "local-coach"
}
```

- `pt` is the first published PT by `created_at`, plus opaque `booking_path`, or `null` if none is published.
- `default_slug` is that PT's slug, or `null`.
- `Cache-Control: public, max-age=60`.
- Errors are `{ "error": "...", "code": "..." }`.
- Front end should link to `booking_path` and not build `/pt/{slug}` itself.

`/` is the Resilience Coaching landing (Web owns the page). This API is the server side of that landing.

### `GET /api/me`

Includes `multi_pt_enabled` (boolean) for every role and for anonymous callers. `default_slug` is unchanged.

### `GET /api/public/pts`

404 `{ error, code: "MULTI_PT_DISABLED" }` when single-PT mode is on. When `MULTI_PT_ENABLED=true`, the published directory is unchanged.

### `GET /api/public/pts/:slug`

In single-PT mode this resolves only the one published PT (the same one as `default_slug`). Any other slug is 404.

### `POST /api/admin/pts`

The first PT can always be created. A further create (different `create_key`) returns 409 `{ error, code: "SINGLE_PT_EXISTS" }`. The same `create_key` still replays. Two concurrent creates are serialised by the Writer and a commit-time `single_pt_free` guard (`NOT EXISTS(SELECT 1 FROM pts WHERE deleted_at IS NULL)`), so exactly one live PT is inserted. After an admin deletes that PT (see `docs/rc-31-admin-delete-pt.md`), a new PT can be created, including with the same slug.

### `/trainers` and `/trainers/`

In single-PT mode, `GET`/`HEAD` 302 to `booking_path`, or to `/` when there is no published PT. In multi-PT mode the SPA is served as today.

### Hidden multi-PT routes (404 `MULTI_PT_DISABLED` when off)

- `GET /api/public/pts` (directory)
- Legacy `pt_direct` key routes: `POST /api/pt/stripe/{credentials,check,enable,disconnect}` and `POST /api/stripe/pt/:id/webhook`
- RC-7 platform subscription: `/api/pt/subscription`, `/api/admin/subscription(s)` and subpaths
- RC-8 subscription-scope codes: `/api/pt/subscription-codes`, `/api/admin/subscription-codes` and subpaths

When `MULTI_PT_ENABLED=true` those features keep their existing behaviour (RC-7/RC-8 routes are not implemented yet, so they 404 as unknown without this code). Class-scope discount codes and PT/admin class management stay available; `pt_id` scoping is unchanged. No schema is dropped.

### Stripe Connect

At most one Connect account in single-PT mode (direct charges on the connected account, no application fee, test mode). The PT creates it via `POST /api/pt/stripe/connect`. Admin platform-account linking (`POST /api/admin/stripe/link`) is 409 `PLATFORM_LINK_DISABLED`. A second bind is 409 `SINGLE_CONNECT_EXISTS`. The admin role is unchanged (Kieran stays admin). The PT and the admin can both create class codes for that PT (rule for RC-8).

## Copy

| Surface | Before | After |
|---|---|---|
| Customer `POST /api/bookings/:id/cancel` of a completed Stripe payment (409) | Contact the trainer to refund a completed payment. | Contact your coach to refund a completed payment. |

RC-20 Worker copy is already on main and is not redone here.

## Schema

No migration. Rollback is: set `MULTI_PT_ENABLED=true` (or remove the var and the new routes). The `single_pt_free` and `single_connect` guards are application-level, not indexes.

## Local seed

After `npm run db:migrate:local` and (optionally) the admin bootstrap:

```
SEED_PT_EMAIL=coach@example.com SEED_PT_PASSWORD='...' npm run db:seed:local
```

`--local` only. `--remote` is refused. The password is never printed. Re-running is a no-op if a PT already exists. This does not create an admin.
