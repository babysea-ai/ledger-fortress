# Contributing

Thanks for your interest. `ledger-fortress` is open to PRs, issues, and design discussion.

## Ground rules

- **Apache 2.0** for all contributions. By submitting a PR you agree to license it under Apache 2.0.
- **No breaking schema changes in v1.** If a change requires breaking `schemas/credit-event.v1.json` or `schemas/credit-alert.v1.json`, publish a v2 alongside.
- **Idempotency is sacred.** Any new SQL function that mutates the `credits` or `credit_ledger` table must be provably idempotent. Add a test that calls it twice and asserts the same result both times.
- **Tests for edge cases.** Anything that touches `reserve_credits`, `charge_credits`, `refund_credits`, or crash recovery requires tests covering the six edge cases documented in the README.

## Local development

### SQL

```bash
cd examples/docker-compose-local
docker compose up -d
psql postgresql://fortress:fortress@localhost:5432/fortress
```

### TypeScript SDK

The published SDK targets Node.js 18+ at runtime. Local TypeScript SDK development uses the Vitest 4/Vite 8 toolchain and requires Node.js 20.19+ or 22.12+.

```bash
cd client/typescript
npm install
npm test
npm run lint
```

### Python SDK

```bash
cd client/python
pip install -e ".[dev]"
ruff check .
pyright
pytest
```

## Pull request checklist

- [ ] SQL migrations are forward-only (no `DROP` in a migration that modifies an existing table)
- [ ] All SQL functions are idempotent (test calls them twice)
- [ ] TypeScript: `tsc --noEmit` clean
- [ ] TypeScript: `vitest run` passes
- [ ] Python: `ruff` clean
- [ ] Python: `pyright` clean
- [ ] If you touched a JSON schema, the example payloads still validate
- [ ] If you touched the SDK, both TypeScript and Python stay in sync
- [ ] If you touched docs, the deploy guide still reflects reality

## Issue triage

- `bug` - reproducible defect, with logs or a failing test
- `proposal` - design idea, RFC-style
- `good first issue` - small, well-scoped, friendly to first-time contributors

## Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Be respectful, assume good faith, focus on the work.
