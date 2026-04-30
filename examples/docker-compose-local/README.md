# Docker Compose Local Stack

Run the full ledger-fortress stack locally with PostgreSQL.

## Start

```bash
docker compose up -d
```

This gives you:
- **PostgreSQL** on `localhost:5432` with migrations applied
- **DATABASE_URL**: `postgresql://fortress:fortress@localhost:5432/fortress`

## Run the demo

```bash
# TypeScript
cd ../../examples/typescript-sdk-demo
DATABASE_URL=postgresql://fortress:fortress@localhost:5432/fortress npx tsx demo.ts

# Python
cd ../../examples/python-sdk-demo
DATABASE_URL=postgresql://fortress:fortress@localhost:5432/fortress python demo.py
```

## Stop

```bash
docker compose down -v
```
