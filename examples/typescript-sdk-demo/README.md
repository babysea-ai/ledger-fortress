# TypeScript SDK Demo

Demonstrates the full credit lifecycle: reserve ➜ generate ➜ charge or refund.

## Prerequisites

- Node.js 18+
- PostgreSQL (local or remote)
- ledger-fortress migrations applied

## Run

```bash
# Apply migrations to your database
psql "$DATABASE_URL" < ../../migrations/001_credits.sql
psql "$DATABASE_URL" < ../../migrations/002_credit_alerts.sql

# Build the local SDK once
cd ../../client/typescript
npm install
npm run build

# Install and run the demo
cd ../../examples/typescript-sdk-demo
npm install
DATABASE_URL="$DATABASE_URL" npm run demo
```

## What it does

1. Adds $10 credits to a test account (idempotent)
2. Reserves $0.062 for a FLUX Schnell generation
3. Simulates an async generation (2 second delay)
4. Charges the reservation on success or refunds it on failure
5. Shows the full ledger history
6. Runs crash recovery to find any orphaned reservations
7. Checks the account's low-balance alert state
