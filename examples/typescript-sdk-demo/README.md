# TypeScript SDK Demo

Demonstrates the full credit lifecycle: reserve → generate → settle.

## Prerequisites

- Node.js 18+
- PostgreSQL (local or remote)
- ledger-fortress migrations applied

## Run

```bash
# Apply migrations to your database
psql "$DATABASE_URL" < ../../migrations/001_credits.sql
psql "$DATABASE_URL" < ../../migrations/002_credit_alerts.sql

# Install and run
npm install
npx tsx demo.ts
```

## What it does

1. Adds $10 credits to a test account (idempotent)
2. Reserves $0.062 for a FLUX Schnell generation
3. Simulates an async generation (2 second delay)
4. Charges (confirms) the reservation on success
5. Shows the full ledger history
6. Runs crash recovery to find any orphaned reservations
