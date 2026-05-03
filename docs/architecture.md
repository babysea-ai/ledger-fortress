# Architecture

This document explains the Stripe + Supabase/Postgres settlement loops, the storage layout, and the SQL guarantees. For the full edge-case walkthrough, see [`edge-cases.md`](edge-cases.md). For Stripe webhook specifics, see [`stripe-integration.md`](stripe-integration.md). For orphan recovery, see [`crash-recovery.md`](crash-recovery.md).

## Stack boundary

| Boundary | Owner | Rule |
|---|---|---|
| Payment facts | Stripe | Stripe is the external source of invoices, checkout sessions, refunds, disputes, and webhook retries. |
| Credit invariants | Supabase/Postgres | Supabase/Postgres owns `credits`, `credit_ledger`, non-negative balance constraints, idempotency indexes, and RLS. |
| Application coordination | Your backend | The app maps Stripe customers and generation IDs to account IDs, then calls fortress functions. |
| Client access | Supabase anon/authenticated roles | Client roles must not write ledger tables. The default migration revokes table/function access from them. |

## The two loops

`ledger-fortress` is two loops glued together by the ledger.

### 1. The request loop (hot path, synchronous)

```
your app  ➜  reserve(account, generation, amount)  ➜  provider
         ←  charge(...)/refund(...)/settle(...) ←  webhook/callback
```

- `reserve_credits` is a single atomic balance check and deduction.
- The async workload starts only after the reservation succeeds.
- Success, failure, or true-up is recorded later as a ledger event, not a second balance check.

### 2. The reconciliation loop (async, idempotent)

```
Stripe webhooks/provider webhooks/crash recovery cron
    ➜ add_credits/charge_credits/refund_credits/settle_credits/clawback_credits
    ➜ credit_ledger + credits balance
```

- Stripe grants recurring or one-time credits.
- Provider callbacks settle the reserved generation.
- Crash recovery refunds orphaned reservations after the safety window.
- Every path is replay-safe at the SQL layer, so retries are harmless.

## Storage layout

| Table | Grain | Purpose |
|---|---|---|
| `plans` | one row per Stripe price | Maps price IDs to credit grants |
| `credits` | one row per account | Current spendable balance with `CHECK (tokens >= 0)` |
| `credit_ledger` | immutable event log | Reserve/charge/refund/trueup/add/clawback/uncollectible entries |
| `credit_alert_settings` | one row per account | Threshold and channel configuration |
| `credit_alert_log` | one row per threshold crossing | Deduplicates low-balance alerts |

## The guarantees

### 1. Atomic balance changes

Every balance mutation is one SQL statement. No application lock, no distributed transaction, and no separate "check then update" round-trip.

```sql
-- reserve_credits: atomic check-and-deduct
UPDATE credits
SET tokens = tokens - p_tokens
WHERE account_id = p_account_id
  AND tokens >= p_tokens
RETURNING tokens;
```

If two requests race, PostgreSQL serializes the updates. The second request sees the new balance and fails cleanly if there is not enough left.

### 2. Exactly-once settlement

Settlement paths are protected by unique partial indexes:

```sql
CREATE UNIQUE INDEX idx_credit_ledger_charge_idempotent
  ON credit_ledger (generation_id) WHERE type = 'charge';

CREATE UNIQUE INDEX idx_credit_ledger_refund_idempotent
  ON credit_ledger (generation_id) WHERE type = 'refund';

CREATE UNIQUE INDEX idx_credit_ledger_add_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'add';

CREATE UNIQUE INDEX idx_credit_ledger_clawback_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'clawback';

CREATE UNIQUE INDEX idx_credit_ledger_trueup_idempotent
  ON credit_ledger (generation_id) WHERE type = 'trueup';
```

Duplicate webhooks, network retries, and crash-recovery re-runs collapse into a no-op.

### 3. Additive grants and bounded clawbacks

- `add_credits` increments the balance; it never resets it.
- `clawback_credits` floors the balance at zero and records any gap as `uncollectible`.
- Subscription renewals and credit packs compose cleanly instead of overwriting each other.

### 4. Guarded state transitions

The valid terminal states are:

```
reserved ➜ charged
reserved ➜ refunded
reserved ➜ settled
```

- `refund_credits` no-ops if the generation is already charged or settled via true-up.
- `charge_credits` re-checks prior refund state under lock and no-ops after true-up settlement.
- `settle_credits` serializes the true-up path for that generation, can reconcile from a prior refund, and can emit `trueup` and `uncollectible` entries when the actual cost differs from the reservation.
- `charge_credits`, `refund_credits`, and `settle_credits` require a matching `reserve` row for the same account and generation.
- `FOR UPDATE` serialization prevents conflicting outcomes for the same generation.

## Fail-open ladder

| Failure | Behavior |
|---|---|
| Stripe delayed | Reserved credits already gate generation; reconciliation happens later |
| Provider callback delayed | Reservation remains in place until charge, refund, true-up, or crash recovery resolves it |
| Crash recovery misses a cycle | The orphan waits for the next run; no balance corruption occurs |
| Alert delivery fails | Alert checks are fire-and-forget and retried on later reservations |
| Duplicate webhook or retry | Unique partial indexes convert the replay into a no-op |

## Deployment boundary

- Supabase/Postgres is the source of truth for balance and ledger state.
- Run migrations over a direct/session connection; run runtime traffic through a transaction-mode Supabase pooler when using Supabase-hosted Postgres.
- Webhooks, cron, and application servers can fail independently because settlement is replay-safe.
- The application decides when to start work; PostgreSQL decides whether the account can afford it.

## Real-stack validation

The non-destructive smoke harness in [`../examples/real-stack-smoke/`](../examples/real-stack-smoke/) validates this boundary against real Stripe test-mode API credentials and a real Supabase/Postgres project by creating a disposable schema, applying migrations there, exercising the state machine, and dropping the schema by default.
