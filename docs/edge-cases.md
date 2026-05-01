# The Seven Edge Cases

Every async credit system must survive these scenarios. `ledger-fortress` handles all of them at the SQL level.

## 1. TOCTOU Race (Two clicks, 50ms apart)

**Scenario:** User clicks "Generate" twice in rapid succession. Both requests check the balance, both see $10, both deduct $5. Final balance: $0 instead of $5. Overdraw.

**The naive approach:**
```sql
-- Request A                       -- Request B
SELECT tokens FROM credits;        SELECT tokens FROM credits;
-- tokens = 10                     -- tokens = 10 (not yet updated)
UPDATE credits SET tokens = 5;     UPDATE credits SET tokens = 5;
-- Both succeed. Balance should be 0 but user only paid for one.
```

**The fortress approach:**
```sql
-- Single atomic statement. No separate SELECT.
UPDATE credits
SET tokens = tokens - 5
WHERE account_id = $1
  AND tokens >= 5                  -- atomic guard
RETURNING tokens;
```

Request A runs the UPDATE, balance goes from 10 to 5. Request B runs the same UPDATE but now `tokens >= 5` is still true (5 >= 5), so it also succeeds. Balance: 0. If Request B asked for 6, `tokens >= 6` would be false (5 < 6), zero rows updated, reservation fails. No overdraw.

## 2. Provider Ghost (No webhook ever arrives)

**Scenario:** You reserve credits and dispatch to a provider. The provider crashes, goes offline, or silently drops your request. No success webhook. No failure webhook. Credits locked forever.

**Defense:** Crash recovery cron runs every 5 minutes:
```sql
SELECT * FROM find_orphaned_reservations(5, 100);
```
Finds reservations older than 5 minutes with no matching charge, refund, or true-up settlement. Refunds them automatically.

## 3. Duplicate Success Webhook

**Scenario:** Stripe retries a webhook. Your provider sends two identical success callbacks. Handler runs `charge_credits` twice.

**Defense:** Unique partial index:
```sql
CREATE UNIQUE INDEX idx_credit_ledger_charge_idempotent
  ON credit_ledger (generation_id) WHERE type = 'charge';
```

Second INSERT hits `unique_violation`. The function catches it and returns FALSE (no-op).

## 4. Duplicate Failure Webhook

**Scenario:** Same as #3, but for failure. Two refund attempts for the same generation.

**Defense:** Unique partial index:
```sql
CREATE UNIQUE INDEX idx_credit_ledger_refund_idempotent
  ON credit_ledger (generation_id) WHERE type = 'refund';
```

Second refund is a no-op. Credits returned exactly once.

## 5. Charge Arrives After Refund (Out-of-order webhooks)

**Scenario:** Provider sends two webhooks: first a "failed" (causing refund), then corrects to "succeeded" (causing charge). Or: crash recovery refunds, then the real success webhook arrives late.

With the charge being log-only (no balance change), the user's credits were already returned by the refund. The charge would silently confirm a generation that got free credits.

**Defense:** `charge_credits_detailed` checks for an existing refund under the account lock. If found, it re-deducts the reserved amount before logging success. If the balance cannot fully cover the late correction, it deducts what is available, logs the successful generation, writes an `uncollectible` shortfall (`charge_after_refund_shortfall:<generation_id>`), and returns `status = 'shortfall'` so the application can pause the account or route the case to manual review. The boolean `charge_credits` wrapper remains available for old callers, but new integrations should use the detailed status when late callbacks are possible. If the generation was already settled through `settle_credits`, `charge_credits_detailed` returns `already_settled`.

## 6. Refund Arrives After Charge (The deadly sequence)

**Scenario:** 
1. `reserve_credits` ➜ balance deducted
2. Success webhook ➜ `charge_credits` (log-only confirmation)
3. Your handler crashes and restarts
4. Crash recovery finds the reservation, calls `refund_credits`
5. Credits returned ➜ user got a free generation

This is the most dangerous edge case. The user's generation succeeded (they have the output), but their credits were refunded.

**Defense:** `refund_credits` has terminal-state guards:
```sql
IF EXISTS (
  SELECT 1 FROM credit_ledger
  WHERE generation_id = p_generation_id
    AND type IN ('charge', 'trueup')
) THEN
  RETURN FALSE;
END IF;
```

The refund is blocked after charge or true-up settlement. Credits stay deducted. User pays for what they received.

## 7. Settlement Without Reservation (App bug)

**Scenario:** A buggy handler calls `charge_credits`, `refund_credits`, or `settle_credits` for a `generation_id` that was never reserved.

Without a reserve guard, a refund or true-down could mint credits, and a charge could mark unpaid output as settled.

**Defense:** Every terminal settlement path checks for a matching `reserve` row for the same `account_id` and `generation_id`. If no reservation exists, the function returns `FALSE` and leaves the balance unchanged.
