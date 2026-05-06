# Concurrency simulation

This demo proves the reserve invariant against a real PostgreSQL database:

- start with a known credit balance;
- launch many parallel `reserve_credits(...)` calls;
- verify only the affordable reserves succeed;
- verify the ledger row count matches successful reserves;
- run crash-recovery style refunds for orphaned reservations;
- verify the balance returns to the initial value.

It creates a random account by default and removes its rows before exit.

## Prerequisites

Apply the migrations to a disposable database first:

```bash
psql "$DATABASE_URL" < migrations/001_credits.sql
psql "$DATABASE_URL" < migrations/002_credit_alerts.sql
psql "$DATABASE_URL" < migrations/003_security.sql
```

## Run

```bash
cd client/typescript
DATABASE_URL='postgresql://...' \
LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1 \
npm run test:db:concurrency
```

Optional knobs:

```bash
export LEDGER_FORTRESS_RACE_ATTEMPTS=100
export LEDGER_FORTRESS_RACE_BALANCE=10
export LEDGER_FORTRESS_RACE_AMOUNT=1
export LEDGER_FORTRESS_RACE_KEEP=1 # keep rows for inspection
```

The script always generates a fresh random account id. It refuses to run unless
`LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1` is set, and cleanup only removes
ledger rows whose `generation_id` uses the generated `race_*` prefix.
