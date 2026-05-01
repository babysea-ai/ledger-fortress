# Python SDK Demo

Demonstrates the full credit lifecycle: reserve ➜ generate ➜ charge or refund.

## Prerequisites

- Python 3.10+
- PostgreSQL (local or remote)
- ledger-fortress migrations applied

## Run

```bash
# Apply migrations to your database
psql "$DATABASE_URL" < ../../migrations/001_credits.sql
psql "$DATABASE_URL" < ../../migrations/002_credit_alerts.sql

# Install and run
pip install -e ../../client/python
DATABASE_URL="$DATABASE_URL" python demo.py
```

## What it does

1. Adds $10 credits to a test account with an idempotency key
2. Reserves $0.062 for a demo generation
3. Simulates a 2-second async generation
4. Charges on success or refunds on failure
5. Prints recent ledger history
6. Runs crash recovery to verify orphan scanning still no-ops safely
