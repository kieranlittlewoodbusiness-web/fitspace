# RC-33: status refresh keeps Stripe requirements

**Bug (prod, 22 Nov 23:02 UK):** `POST /api/pt/stripe/status` calls Stripe v2 `GET /v2/core/accounts/{id}`. Without `include=requirements` the response has no requirements, and `accountSnapshot` wrote `{currently_due:[],past_due:[],disabled_reason:null}` over the v1-shaped list stored by the `account.updated` webhook. The Connect card then showed "pending" with no list.

**Fix**
- `worker/index.mjs`: the status GET now asks for `include[0]=configuration.merchant&include[1]=requirements` (`requirements` is a documented include on v2 account retrieve).
- `src/connect-status.mjs` `accountRequirements(account)`:
  - v1 Account (or v1-shaped object): parsed as before.
  - v2 `requirements` with `entries`/`summary`: mapped to the card's shape. Only entries with `awaiting_action_from: user` count. `minimum_deadline.status` `past_due` goes into both `past_due` and `currently_due` (as in v1); `currently_due` goes into `currently_due`; `eventually_due` is ignored. `entries[].description` is the requirement name. `disabled_reason` comes from `configuration.merchant.capabilities.card_payments.status_details` (`requirements_past_due` → `requirements.past_due`, `requirements_pending_verification` → `requirements.pending_verification`), falling back to `requirements.past_due` when anything is past due.
  - Anything else (absent, null, unrecognised): returns `null`.
- `src/ops/accounts.mjs` `bindConnection`: `requirements=COALESCE(?,requirements)`. With `null`, the stored list is kept and returned in the view. ready, charges, payouts and details_submitted are still written on every refresh.

**Effect on the coach row:** the next status tap maps Stripe's live requirements into D1, so no manual D1 write is needed.

**Schema/env:** none. **Tests:** `workers-test/rc-33-requirements.test.mjs` adds the new tests. Also updated: the scope-lint hashes for `bindConnection` and the RC-32 include URL assertion.

**Rollback:** redeploy Worker version `9a1b6a2d-c60c-422e-af9a-4953499f05e5`. There is no data migration to undo.

**Follow-up (RC-34, post-launch):** plain-English labels for requirement codes on the Connect card.
