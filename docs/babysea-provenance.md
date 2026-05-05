# BabySea provenance and OSS scope

`ledger-fortress` is grounded in BabySea's real Stripe + Supabase credit implementation. The OSS package keeps the same public ledger lifecycle and replaces BabySea-specific account, generation, and dashboard tables with adopter-supplied IDs.

The grounding was validated against BabySea's internal production implementation:

- Credit schema (plans, credits, credit_ledger, `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, and ledger idempotency indexes).
- Credit alert schema (low-balance alert settings and fired-threshold deduplication).
- Credit service module (request-time reserve, charge confirmation, refund, and alert reset/check calls).
- Billing webhook handler (Stripe `invoice.paid` and `checkout.session.completed` reconciliation into `add_credits` with `invoice:*` and `order:*` idempotency keys).
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
