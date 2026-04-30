# Python SDK Demo

Demonstrates the full credit lifecycle: reserve → generate → settle.

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
python demo.py
```
