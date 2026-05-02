# ledger-fortress real-stack smoke

This smoke test validates `ledger-fortress` against real **Stripe + Supabase/Postgres** services without mutating your production ledger tables.

It is intentionally narrower than the destructive E2E simulation in `client/typescript/test/e2e-simulation.ts`:

- Creates one disposable Stripe test customer and deletes it in cleanup.
- Creates one disposable Supabase/Postgres schema named `ledger_fortress_smoke_<run_id>`.
- Applies the OSS migrations inside that disposable schema with the function `search_path` locked to that schema.
- Exercises additive Stripe-style grants, reserve, charge, refund, late-charge shortfall, true-up, clawback, alerts, and RLS/grant posture.
- Drops the disposable schema by default.

## Required environment

Use a Stripe **test-mode** restricted key. Live keys are always refused by this smoke harness.

```bash
export STRIPE_SECRET_KEY="rk_test_..."      # or STRIPE_SECRET

# Option A: full Supabase/Postgres URL
export SUPABASE_DATABASE_URL="postgresql://...?...sslmode=require"

# Option B: build the Supabase pooler URL from project settings
export SUPABASE_PROJECT_ID="<project-ref>"
export SUPABASE_DB_PASSWORD="..."
export SUPABASE_POOLER_HOST="aws-1-us-east-1.pooler.supabase.com" # optional default
export SUPABASE_POOLER_PORT="5432"                                # optional session-pooler default
```

Optional:

```bash
export LEDGER_FORTRESS_SMOKE_RESULT="/tmp/ledger-fortress-smoke.json"
export LEDGER_FORTRESS_SMOKE_KEEP_SCHEMA=1      # keep disposable schema for inspection
```

## Run

```bash
python -m venv /tmp/ledger-fortress-smoke-venv
/tmp/ledger-fortress-smoke-venv/bin/pip install "psycopg[binary]>=3.2"
/tmp/ledger-fortress-smoke-venv/bin/python examples/real-stack-smoke/validate.py
```

The script prints only sanitized identifiers and never prints secret values.

## What it proves

- The migrations load on Supabase/Postgres in a disposable schema.
- `SECURITY DEFINER` functions keep a locked, schema-specific `search_path`.
- Supabase roles have RLS enabled and no client table grants by default.
- Stripe API authentication works with a restricted test key.
- Stripe-style idempotency keys (`invoice:*`, `order:*`, `refund:*`, `dispute:*`) are enforced by the ledger.
- The balance never goes negative; shortfalls are recorded as `uncollectible`.
