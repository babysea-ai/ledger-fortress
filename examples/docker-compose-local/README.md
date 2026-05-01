# Docker Compose Local Stack

Run the core ledger-fortress demo stack locally with PostgreSQL.

## Start

```bash
docker compose up -d
```

This gives you:

- **PostgreSQL** on `localhost:5432` with `001_credits.sql` and `002_credit_alerts.sql` applied
- **DATABASE_URL**: `postgresql://fortress:fortress@localhost:5432/fortress`

Apply `003_security.sql` and `004_clawback_and_trueup.sql` manually if you want the full production migration surface.

## Run the demo

```bash
# TypeScript
cd ../../client/typescript
npm install
npm run build

cd ../../examples/typescript-sdk-demo
npm install
DATABASE_URL=postgresql://fortress:fortress@localhost:5432/fortress npm run demo

# Python
cd ../../examples/python-sdk-demo
pip install -e ../../client/python
DATABASE_URL=postgresql://fortress:fortress@localhost:5432/fortress python demo.py
```

## Stop

```bash
docker compose down -v
```
