# Architecture

This document explains the Stripe + Supabase credit loops, the storage layout, and the SQL guarantees. For the full edge-case walkthrough, see [`edge-cases.md`](edge-cases.md). For Stripe webhook specifics, see [`stripe-integration.md`](stripe-integration.md). For orphan recovery, see [`crash-recovery.md`](crash-recovery.md).

## Stack boundary

| Boundary | Owner | Rule |
|---|---|---|
| Payment facts | Stripe | Stripe is the external source of paid invoices, completed checkout sessions, and webhook retries. |
| Credit invariants | Supabase | Supabase owns `credits`, `credit_ledger`, non-negative balance constraints, idempotency indexes, and RLS. |
| Application coordination | Your backend | The app maps Stripe customers and generation IDs to account IDs, then calls fortress functions. |
| Client access | Supabase anon/authenticated roles | Client roles must not write ledger tables. The default migration revokes table/function access from them. |

## The two loops

`ledger-fortress` is two loops glued together by the ledger.

### 1. The request loop (hot path, synchronous)

```
your app  ➜  reserve(account, generation, amount)  ➜  provider
         ←  charge(...)/refund(...)              ←  webhook/callback
```

- `reserve_credits` is a single atomic balance check and deduction.
- The async workload starts only after the reservation succeeds.
- Success or failure is recorded later as a ledger event, not a second balance check.

### 2. The reconciliation loop (async, idempotent)

```
Stripe webhooks/provider webhooks/crash recovery cron
  ➜ add_credits/charge_credits/refund_credits
    ➜ credit_ledger + credits balance
```

- Stripe grants recurring subscription or one-time checkout credits.
- Provider callbacks confirm or refund the reserved generation.
- Crash recovery refunds orphaned reservations after the safety window.
- Every path is replay-safe at the SQL layer, so retries are harmless.

## Storage layout

| Table | Grain | Purpose |
|---|---|---|
| `plans` | one row per Stripe price | Maps price IDs to credit grants |
| `credits` | one row per account | Current spendable balance with `CHECK (tokens >= 0)` |
| `credit_ledger` | immutable event log | Reserve/charge/refund/add entries |
| `credit_alert_settings` | one row per account | Threshold and channel configuration |
| `credit_alert_log` | one row per threshold crossing | Deduplicates low-balance alerts |

The `plans` table mirrors BabySea's Stripe Price ID mapping. The OSS `get_plan_credits()` helper is a portability wrapper around that table; the default Stripe grant path still follows BabySea's current amount-paid behavior.

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

If two requests race, PostgreSQL, as Supabase's SQL engine, serializes the row updates. The second request sees the new balance and fails cleanly if there is not enough left.

### 2. Exactly-once terminal events

Terminal paths are protected by unique partial indexes:

```sql
CREATE UNIQUE INDEX idx_credit_ledger_charge_idempotent
  ON credit_ledger (generation_id) WHERE type = 'charge';

CREATE UNIQUE INDEX idx_credit_ledger_refund_idempotent
  ON credit_ledger (generation_id) WHERE type = 'refund';

CREATE UNIQUE INDEX idx_credit_ledger_add_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'add';
```

Duplicate webhooks, network retries, and crash-recovery re-runs collapse into a no-op.

### 3. Additive Stripe grants

- `add_credits` increments the balance; it never resets it.
- Subscription renewals and credit packs compose cleanly instead of overwriting each other.

### 4. Guarded state transitions

The valid terminal states are:

```
reserved ➜ charged
reserved ➜ refunded
```

- `refund_credits` no-ops if the generation is already charged.
- `charge_credits` re-checks prior refund state under lock; if a refund already returned the reservation, it re-deducts the reserved amount before logging charge, or returns `FALSE` if it cannot safely collect.
- `charge_credits` and `refund_credits` require a matching `reserve` row for the same account and generation.
- `FOR UPDATE` serialization prevents conflicting outcomes for the same generation.

## Fail-open ladder

| Failure | Behavior |
|---|---|
| Stripe delayed | Reserved credits already gate generation; reconciliation happens later |
| Provider callback delayed | Reservation remains in place until charge, refund, or crash recovery resolves it |
| Crash recovery misses a cycle | The orphan waits for the next run; no balance corruption occurs |
| Alert delivery fails | Alert checks are fire-and-forget and retried on later reservations |
| Duplicate webhook or retry | Unique partial indexes convert the replay into a no-op |

## Deployment boundary

- Supabase is the source of truth for balance and ledger state.
- Run migrations over a direct/session connection; run runtime traffic through a transaction-mode Supabase pooler.
- Webhooks, cron, and application servers can fail independently because ledger transitions are replay-safe.
- The application decides when to start work; the Supabase-hosted PostgreSQL transaction decides whether the account can afford it.

## Real-stack validation

The non-destructive smoke harness in [`../examples/real-stack-smoke/`](../examples/real-stack-smoke/) validates this boundary against real Stripe test-mode API credentials and a real Supabase project by creating a disposable schema, applying migrations there, exercising the state machine, and dropping the schema by default.
