# Architecture

`ledger-fortress` is an atomic credit settlement engine for async AI workloads.

## The problem

Every AI generation platform (Midjourney, RunwayML, Pika, Leonardo, your app) runs the same sequence:

1. User clicks "Generate"
2. Reserve credits (must be atomic - no overdraw)
3. Dispatch to an inference provider (takes 2-120 seconds)
4. Wait for async webhook
5. On success: confirm the charge
6. On failure: refund the credits

The gap between step 2 and step 5 is where the edge cases live. Every team hand-rolls this in their app, gets 4 of the 6 edge cases right, and discovers the other 2 in production at 3am.

## Design principles

### 1. Atomic at the SQL level

Every credit mutation is a single SQL statement. No application-level locks, no
distributed transactions, no "check then update" patterns.

```sql
-- reserve_credits: atomic check-and-deduct
UPDATE credits
SET tokens = tokens - p_tokens
WHERE account_id = p_account_id
  AND tokens >= p_tokens          -- WHERE guard = atomic check
RETURNING tokens;
```

If two requests hit this concurrently, PostgreSQL serializes them. The first one
succeeds; the second one sees the updated balance and fails if insufficient. No TOCTOU.

### 2. Idempotent at the index level

Every settlement operation is protected by a unique partial index:

```sql
-- One charge per generation
CREATE UNIQUE INDEX idx_credit_ledger_charge_idempotent
  ON credit_ledger (generation_id) WHERE type = 'charge';

-- One refund per generation
CREATE UNIQUE INDEX idx_credit_ledger_refund_idempotent
  ON credit_ledger (generation_id) WHERE type = 'refund';

-- One add per (account, description)
CREATE UNIQUE INDEX idx_credit_ledger_add_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'add';
```

Duplicate webhooks, network retries, crash recovery re-runs - all produce a `unique_violation` that the function catches and converts to a no-op return.

### 3. Additive grants (rollover, never reset)

When a subscription renews, credits are _added_ to the existing balance. They never reset. This prevents the deadly scenario:

1. User buys a $10 credit pack
2. Subscription renews
3. Balance "resets" to $29 (subscription amount)
4. User's $10 credit pack vanishes

`add_credits` uses `INSERT ... ON CONFLICT DO UPDATE SET tokens = tokens + p_tokens`.

### 4. Guards against state machine violations

The three-phase lifecycle has exactly two valid terminal states:

```
reserved → charged    (success)
reserved → refunded   (failure)
```

Two invalid transitions must be prevented:

- `charged → refunded` (would give free output)
- `refunded → charged` (would confirm a returned reservation)

Both are blocked by explicit guard queries in the SQL functions.

## Data model

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│   credits    │     │  credit_ledger  │     │    plans     │
│              │     │                 │     │              │
│ account_id ──┼──┐  │ account_id      │     │ variant_id   │
│ tokens       │  │  │ type            │     │ tokens       │
│ updated_at   │  │  │ amount          │     │ name         │
│              │  │  │ balance_after   │     │              │
│ CHECK≥0      │  │  │ generation_id   │     └──────────────┘
└──────────────┘  │  │ model           │
                  │  │ description     │
                  │  │ created_at      │
                  │  │                 │
                  │  │ UNIQUE PARTIAL  │
                  └──┤ INDEXES for     │
                     │ idempotency     │
                     └─────────────────┘
```

## Edge case matrix

| # | Edge case | Attack vector | Defense |
|---|---|---|---|
| 1 | TOCTOU race | Two clicks 50ms apart both read balance=10 | `UPDATE ... WHERE tokens >= cost` (no separate SELECT) |
| 2 | Provider ghost | No webhook arrives, credits locked | `find_orphaned_reservations` cron |
| 3 | Duplicate charge | Stripe retries success webhook | Unique partial index on `(generation_id) WHERE type='charge'` |
| 4 | Duplicate refund | Retry/crash recovery both refund | Unique partial index on `(generation_id) WHERE type='refund'` |
| 5 | Charge after refund | Out-of-order webhooks | `charge_credits` checks for existing refund |
| 6 | Refund after charge | Crash recovery runs after success | `refund_credits` checks for existing charge |
