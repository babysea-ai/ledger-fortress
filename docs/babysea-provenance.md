# BabySea provenance and OSS scope

`ledger-fortress` is inspired by BabySea's production credit system. The OSS package keeps the same core invariants and generalizes the integration points so other teams can use their own Stripe account, Supabase/Postgres database, account table, generation table, and webhook stack.

The grounding was checked against BabySea's implementation paths:

- `apps/web/supabase/schemas/21-credits.sql` for `plans`, `credits`, `credit_ledger`, `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, and ledger idempotency indexes.
- `apps/web/supabase/schemas/34-credit-alerts.sql` for the low-balance alert state machine.
- `apps/web/lib/inference-hub/credit/service.ts` for request-time reserve, charge confirmation, refund, and alert reset/check calls.
- `apps/web/app/api/billing/webhook/route.ts` for Stripe invoice/checkout reconciliation into `add_credits` with `invoice:*` and `order:*` idempotency keys.
- `apps/web/app/home/[account]/billing/_lib/server/team-billing.service.ts` for the server-side credit-pack active-subscription guard.

## Directly mirrored from BabySea

These pieces map to BabySea's current production approach:

| Area | BabySea pattern | OSS surface |
|---|---|---|
| Atomic reserve | One `UPDATE credits SET tokens = tokens - cost WHERE tokens >= cost` before dispatching generation work | `reserve_credits()`/`fortress.reserve()` |
| Charge confirmation | Success callbacks write a log-only charge because reserve already deducted the balance | `charge_credits()`/`fortress.charge()` |
| Failure refund | Failure, cancellation, and cleanup paths refund only if the generation was not already charged or refunded | `refund_credits()`/`fortress.refund()` |
| Additive Stripe grants | Subscription invoices and credit packs add to the current balance; renewal never resets credit packs | `add_credits()`/`fortress.addCredits()` |
| Idempotency | Database unique indexes, not in-memory handler state | partial indexes on ledger rows |
| Crash recovery | A scheduled cleanup finds stale pending generations and refunds reserved credits safely | `find_orphaned_reservations()`/`fortress.recoverOrphans()` |
| Low-balance alerts | Threshold state machine: fire once per descent, re-arm after top-up/refund | `check_credit_alerts()` and `reset_credit_alerts()` |
| Stale checkout guard | Credit pack redemption is guarded at webhook time, not only checkout creation time | `hasActiveSubscription` callback |
| Security boundary | Credit tables are backend-owned financial state, not client-writable cache | BabySea uses Supabase RLS and service-role mutations; OSS hardens further by revoking client table grants and locking mutating functions with `SECURITY DEFINER` and `search_path` |

## Generalized for the OSS package

These pieces are included because they are natural extensions of the same ledger model for community Stripe + Supabase/Postgres deployments:

| Area | Why it exists in OSS |
|---|---|
| `settle_credits()` | Some generation stacks reserve a maximum estimate and only know actual cost after the provider returns. BabySea's current model pricing is mostly fixed before dispatch, but the same reserve-first ledger can support variable-cost settlement. |
| `clawback_credits()` | Stripe refunds and disputes can arrive after credits are spent. The OSS package includes a reusable accounting path for teams that need refund/dispute reconciliation. |
| `uncollectible` ledger entries | If a refund, dispute, or true-up cannot be fully recovered from the current balance, the shortfall is explicit and auditable instead of making the balance negative. |
| Python parity | BabySea's app is TypeScript, but community adopters often run Python workers. The Python SDK wraps the same SQL functions rather than introducing a second implementation. |

## Non-goals

- No BabySea internal provider routing logic is included.
- No BabySea account, subscription, file asset, notification, email, or webhook delivery tables are required.
- No hosted BabySea secrets, plan IDs, customer IDs, or deployment-specific configuration are included.
- No application authorization policy is assumed beyond the account ID passed by the adopter's backend.

The invariant is intentionally small: Stripe moves money, Supabase/Postgres owns credit balance and ledger transitions, and the adopter's application maps its account and generation model into those functions.
