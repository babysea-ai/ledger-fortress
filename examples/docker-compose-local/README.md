# Docker Compose Local Stack

Run the core ledger-fortress demo stack locally with PostgreSQL.

## Start

```bash
docker compose up -d
```

This gives you:

- **PostgreSQL** on `localhost:5432` with all four migrations applied
- **DATABASE_URL**: `postgresql://fortress:fortress@localhost:5432/fortress`

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
