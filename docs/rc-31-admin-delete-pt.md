# RC-31: Admin delete PT

Admin can soft-delete a personal trainer account from Admin › Trainers. Booking, payment and webhook history is kept so refunds and Stripe reconciliation still work. Stripe itself is never called (the connected account is only unlinked locally).

## API contract

### `DELETE /api/admin/pts/:id`

Admin-only, CSRF-protected like the other admin mutations. `?force=1` is required when the PT has upcoming paid or still-held pending bookings (a future `class_sessions.starts_epoch`, status `paid` or unexpired `pending`).

`DELETE /api/admin/trainers/:id` is accepted as an alias (same auth, CSRF, body and query rules). `PUT` branding is not aliased.

| Status | When | Body |
|---|---|---|
| 200 | Deleted | `{ ok: true, pt_id }` |
| 401 | Not signed in | `{ error, code: "UNAUTHENTICATED" }` |
| 403 | Not admin, or missing/invalid CSRF | `{ error, code: "FORBIDDEN" }` (CSRF has no code) |
| 403 | Target is the acting admin or another admin | `{ error, code: "ADMIN_PROTECTED" }` |
| 404 | Unknown or already-deleted id | `{ error }` |
| 409 | Upcoming paid or pending bookings, and `force` is not `1` | `{ error, code: "UPCOMING_BOOKINGS", upcoming_count }` |

Effects, in one Writer `deletePt` batch:

- All of the PT user's sessions are revoked (the old cookie is then 401 on authed routes).
- Their blocks are unpublished and closed (`published=0`, `closed=1`).
- The public slug is freed by renaming it to `deleted-<pt_id>`, `published=0`, `create_key`/`create_hash` cleared. `/api/public/pts/:slug` 404s and a new PT can reuse the original slug (and the original email; the deleted user email is anonymised).
- The PT user is soft-deleted (`active=0`, `deleted_at` set, name/email anonymised). Login and password reset already reject `active=0`.
- `stripe_connections` rows are deleted (local unlink only). `pts.stripe_account` is kept; `stripe_ready` is cleared. `pt_stripe_credentials` rows are kept with `enabled=0` so historical `pt_direct` refunds can still load the original key.
- Refunds use `bookings.stripe_account_id` (and the job payload `account`), not the live connection row, so they still find the connected account after unlink.
- An `audit_log` row is written with action `pt_deleted`.

In single-PT mode (`MULTI_PT_ENABLED` not `"true"`), deleting the only PT leaves the site with no live PT (same as before any PT existed). `single_pt_free` is `NOT EXISTS(SELECT 1 FROM pts WHERE deleted_at IS NULL)`, so the admin can create a new PT afterwards, including with the same slug.

## Migration and rollback

`migrations/0007_soft_delete.sql` adds nullable `deleted_at` on `users` and `pts`. Existing rows stay live (`NULL`).

Rollback (one step, before 0006's down):

```
wrangler d1 execute DB --local|--remote --file migrations-down/0007_soft_delete.down.sql
```

That drops only the two columns and removes the `d1_migrations` row. Do not apply the down if any live rows have `deleted_at` set unless you have first restored or removed those soft-deleted accounts; otherwise a previously deleted PT would reappear as live (and its tombstone slug would still be unique).
