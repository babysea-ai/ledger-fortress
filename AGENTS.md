# ledger-fortress

`ledger-fortress` is the open-source pattern behind BabySea's production credit system.
See [README.md](README.md) for the full story.

This file mirrors the README so deploys, IDEs, and tooling that read `AGENTS.md` see the same context.

## Layout

| Path | Purpose |
|---|---|
| `migrations/` | Supabase SQL migrations (001_credits.sql, 002_credit_alerts.sql, 003_security.sql) |
| `client/typescript/` | TypeScript SDK |
| `client/python/` | Python SDK |
| `schemas/` | JSON Schemas: `credit-event.v1.json`, `credit-alert.v1.json` |
| `examples/typescript-sdk-demo/` | TypeScript demo: full lifecycle walkthrough |
| `examples/concurrency-simulation/` | Supabase or local PostgreSQL developer stand-in parallel reserve and crash-recovery demo |
| `examples/python-sdk-demo/` | Python demo: full lifecycle walkthrough |
| `examples/docker-compose-local/` | Local dev stack (PostgreSQL with auto-applied migrations) |
| `examples/real-stack-smoke/` | Safe real Stripe + Supabase smoke validation |
| `docs/` | Architecture, invariants, edge cases, Stripe integration, event matrix, crash recovery, concurrency tests |

## Conventions

- **Apache 2.0** license. Apply the header in every source file.
- **Schemas are the contract.** SDKs, migrations, and webhook payloads all reference the same JSON Schemas in `schemas/`.
- **Versioned events.** Every event carries a `schema_version` field. Never break v1 in place - publish v2 alongside.
- **Idempotency is sacred.** Every mutation to `credits` or `credit_ledger` must be provably idempotent via unique partial indexes.
- **Stack-specific public contract.** Current OSS code and docs must stay within the BabySea-derived Stripe + Supabase credit lifecycle unless a new stack or flow is implemented in BabySea and validated here.
- **Supabase-first terminology.** Public docs should say Supabase. Use PostgreSQL/Postgres only for Supabase SQL engine behavior, PostgreSQL-compatible connection URLs, `psql` migration tooling, database client libraries, Supabase connection details, or local developer stand-ins.
- **No unsupported ledger flows.** Do not add `settle_credits`, clawbacks, dispute handlers, or uncollectible debt tracking unless BabySea production implements the same flow first.
- **Client roles never own the ledger.** Supabase anon/authenticated roles must not be able to write ledger tables directly; runtime writes go through backend/service-role calls to hardened functions.
- **TypeScript:** strict mode, no `any`.
- **Python:** type-annotated, `ruff` + `pyright`, no implicit `Any`.
- **SQL:** all functions in `LANGUAGE plpgsql`, comments on every table and function.
