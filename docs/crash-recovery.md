# Why Crash Recovery Matters

The crash recovery system in `ledger-fortress` solves the most insidious edge case in async billing: **the ghost reservation**.

## The problem

```
Time    Your App                    Provider                 Ledger
────    ────────                    ────────                 ──────
0ms     reserve_credits($0.062)                             balance: $9.938
10ms    dispatch to provider ──────►
50ms    handler crashes/restarts           
...                                 processing...
3000ms                              generation complete
3010ms                              webhook ➜ your app
3020ms  ???  (handler doesn't know              
        about this generation)
```

The reservation is in the ledger. Nobody will ever charge or refund it. The user's $0.062 is locked forever.

Multiply this by hundreds of generations per day, and you have a slow leak that erodes user trust.

## The solution

`find_orphaned_reservations` is a SQL function that finds reservations with no matching settlement:

```sql
SELECT * FROM find_orphaned_reservations(
  5,    -- window_minutes: only look at reservations older than 5 min
  100   -- limit: process at most 100 per cycle
);
```

It returns reservations where:

- `type = 'reserve'`
- `generation_id IS NOT NULL`
- `created_at < NOW() - 5 minutes`
- No row exists with the same `generation_id` and `type IN ('charge', 'refund')`

## Why 5 minutes?

The window must be longer than the longest possible generation time. For most AI workloads:

| Workload | Typical latency | Max latency |
|---|---|---|
| Image generation | 2-10s | 30s |
| Video generation (5s) | 30-60s | 120s |
| Video generation (10s) | 60-120s | 300s |

A 5-minute window covers most workloads. For longer video models, increase to 10 or 15 minutes.

## Idempotency safety

Crash recovery calls `refund_credits()` for each orphan. This function has two guards:

1. **If already charged ➜ no-op.** If the provider's success webhook arrived while crash recovery was processing, the charge wins. No double-credit.
2. **If already refunded ➜ no-op.** If the provider's failure webhook arrived, the refund already happened. No double-refund.

This means crash recovery is safe to run at any frequency. It can overlap with webhooks. It can run twice for the same orphan. The guards ensure correctness.

## Running it

### As a cron job (recommended)

```typescript
// Run every 5 minutes via your cron scheduler
const result = await fortress.recoverOrphans({
  windowMinutes: 5,
  limit: 100,
  onRecovered: async (generationId, accountId) => {
    // Mark generation as failed in your app
    await db.generations.update({
      where: { id: generationId },
      data: { status: 'failed', error: 'TIMEOUT' },
    });
    // Optionally notify the user
    await notifyUser(accountId, `Generation ${generationId} timed out. Credits refunded.`);
  },
});
```

### Monitoring

Track these metrics:

- `inspected`: number of orphans found - should be low and stable
- `refunded`: number of orphans successfully refunded - spikes indicate provider issues
- `errors`: number of refund failures - should be zero
