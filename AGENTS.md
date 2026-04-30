# ledger-fortress

`ledger-fortress` is the open-source pattern behind BabySea's production credit system.
See [README.md](README.md) for the full story.

This file mirrors the README so deploys, IDEs, and tooling that read `AGENTS.md` see the same context.

## Layout

| Path | Purpose |
|---|---|
| `migrations/` | PostgreSQL migrations (001_credits.sql, 002_credit_alerts.sql) |
| `client/typescript/` | TypeScript SDK |
| `client/python/` | Python SDK |
| `schemas/` | JSON Schemas: `credit-event.v1.json`, `credit-alert.v1.json` |
| `examples/typescript-sdk-demo/` | TypeScript demo: full lifecycle walkthrough |
| `examples/python-sdk-demo/` | Python demo: full lifecycle walkthrough |
| `examples/docker-compose-local/` | Local dev stack (PostgreSQL with auto-applied migrations) |
| `docs/` | Architecture, edge cases, Stripe integration, crash recovery |

## Conventions

- **Apache 2.0** license. Apply the header in every source file.
- **Schemas are the contract.** SDKs, migrations, and webhook payloads all reference the same JSON Schemas in `schemas/`.
- **Versioned events.** Every event carries a `schema_version` field. Never break v1 in place - publish v2 alongside.
- **Idempotency is sacred.** Every mutation to `credits` or `credit_ledger` must be provably idempotent via unique partial indexes.
- **TypeScript:** strict mode, no `any`.
- **Python:** type-annotated, `ruff` + `pyright`, no implicit `Any`.
- **SQL:** all functions in `LANGUAGE plpgsql`, comments on every table and function.
