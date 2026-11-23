# RC-30 instalments: API contract (MVP, v2)

**v2 changes (23 Nov, agreed with Web M66 and the PM)**:
- **C1 block price**: with `payment_options`, `price_pence` is optional. The £1–£10,000 check applies only when upfront is enabled. Without `payment_options`, the old validator is unchanged.
- **C2 booking response**: `POST /api/bookings` for an instalment plan answers `201 {booking, booking_id, url:"/checkout/:id"}` (the in-app checkout flow).
- **C3 open checkout**: `409 PAYMENT_IN_PROGRESS` carries `{url, booking_id}` of the caller's own open checkout.
- **C4 booking read**: `GET /api/bookings/:id` gains `today_pence`, `total_pence`, `list_total_pence` and `discount_pence` in `instalment_plan`.
- **PM ruling (trainer-only stop)**: only the **owning PT** can stop a plan. Admin and customers get 403, and `can_stop` is true only for the owning PT.
- **Codes**: 401 uses the existing code `UNAUTHENTICATED`, not `AUTH_REQUIRED`.

The contract Web (M66, branch `rc-30-ui`) builds against. Backend implements it on `rc-30-instalments` (from main `96c7f1a`). Sources: `docs/rc-30-plan.md` (ca88de6), TICKETS.md RC-30, and Kieran's answers (00:05 UK 22 Nov). No feature code is in this commit.

## Conventions

- **Money**: integer **pence, GBP** (`"currency": "gbp"`). **Dates**: ISO 8601 UTC (`2026-12-01T18:00:00Z`). The UI shows them in Europe/London.
- **Plans**: `"upfront" | "weekly" | "monthly"`.
- **Auth**: the session cookie (401 `UNAUTHENTICATED`). Every write also sends `x-csrf-token` (from `/api/me`). Role checks are listed per route. Single-PT mode: a PT only sees their own blocks and bookings, and admin (Kieran) can do everything a PT can.
- **Errors**: always `{ "error": "<message for people>", "code": "<STABLE_CODE>" }`. Web branches on `code` only.
- **Rules**: existing blocks stay upfront-only until instalments are enabled. Price edits only affect **new** bookings, because each booking keeps a snapshot. Instalment 1 is paid at booking and confirms the place. Billing ends after the last instalment. Stripe direct charges on the coach's connected account, with no application fee. Only the trainer can stop a plan. A failed payment after retries keeps the booking, and the trainer decides what happens next.
- **Rounding** (with a discount): `total = list_total − discount` (percent discounts round half up, and a discount never goes below 0). Each payment = `floor(total / count)`, and the leftover pence go on **payment 1**, so the payments always add up to `total` exactly.
- DB: migration **0008**, preview/local only, which also reuses the `list_price_pence`, `discount_pence` and `discount_code_id` booking columns from 0002.

## 1. Block plan config (PT class-block form)

`POST /api/blocks` (create) and `PUT /api/blocks/:id` (edit). Role: `pt` (own block) or `admin`. These are the existing routes with a new `payment_options` field. If you leave `payment_options` out of a PUT, the current setting stays (old blocks remain upfront-only).

**C1 price rules**:
- With `payment_options`, top-level `price_pence` is optional.
- Upfront enabled: `upfront.price_pence` (or `price_pence`) is required, 100–1,000,000, and stored as the block price.
- Upfront disabled: the block price is stored as the **lowest enabled plan total**, a "from" price for listings, with no 100–1,000,000 check.
- Without `payment_options`, the old validator is unchanged.

