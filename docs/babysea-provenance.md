# BabySea provenance and OSS scope

`ledger-fortress` is grounded in BabySea's real Stripe + Supabase credit implementation. The OSS package keeps the same public ledger lifecycle and replaces BabySea-specific account, generation, and dashboard tables with adopter-supplied IDs.

The grounding was validated against BabySea's internal production implementation:

- Credit schema (plans, credits, credit_ledger, `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, and ledger idempotency indexes).
- Credit alert schema (low-balance alert settings and fired-threshold deduplication).
- Credit service module (request-time reserve, charge confirmation, refund, and alert reset/check calls).
- Billing webhook handler (Stripe `invoice.paid` and `checkout.session.completed` reconciliation into `add_credits` with `invoice:*` and `order:*` idempotency keys, using the paid Stripe amount by default).
- Cleanup service and cron handler (scheduled crash cleanup that marks stale pending generations failed and refunds reserved credits).
- Team billing service plus the billing webhook stale-session check for credit-pack active-subscription guards.

## BabySea-derived OSS surface

| Area | BabySea pattern | OSS surface |
|---|---|---|
| Atomic reserve | One guarded balance deduction before dispatching generation work | `reserve_credits()` / `fortress.reserve()` |
| Charge confirmation | Success callbacks write a charge ledger row because reserve already deducted balance | `charge_credits()` / `fortress.charge()` |
| Failure refund | Failure, cancellation, and cleanup paths return a prior reservation only when it was not already charged or refunded | `refund_credits()` / `fortress.refund()` |
| Additive Stripe grants | Subscription invoices and credit packs add to the current balance; renewal never resets credit packs | `add_credits()` / `fortress.addCredits()` |
| Stripe idempotency keys | Invoices use `invoice:{id}`; credit packs use `order:{id}` | Stripe helper and `add_credits()` idempotency index |
| Crash recovery | Scheduled cleanup finds stale pending work and safely refunds reserved credits | `find_orphaned_reservations()` / `fortress.recoverOrphans()` |
| Low-balance alerts | Fire once per threshold descent, re-arm after top-up/refund | `check_credit_alerts()` and `reset_credit_alerts()` |
| Stale checkout guard | Credit pack redemption is guarded at webhook time, not only checkout creation time | `hasActiveSubscription` callback |
| Security boundary | Credit tables are backend-owned financial state, not client-writable cache | Supabase RLS, backend/service-role calls, `SECURITY DEFINER`, locked `search_path` |

## OSS generalizations over BabySea-specific tables

The OSS package removes BabySea-specific account, subscription, order, file asset, and dashboard schemas. These helpers are included only where they preserve an invariant BabySea already operates:

| OSS helper | Production grounding | Why it exists in OSS |
|---|---|---|
| `get_plan_credits()` | BabySea stores Stripe Price IDs and credit allocations in `plans`; production app code also reads `plans` directly for billing/plan behavior. | Standalone adopters may not have BabySea's app loaders, so the helper exposes a hardened plan lookup over the same table pattern. |
| `find_orphaned_reservations()` | BabySea cleanup queries stale `file_assets`, checks for an existing `reserve` ledger row, marks work failed, and calls `refund_credits()`. | Standalone adopters may use different job tables, so the helper finds ledger-level orphan reservations that can be refunded safely. |
| Charge-after-refund re-collection | BabySea guards cancel/cleanup/status races in application code before refunding and keeps charge/refund idempotency in SQL. | Without BabySea's `file_assets` status gate, the OSS SQL preserves the same economic invariant by re-deducting before a late charge is logged. |

## Naming differences from BabySea internals

The OSS package renames the spendable balance unit from `tokens` to `credits` to match the public-facing concept ("1 credit = $1") and to avoid confusion with LLM tokens.

| Surface | BabySea internal name | OSS name |
|---|---|---|
| Balance column | `credits.tokens` | `credits.credits` |
| Plan allocation column | `plans.tokens` | `plans.credits` |
| Ledger amount column | `credit_ledger.amount` | `credit_ledger.amount` (unchanged) |
| RPC parameter | `p_tokens` | `p_credits` |
| SDK field | `tokens` | `credits` |

The economic invariant, precision (`NUMERIC(10,3)`), idempotency indexes, ledger types (`reserve / charge / refund / add`), and function names (`reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`) are unchanged.

## Hardening additions on top of the BabySea invariants

The OSS package adds defensive checks at the SQL boundary that BabySea relies on application-layer services (`cost/service.ts`, `cleanup-service.ts`, the request validation layer) to enforce. They preserve every BabySea invariant and are safe additions for standalone adopters who do not have those layers.

| OSS hardening | What it adds | BabySea equivalent today |
|---|---|---|
| `lf_validate_credit_amount()` | Rejects amounts with more than 3 decimal places, non-positive amounts, and amounts above `9,999,999.999`. | Application-side cost service computes a validated `NUMERIC(10,3)` amount before any RPC call. |
| `CHECK (amount > 0)` on `credit_ledger` | SQL-level guard against zero or negative ledger rows. | Application skips zero/negative `amount_paid` invoices in the billing webhook handler. |
| `UNIQUE (generation_id) WHERE type='reserve'` | Reserve idempotency at the SQL level; second reserve for the same generation is a safe no-op when the account/amount match. | Application controls retries; production does not enforce this in SQL today. |
| `charge_credits` / `refund_credits` require a matching `reserve` row | A terminal event for an unreserved generation raises instead of silently mutating balance. | Application sequencing ensures a reserve always precedes terminal events. |
| Amount equality between reserve and charge/refund | Charge or refund with an amount different from the prior reserve raises. | Application passes the reserved amount through; production does not enforce equality in SQL. |
| `PERFORM 1 FROM credits FOR UPDATE` in charge/refund | Serializes the charge↔refund race under READ COMMITTED isolation. | Application sequencing reduces this race; SQL-level lock removes it entirely for OSS adopters. |

These additions never change the customer-facing economic invariant. They make the SQL surface safe for adopters who call the functions directly without BabySea's pre-validation layers.

## Explicitly not included

These flows are not present in BabySea's current credit implementation and are intentionally not part of this OSS package:

| Excluded flow | Reason |
|---|---|
| Variable-cost terminal reconciliation | BabySea computes generation cost before reserve from model, duration, resolution, and audio-mode inputs, then confirms or refunds that amount. |
| Automatic Stripe refund/dispute credit deductions | BabySea does not automatically convert Stripe refunds or disputes into credit ledger deductions today. |
| Debt/shortfall ledger entries | No BabySea credit table or SDK type tracks credit debt/shortfall. The ledger balance remains non-negative and only uses `reserve`, `charge`, `refund`, and `add`. |
| Stripe refund/dispute webhook handlers | The production billing webhook route only allocates credits from subscription invoices and checkout sessions. |

## Non-goals

- No BabySea internal provider routing logic is included.
- No BabySea account, subscription, file asset, notification, email, or webhook delivery tables are required.
- No hosted BabySea secrets, plan IDs, customer IDs, or deployment-specific configuration are included.
- No generic payment abstraction is provided; the implemented public contract is Stripe + Supabase.
- No application authorization policy is assumed beyond the account ID passed by the adopter's backend.

The invariant is intentionally small: Stripe records paid invoices and checkout sessions, Supabase owns credit balance and ledger transitions, and the adopter's backend maps its account and generation model into those functions.
