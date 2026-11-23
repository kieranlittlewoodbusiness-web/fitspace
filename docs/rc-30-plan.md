# RC-30: Block payment options (upfront / weekly / monthly instalments). Plan only

**Decisions (Kieran via PM, 00:04 UK 22 Nov):** Q1 only the trainer can stop future instalments, with no customer self-cancel. Q2 after failed retries the booking stays (past-due) and the PT decides. Q6 a PT cancel defaults to *stop future payments only*, with no automatic refund. Q7 discount codes will apply to plans, so the price snapshot carries an RC-8 hook (§2), but RC-8 isn't built. **PM rulings:** Q3 the last instalment must fall on or before the block's final session (§6, `PLAN_EXCEEDS_BLOCK`). Q4 a plan total may exceed the upfront price, and checkout always shows the total. **Scope: MVP** (§8). Migration 0006 is **preview/local only** until Kieran OKs production.

Branch `rc-30-instalments` from `origin/main` `01ce5b6`. Builds on PR #11 (`rc-5-stripe` @ `eacd4265`, Connect onboarding, not merged yet): code starts after #11 merges, with `main` merged in normally. Spec: TICKETS.md RC-30 (Kieran, 23:57 UK 21 Nov). Rules: single PT, Connect **direct charges** on the PT's connected account (`Stripe-Account` header), **no application fee**, test mode and mocks only, Kieran stays admin, errors are `{error, code}`, idempotent webhooks, existing data kept. The app pins `Stripe-Version 2026-09-30.endive` (`src/stripe.mjs`), so the plan uses the current shapes: `invoice.parent.subscription_details` and `invoice.payments`, not the removed `invoice.subscription` and `invoice.payment_intent`.

## 1. Stripe approach

| Option | Fit | Problems |
| --- | --- | --- |
| **A. Checkout (`mode=subscription`), then a subscription schedule** (`from_subscription`, a single phase with `duration={interval, interval_count:N}`, `end_behavior=cancel`) | Stripe-hosted page (SCA, wallets, card saved on the connected-account customer). It takes **instalment 1 at booking**, and Stripe ends billing after N periods. | Needs a follow-up API call after checkout, so a guard is needed in case that call never happens (below). |
| B. A subscription with `cancel_at` | One call. | Stripe docs: a `cancel_at` that falls "during a future period" always prorates that period. Month-end arithmetic (29–31st) makes the exact boundary fragile. There is no `iterations` on subscriptions (and `phases[].iterations` is superseded by `phases[].duration`). |
| C. PaymentIntent/SetupIntent with the Payment Element, then create a schedule directly | No post-checkout step. | Custom card UI, 3DS handling and much more Web work. The schedule's first invoice needs a saved PM first. |
| D. Invoice-based (N invoices, `collection_method=charge_automatically`, created and finalised by our cron) | No Billing subscription object. | We would build the scheduler. The `stripe_jobs` cron drain doesn't exist (RC-5 notes). Retries and dunning are ours. Klarna/BNPL is a different product (the PT is paid upfront and the customer pays Klarna) and is out of scope. |

**Recommendation: A.** Flow for a plan booking:
1. `POST /api/bookings` reserves the place (existing hold) and snapshots the plan (§2). A `checkout` job creates a Checkout Session on the connected account: `mode=subscription`, one `line_items[0][price_data]` {gbp, `unit_amount`=instalment, `recurring[interval]`=week|month, product name = block title}, `subscription_data[metadata][booking_id|pt_id|plan]`, `customer_email`, the same `expires_at` and success/cancel URLs as today, and no `application_fee_percent`. Checkout creates the Customer and saves the payment method **on the connected account**, so we store `cus_` without holding card data. Upfront bookings keep today's `mode=payment` path unchanged.
2. `checkout.session.completed` with `payment_status=paid` marks the booking `paid` (the place is confirmed) and enqueues job `schedule:<booking_id>`: `POST /v1/subscription_schedules {from_subscription}`, then update phase 0 with `duration` = N × interval measured from the subscription start, `end_behavior=cancel` and `proration_behavior=none`. Billing then ends automatically after instalment N.
3. **Overrun guard** (in case the job fails or is delayed): the job runs inline after the webhook commit (`ctx.waitUntil`), and the minute cron drains pending `schedule:*` jobs only (a small, scoped addition). On `invoice.created` for a subscription cycle where seq > N (a draft invoice, finalised about 1 h later), we enqueue `cancel_plan` (cancel the subscription with no proration, void the draft). On `invoice.paid` for seq = N, if the subscription is still not ending, we set `cancel_at_period_end=true`. Proration is always `none`.