Request (other block fields unchanged):
```json
{ "title": "8-week strength block", "...": "...",
  "payment_options": {
    "upfront": { "enabled": true,  "price_pence": 10000 },
    "weekly":  { "enabled": true,  "amount_pence": 1250, "count": 8 },
    "monthly": { "enabled": false, "amount_pence": 5000, "count": 2 } } }
```
Response `200`/`201`: the block as today plus the saved `payment_options` (the same shape) and a computed `totals`:
```json
{ "block": { "id": "blk_…", "...": "...",
  "payment_options": { "upfront": { "enabled": true, "price_pence": 10000 },
                       "weekly": { "enabled": true, "amount_pence": 1250, "count": 8 },
                       "monthly": { "enabled": false, "amount_pence": 5000, "count": 2 } },
  "totals": { "upfront": 10000, "weekly": 10000, "monthly": 10000 } } }
```
Validation (400 unless noted):
- `NO_PAYMENT_OPTION`: nothing is enabled.
- `PLAN_INVALID`: a bad amount or count. Weekly count is 2–52 and monthly count is 2–12. Each amount must be at least 30p (Stripe's minimum). `upfront.price_pence` must be ≥ 0.
- `PLAN_EXCEEDS_BLOCK`: the last payment, (count − 1) intervals from today, would fall after the block's final session.
- `FIELDS_INVALID`: malformed JSON types, with `fields: ["payment_options.weekly.count"]`.

A plan total may be higher than the upfront price. Also 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` (not your block), 404 `NOT_FOUND`.

## 2. Checkout quote (per enabled plan)

**a) In the public block read**: `GET /api/public/pts/:slug` (no auth). Each `blocks[]` item gains `payment_options[]` listing **enabled plans only**, each with a no-code quote:
```json
"payment_options": [
  { "plan": "upfront", "today_pence": 10000, "total_pence": 10000, "payments": [ { "seq": 1, "amount_pence": 10000, "due_at": "2026-11-23T22:00:00Z" } ] },
  { "plan": "weekly", "interval": "week", "count": 8, "amount_pence": 1250,
    "today_pence": 1250, "total_pence": 10000,
    "payments": [ { "seq": 1, "amount_pence": 1250, "due_at": "2026-11-23T22:00:00Z" },
                  { "seq": 2, "amount_pence": 1250, "due_at": "2026-11-30T22:00:00Z" } ] } ]
```
The list is abbreviated here (weekly lists all 8 payments). Dates are projected from now, and the final dates are confirmed at booking. A plan that would now run past the final session is left out.

**b) With a discount code**: `POST /api/bookings/quote`. Role: `customer` (signed in). It is **write-free** and safe to repeat; the UI re-quotes on Apply and on every plan change while a code is entered.
```json
{ "block_id": "blk_…", "plan": "weekly", "discount_code": "NEWYEAR10" }
```
`200`:
```json
{ "quote": { "plan": "weekly", "count": 8, "list_total_pence": 10000,
  "discount": { "code": "NEWYEAR10", "discount_pence": 1000 },
  "total_pence": 9000, "today_pence": 1125,
  "payments": [ { "seq": 1, "amount_pence": 1125, "due_at": "2026-11-23T22:00:00Z" },
                { "seq": 2, "amount_pence": 1125, "due_at": "2026-11-30T22:00:00Z" } ] } }
```
`discount` is `null` when no code is given. Errors:
- 400 `DISCOUNT_INVALID`: unknown, expired or used up, or the code doesn't cover this block.
- 409 `PLAN_NOT_OFFERED`.
- 409 `PLAN_EXCEEDS_BLOCK`.
- 409 `BLOCK_UNAVAILABLE`: full, closed or past.
- 401 `UNAUTHENTICATED`.
- 403 `FORBIDDEN`: not a customer.
- 404 `NOT_FOUND`.

The discount hook is **reserved**: until RC-8 ships, any non-empty code returns 400 `DISCOUNT_INVALID`. The response shape doesn't change when RC-8 lands.

**c) Create the booking + checkout**: `POST /api/bookings` (existing route). Role: `customer`.
```json
{ "block_id": "blk_…", "checkout_token": "<uuid from the page>", "plan": "weekly", "discount_code": null }
```
`plan` defaults to `"upfront"`, so old clients still work.

**C2**: for `weekly`/`monthly` the answer is `201 { "booking": {…}, "booking_id": "bk_…", "url": "/checkout/bk_…" }`. Navigate to the in-app `/checkout/:id` page. Its pay button calls the existing `POST /api/bookings/:id/checkout`, which returns `{url, booking_id}` with the Stripe-hosted URL that takes payment 1. **Upfront is unchanged from main**: demo mode returns `201 {booking, booking_id, url:"/checkout/:id"}` (booking_id added), and Stripe mode returns `200 {url, booking_id}` with the Stripe URL. Either way, `url` starting with `/` means navigate in the app, and anything else means redirect. The booking is confirmed once Stripe reports payment 1, and the return page polls `GET /api/bookings/:id`.

Idempotency: the same `checkout_token` returns the same booking and Checkout. The quote is re-computed and **snapshotted** at this call.

Errors are as for the quote, plus:
- 409 `PLACE_TAKEN`: no space left.
- 409 `PAYMENT_IN_PROGRESS` (**C3**): the caller already has an open checkout for this block. The body adds `{ "url": "/checkout/bk_…", "booking_id": "bk_…" }` for that checkout. It is only ever the caller's own, because the lookup is by the signed-in customer.
- 409 `ALREADY_BOOKED`: the caller already has a paid place on this block.
- 503 `PAYMENTS_NOT_READY`: the coach's Stripe isn't ready.

## 3. PT instalment plans (dashboard) and stop

**List**: `GET /api/pt/instalment-plans?status=active|past_due|completed|stopped|all` (default `all`). Role: `pt` (own) or `admin`.
```json
{ "past_due_reminder": { "show": true, "count": 1,
    "message": "1 plan has a failed payment. Stripe retries automatically. Check what happens after the final retry in your Stripe Billing settings (set it to leave the subscription past due)." },
  "plans": [ { "booking_id": "bk_…", "block_id": "blk_…", "block_title": "8-week strength block",
    "customer": { "name": "Sam Lee", "email": "sam@example.com" },
    "plan": "weekly", "status": "past_due", "count": 8,
    "list_total_pence": 10000, "discount_pence": 0, "total_pence": 10000,
    "paid_pence": 2500, "remaining_pence": 7500, "created_at": "2026-11-23T22:00:00Z",
    "can_stop": true,
    "payments": [
      { "seq": 1, "amount_pence": 1250, "due_at": "2026-11-23T22:00:00Z", "status": "paid", "paid_at": "2026-11-23T22:01:10Z" },
      { "seq": 2, "amount_pence": 1250, "due_at": "2026-11-30T22:00:00Z", "status": "paid", "paid_at": "2026-11-30T22:03:00Z" },
      { "seq": 3, "amount_pence": 1250, "due_at": "2026-12-07T22:00:00Z", "status": "failed", "attempts": 2, "next_retry_at": "2026-12-10T22:00:00Z", "failure": "Card declined" },
      { "seq": 4, "amount_pence": 1250, "due_at": "2026-12-14T22:00:00Z", "status": "upcoming" } ] } ] }
```
- Plan `status`: `active` (paying on schedule), `past_due` (a payment failed and Stripe is retrying, or retries are used up and the coach needs to decide), `completed` (all paid, billing ended) or `stopped` (the coach stopped future payments).
- Payment `status`: `paid`, `upcoming`, `failed` (`next_retry_at: null` means Stripe has stopped retrying) or `void` (cancelled by a stop or an expired checkout; show it as "Cancelled").
- The place is **kept** in every status. Upfront bookings don't appear in this list.
- `GET /api/bookings/:id` (customer owner, PT or admin), **C4**: plan bookings gain an `instalment_plan` object. It is nested because the booking already has its own `status`.
  ```json
  "instalment_plan": { "plan": "weekly", "status": "active", "count": 8, "today_pence": 1250, "total_pence": 10000,
    "list_total_pence": 10000, "discount_pence": 0, "paid_pence": 1250, "remaining_pence": 8750,
    "can_stop": true, "payments": [ { "seq": 1, "amount_pence": 1250, "due_at": "…", "status": "paid", "paid_at": "…" } ] }
  ```
  `can_stop` is present for the PT and admin but true **only for the owning PT** on an active or past-due plan; admins always see false. Customers get **no** `can_stop` key. Upfront bookings have no `instalment_plan`.
- `GET /api/dashboard` gains `instalments: { "past_due_count": 1, "active_count": 3 }` for the reminder badge.

**Stop future payments**: `POST /api/pt/instalment-plans/:booking_id/stop`. Role: **the owning `pt` only** (PM ruling). Admin and customers get 403 `FORBIDDEN`, and another PT's booking is 404 `NOT_FOUND`. In the list, `can_stop` is false for admin.
```json
{ "request_token": "<uuid per click>" }
```
`200`:
```json
{ "booking_id": "bk_…", "status": "stopped", "voided_payments": 5, "refunded_pence": 0 }
```
It cancels the Stripe subscription with no proration and nothing billed now. The `upcoming` and `failed` payments become `void`, the booking and place stay, and **nothing is refunded**. Refunds use the existing refund action.

Idempotency: the same `request_token` returns the same result. Errors:
- 409 `PLAN_NOT_ACTIVE`: already completed or stopped. A new token gets this; a repeat of the same token gets the earlier 200.
- 409 `PAYMENT_IN_PROGRESS`: Stripe is still processing. Retry with the same token.
- 401 `UNAUTHENTICATED`.
- 403 `FORBIDDEN`: admin, customer, or a bad CSRF token.
- 404 `NOT_FOUND`: not yours, or not a plan booking.
- 503 `PAYMENTS_NOT_READY`.

## Error code summary

| HTTP | code |
| --- | --- |
| 400 | `FIELDS_INVALID`, `PLAN_INVALID`, `NO_PAYMENT_OPTION`, `PLAN_EXCEEDS_BLOCK` (block save), `DISCOUNT_INVALID` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` (wrong role or not yours; also a bad CSRF token) |
| 404 | `NOT_FOUND` |
| 409 | `PLAN_NOT_OFFERED`, `PLAN_EXCEEDS_BLOCK` (at quote or booking), `BLOCK_UNAVAILABLE`, `PLACE_TAKEN`, `PAYMENT_IN_PROGRESS` (+`url`, `booking_id`), `ALREADY_BOOKED`, `PLAN_NOT_ACTIVE`, `CONTACT_COACH` (customer cancelling a paid booking, as today) |
| 503 | `PAYMENTS_NOT_READY` |

## Webhooks handled (server only, no client impact)

These arrive on the existing Connect endpoint and are verified, deduped by `event.id` in the same D1 batch, and safe out of order:
- `checkout.session.completed` and `checkout.session.async_payment_succeeded` (confirm the booking and attach the end-after-N schedule).
- `checkout.session.expired` (release the place, void the payments).
- `invoice.created` (overrun guard).
- `invoice.paid`.
- `invoice.payment_failed`.
- `invoice.voided`.
- `invoice.marked_uncollectible`.
- `customer.subscription.updated` and `customer.subscription.deleted`.
- `subscription_schedule.completed`, `subscription_schedule.canceled` and `subscription_schedule.released` (audit).
- `refund.*` and `charge.refunded` (the existing refund flow).

Fee: Stripe Billing is 0.7% of billing volume (OK'd by Kieran), on the coach's account.

## Out of MVP

A customer stop or self-service portal, refunding one chosen instalment, our own failure emails, RC-8 code management, and changing a running plan.
