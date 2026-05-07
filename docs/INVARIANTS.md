# ledger-fortress invariants

This file maps the credit-ledger promises to the database mechanisms that enforce them. It is proof-oriented documentation, not a replacement for SQL tests.

## Core invariants

| Invariant | Mechanism | Where to verify |
|---|---|---|
| Balance is never negative. | `credits.tokens CHECK (tokens >= 0)` plus `reserve_credits()` atomic `UPDATE ... WHERE tokens >= amount`. | `migrations/001_credits.sql` |
| A reserve deducts at most once per generation. | `idx_credit_ledger_reserve_idempotent` unique partial index and idempotent retry branch in `reserve_credits()`. | `migrations/001_credits.sql` |
| A successful reserve deducts exactly the reserved amount. | `lf_validate_credit_amount()` rejects invalid precision; `reserve_credits()` records the same amount in `credit_ledger`. | `migrations/001_credits.sql` |
| A duplicate reserve response is safe. | Existing reserve lookup returns success for the same account/amount and rejects amount conflicts. | `reserve_credits()` |
| A charge requires a matching reserve. | `charge_credits()` returns `FALSE` when no `reserve` row exists for `(account_id, generation_id)`. | `charge_credits()` |
| A charge after a refund re-collects if possible. | `charge_credits()` locks the account row, detects prior refund, and re-deducts before inserting `charge`. | `charge_credits()` |
| A duplicate charge does not double-deduct. | `idx_credit_ledger_charge_idempotent` unique partial index and fast-path existing charge check. | `migrations/001_credits.sql` |
| A refund requires a matching reserve. | `refund_credits()` returns `FALSE` when no reserve exists. | `refund_credits()` |
| A refund after charge does not return credits. | `refund_credits()` checks for existing `charge` and no-ops. | `refund_credits()` |
| A duplicate refund restores credits at most once. | `idx_credit_ledger_refund_idempotent` unique partial index and unique-violation rollback. | `refund_credits()` |
| Stripe invoice retries do not double-grant credits. | `idx_credit_ledger_add_idempotent` on `(account_id, description) WHERE type = 'add'`. | `add_credits()` |
| Stripe checkout retries do not double-grant credits. | Checkout idempotency keys use the Stripe payment intent when present, otherwise the checkout session identifier, in `description`. | `client/typescript/src/stripe.ts` |
| Grants are additive, never resets. | `add_credits()` uses `ON CONFLICT DO UPDATE SET tokens = credits.tokens + p_tokens`. | `add_credits()` |
| Client roles cannot mutate ledger tables directly. | `003_security.sql` enables RLS and revokes anon/authenticated direct table access. | `migrations/003_security.sql` |
| Mutating functions run through a hardened boundary. | Security migration marks functions `SECURITY DEFINER` and locks `search_path`. | `migrations/003_security.sql` |
| Crash recovery cannot double-refund. | `find_orphaned_reservations()` only returns reservations without terminal rows; `refund_credits()` remains idempotent. | `migrations/001_credits.sql` |
| Low-balance alerts are deduplicated by threshold. | Alert log state records crossed thresholds and resets only after balance recovery. | `migrations/002_credit_alerts.sql` |

## State machine

```text
reserve_credits()
  │ balance deducted once
  ▼
reserved
  ├─ charge_credits()  ──► charged
  ├─ refund_credits()  ──► refunded
  └─ recoverOrphans()  ──► refunded
```

Terminal events require the original reservation amount. Amount mismatches raise instead of silently adjusting balances.

## Test cases to keep green

- 100 parallel reserves against a balance that can fund only a subset.
- Duplicate `reserve_credits()` with the same generation id and same amount.
- Duplicate `reserve_credits()` with the same generation id and different amount.
- `charge_credits()` without a reserve.
- `refund_credits()` without a reserve.
- `reserve ➜ refund ➜ charge` with enough balance to re-collect.
- `reserve ➜ charge ➜ refund` no-op.
- Duplicate Stripe `invoice.paid` webhook.
- Duplicate Stripe checkout completion webhook.
- Crash recovery re-run after the first orphan refund.

## Deliberate non-invariants

`ledger-fortress` does not promise automatic credit clawback for Stripe refunds, disputes, chargebacks, or uncollectible invoices. Those payment workflows require product-specific policy and support handling outside this package.