**Fee note** (checked 22 Nov 2026 on https://stripe.com/gb/billing/pricing): Billing pay-as-you-go is **"0.7% of Billing volume"** ("Excludes one-off invoices"), on top of card processing of "1.5% + 20p for standard UK cards" / "2.5% + 20p for EU cards". Who pays: with direct charges Stripe says fee responsibility "depends on your account configuration" (https://docs.stripe.com/connect/subscriptions). RC-5 (#11 `eacd4265`) creates the account with `defaults.responsibilities.fees_collector='stripe'` and `dashboard:'full'`, so Stripe bills the **PT's connected account** for both the processing and the 0.7% Billing fee. The platform pays nothing, and there's no application fee. Upfront bookings (`mode=payment`) carry no Billing fee. Example: £12.50 weekly ≈ 8.75p Billing + 38.75p card per instalment.

## 2. D1 changes: migration `0006_instalments.sql` + `migrations-down/0006_instalments.down.sql`

- `blocks ADD upfront_enabled INTEGER NOT NULL DEFAULT 1`. `blocks.price_pence` stays the upfront price, so every existing block becomes **upfront-only with no backfill writes**.
- New `block_payment_plans(block_id REFERENCES blocks, interval CHECK IN('week','month'), instalment_pence CHECK>0, count CHECK BETWEEN 2 AND 52, enabled INTEGER, updated_at, PRIMARY KEY(block_id, interval))`. The weekly cap is 52 and the monthly cap is 12, checked in `validate.mjs`. A commit guard requires at least one enabled option (`upfront_enabled=1` or an enabled plan).
- `bookings ADD plan TEXT NOT NULL DEFAULT 'upfront' CHECK IN('upfront','week','month')`, `plan_count INTEGER NOT NULL DEFAULT 1`, `instalment_pence INTEGER`, `list_total_pence INTEGER` (count × instalment, before discount), `discount_code_id TEXT NULL`, `discount_pence INTEGER NOT NULL DEFAULT 0`, `total_pence INTEGER` (= list − discount, what the customer pays), `plan_status TEXT` (NULL for upfront; `active|past_due|completed|cancelled`), `stripe_customer_id`, `stripe_subscription_id UNIQUE`, `stripe_schedule_id`. These are the **price snapshot**: written at reserve time from the block and never re-read from the block, so later price edits only affect new bookings. Backfill: `UPDATE bookings SET instalment_pence=amount_pence, total_pence=amount_pence`. For plan bookings, `amount_pence` = instalment 1, so existing checkout code keeps its meaning. `booking_instalments.amount_pence` is the per-instalment amount actually charged.
- **RC-8 discount hook (snapshot only, no code yet):** one pure function `planAmounts({instalment_pence, count, discount})` → `{list_total, discount_pence, total, amounts[]}`. With no discount, each amount = the instalment. With a discount, `total = list − round_half_up(discount)` (percent off the list total, or fixed pence, capped at the list total). Then `base = floor(total / count)`, and the remainder pence (`total − base×count`) go on the **first** instalment, so the sum always equals `total` exactly and later instalments are level. A charge per instalment under Stripe's 30p minimum gives 400 `PLAN_BELOW_MINIMUM`. In Stripe, each instalment becomes its own price amount: a level subscription price for seq 2..N, plus a one-off first-invoice adjustment (`add_invoice_items` with a negative or positive amount) for seq 1 when it differs. That keeps the schedule single-phase. RC-8 only supplies the `discount` input. Upfront bookings use the same function with count=1.
- New `booking_instalments(id PK, booking_id REFERENCES bookings, seq, amount_pence, due_at, status CHECK IN('upcoming','paid','failed','void'), attempt_count DEFAULT 0, next_attempt_at, paid_at, failure_message, stripe_invoice_id UNIQUE, stripe_payment_intent, refunded_pence DEFAULT 0, event_time DEFAULT 0, created_at, UNIQUE(booking_id, seq))`, plus an index on `(status, due_at)`. All N rows are inserted in the reserve batch with projected `due_at`, then corrected to the invoice period when its invoice arrives.
- `stripe_refunds ADD instalment_id TEXT` (NULL = the legacy whole-booking refund).
- Down migration: drop the new table, columns and indexes, then delete the `d1_migrations` row (same style as 0005). It is safe because no existing column changes meaning.

## 3. Webhooks (the existing Connect endpoint, `event.account` = PT account)

Dedupe stays as it is: the `webhook_events` PK insert happens **in the same D1 batch** as the row writes, so a replay or a concurrent duplicate fails the batch and is a no-op 200. Booking lookup uses `subscription_data.metadata.booking_id` (copied to the subscription and invoice parent) or `stripe_subscription_id`, so events don't depend on arrival order.

| Event | Effect |
| --- | --- |
| `checkout.session.completed` / `async_payment_succeeded` (subscription mode, paid) | booking `paid`, `plan_status=active`, store `cus_`/`sub_`, enqueue `schedule:` |
| `checkout.session.expired` | existing hold release; instalment rows → `void` |
| `invoice.created` | guard only (seq > N → `cancel_plan`) |
| `invoice.paid` | match the instalment (seq 1 for `billing_reason=subscription_create`, otherwise the nearest `upcoming`/`failed` row to `period_start`, ±3 days, else booking `review`). Row → `paid`, store `in_`/`pi_` (from `invoice.payments`). Seq N paid → `plan_status=completed`. |
| `invoice.payment_failed` | row → `failed`, `attempt_count`, `next_attempt_at` (null = retries exhausted). `plan_status=past_due`. |
| `invoice.voided` / `invoice.marked_uncollectible` | row → `void` / stays `failed` with `next_attempt_at=NULL` |
| `customer.subscription.updated` / `.deleted` | mirror `past_due`/`active`; deleted → remaining `upcoming` rows `void`, `plan_status=cancelled` (or `completed` if all paid) |
| `subscription_schedule.completed/canceled/released` | audit only |
| `refund.*`, `charge.refunded` | existing refund writes, attributed to the instalment by `pi_` |

Out-of-order handling: each row update has `WHERE event_time<=?` (the same pattern as `stripe_refunds`). `paid` beats `failed`/`upcoming` regardless of order, and `void` never overwrites `paid`. The booking's `paid` status is set by whichever of `checkout.session.completed` or `invoice.paid`(seq 1) arrives first.

## 4. Failed payments (PM default)

Stripe Smart Retries run on the connected account. The booking **stays `paid`/active** and the customer keeps their place. Instalment states: `upcoming → paid`, or `upcoming → failed(retrying, next_attempt_at set) → paid` on a retry, or `→ failed(final, next_attempt_at NULL)`. The plan goes `active → past_due → active` on recovery. The PT dashboard flags failures, and the PT decides: wait, **stop future payments**, or cancel and refund (§5). We don't auto-cancel. That needs the connected account's "after all retries fail" Billing setting to be "leave past due" or "mark uncollectible", not "cancel" (Q2). Stripe's own failed-payment customer emails can be switched on in that account. Our emails are post-MVP.

## 5. Cancellation and refunds

- **Customer** (Q1: no self-cancel): an unpaid pending checkout cancels as today (`prepareCancel` expires the session). After instalment 1 the existing rule holds: 409 `CONTACT_COACH` "Contact your coach to refund a completed payment." There's no customer stop-plan route and no Stripe customer portal.
- **PT/admin "stop future payments"** (Q6: the default and only one-click cancel action; it refunds nothing) (`cancel_plan` job, `cancel:<booking>`): `DELETE /v1/subscriptions/:id` with `prorate=false, invoice_now=false`. Remaining `upcoming`/`failed` rows → `void` and `plan_status=cancelled`. The booking and its place stay (the PT can still cancel the place).
- **Refunds** reuse `prepareRefund`, per instalment: `refund:<booking>:<seq>:<token>` against that row's `pi_`. The guard changes for plan bookings to: succeeded refunds per instalment ≤ the instalment amount, and per booking ≤ the sum of paid instalments. "Cancel and refund all" = `cancel_plan` + one refund job per paid row, with one active refund job per booking at a time, as today.
- Block `cancellation_policy` JSON is not enforced automatically today, and RC-30 doesn't change that.

## 6. API contract (Backend) vs UI (Web)

- `POST /api/blocks`, `PUT /api/blocks/:id` add `payment_options: {upfront: {enabled, price_pence}, weekly: {enabled, instalment_pence, count}, monthly: {…}}`. Errors: 400 `PLAN_INVALID`, 400 `NO_PAYMENT_OPTION`, 400 `PLAN_EXCEEDS_BLOCK` ("The last payment would fall after the block's final session."). The rule (Q3): the projected due date of instalment N, (N−1) intervals after booking, must be ≤ the start of the last `class_sessions` row. It's checked on save (projected from today) **and again at booking** (`POST /api/bookings` 409 `PLAN_EXCEEDS_BLOCK`, and that plan is hidden from the public options once it no longer fits). Q4: there's no comparison with the upfront price. Edits never touch existing bookings.
- Public block / `GET /api/public/pts/:slug` return only the **enabled** options, each with a computed `preview: {today_pence, total_pence, dates:[ISO…]}` (dates from now, in Europe/London). `total_pence` is always present and shown, including when it exceeds the upfront price (Q4).
- `POST /api/bookings {block_id, checkout_token, plan:'upfront'|'week'|'month'}` → as today `{operation…, url}`. Errors: 409 `PLAN_NOT_OFFERED`, 503 `PAYMENTS_NOT_READY`.
- `GET /api/bookings/:id` and the dashboard bookings add `plan, plan_status, total_pence, paid_pence, instalments:[{seq, amount_pence, due_at, status, attempt_count, next_attempt_at, paid_at, refunded_pence}]`.
- `POST /api/bookings/:id/stop-plan` (PT/admin only; customers get 403 `FORBIDDEN`, `request_token`) → operation. 409 `PLAN_NOT_ACTIVE`.
- `POST /api/bookings/:id/refund {request_token, seq?}`: `seq` is required for plan bookings (400 `SEQ_REQUIRED`).
- Dashboard summary adds `instalments: {failed, upcoming_pence_30d}`.

Web (stays off Backend files, and coordinated with RC-29 on `validate.mjs`/accounts): **W1** a PT block form with three toggles and amount/count fields, a live "N × £x = £total" readout, and a note that edits only apply to new bookings. **W2** a checkout option picker showing today's amount, the remaining dates and **always the total** before confirming. **W3** a dashboard instalments view per booking: paid/upcoming/failed badges, the retry date, and Stop/Refund buttons.

## 7. Test plan (mocked Stripe, vitest workers, no network)

- Migration up/down on a seeded copy: existing blocks are upfront-only and booking totals equal their amounts.
- Validation: limits, at least one option, `PLAN_EXCEEDS_BLOCK` on save and at booking (the boundary on the final session date passes), a plan total above upfront allowed, and an edit after booking leaves the snapshot unchanged.
- `planAmounts` rounding table: no discount; percent and fixed discounts; remainder on seq 1; sum = total; below-minimum error.
- Customer `stop-plan` → 403. A PT stop creates no refund job.
- Checkout payload: subscription mode, `Stripe-Account` set, no application fee, metadata present. Upfront payload unchanged.
- Schedule job: idempotency key, retry from cron, and the overrun guard (`invoice.created` seq N+1 → cancel).
- Webhooks: a replay table for every event; duplicate and concurrent duplicate (one write); `invoice.paid` before `checkout.session.completed`; `failed` after `paid` ignored; period matching at month ends (Jan 31).
- Failure lifecycle → past_due → recovered/final. Stop-plan voids the remainder. Per-instalment refund guards, including over-refunding.
- `{error, code}` on every new error path. Single-PT and readiness 503s.
- QA: Stripe test clocks in test mode, only after Kieran's yes on test keys.

## 8. Effort estimate (PR-sized, each with CR + QA)

| Step | Owner | Size |
| --- | --- | --- |
| B1 migration 0006 + block options API + public previews | Backend | S–M |
| B2 plan checkout + schedule job + cron drain + webhooks | Backend | L (the core risk) |
| B3 stop-plan + per-instalment refunds + dashboard fields | Backend | M |
| W1 block form · W2 checkout summary · W3 dashboard view | Web | S · S · M |

Token note: B2 is about one RC-5-sized cycle, and the full set is about 3× RC-5 (roughly 6 PR cycles).

**Agreed MVP order (about 4 cycles):** (1) **B1+B2 as one PR**: migration 0006 (preview/local only), block options API with `PLAN_EXCEEDS_BLOCK`, snapshot + `planAmounts` hook, plan checkout, schedule job + cron drain + overrun guard, webhooks. (2) **W1+W2** (Web): block form + checkout summary. (3) **read-only W3 + B3 "stop future payments"**: dashboard instalments view and the `stop-plan` route only. Refunds stay on the existing PT refund flow. Deferred: picking a single instalment to refund (`seq`), our own failure emails, applying RC-8 codes (hook only), and test-clock QA until Kieran's yes on test keys.

## 9. Questions: resolved and open

Resolved: Q1 trainer-only stop · Q2 past-due, PT decides · Q3 last instalment ≤ final session (`PLAN_EXCEEDS_BLOCK`) · Q4 total may exceed upfront and is always shown · Q6 stop future payments only · Q7 codes apply to plans (hook in §2).

Still open:
- **Q5** Is the Billing fee acceptable? It's 0.7% of instalment volume, paid by the PT's account (see the §1 fee note).
- The PT must set "after all retries fail" to *leave past due* in their Stripe Billing settings (Q2). Who does that at go-live: the PT, or Kieran as admin?
