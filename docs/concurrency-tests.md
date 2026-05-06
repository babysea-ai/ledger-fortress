# Concurrency and SQL invariant tests

`ledger-fortress` exposes two database-level verification paths. Both require a
disposable Postgres/Supabase database with the migrations applied.

## PgTAP invariants

The PgTAP suite checks core ledger invariants in one transaction and rolls back
at the end:

```bash
psql "$DATABASE_URL" < migrations/001_credits.sql
psql "$DATABASE_URL" < migrations/002_credit_alerts.sql
psql "$DATABASE_URL" < migrations/003_security.sql
psql "$DATABASE_URL" -f test/invariants.pgtap.sql
```

It verifies:

- initial grants set balance;
- reserve deducts exactly once;
- duplicate reserve with the same amount is idempotent;
- duplicate reserve with a different amount raises an idempotency conflict;
- charge requires a matching reserve and is idempotent;
- refund after charge is blocked;
- duplicate refund is a no-op.

## Parallel reserve race

The TypeScript concurrency simulation launches many parallel reserves against a
small balance and verifies the final balance and ledger count:

```bash
cd client/typescript
DATABASE_URL='postgresql://...' \
LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1 \
npm run test:db:concurrency
```

Default scenario:

- `100` parallel reserve attempts;
- `10` starting credits;
- `1` credit per reserve;
- exactly `10` reserves should succeed;
- balance should reach `0` after the race;
- crash-recovery style refunds should restore the balance to `10`.

Set `LEDGER_FORTRESS_RACE_KEEP=1` only when you want to inspect rows manually.
The harness generates a fresh random account and refuses to run until you set
`LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1`.
