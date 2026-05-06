# Changelog

All notable changes to `ledger-fortress` will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `BabySea OSS taxonomy` in `README.md`.
- Fix table formatting in `README.md`.
- Added shared BabySea OSS architecture framing, 30-second summary, deliberate Stripe refund/dispute boundary, invariant-first README links, and a formal `docs/INVARIANTS.md` proof map.
- Added `docs/stripe-event-matrix.md` covering handled Stripe events, duplicate/replay behavior, and intentionally unsupported refund/dispute/uncollectible flows.
- Added `docs/concurrency-tests.md`, a PgTAP invariant suite, and a safe TypeScript parallel reserve simulation that proves no-overdraft behavior and crash-recovery refunds against a disposable database.
- Added deployment/security verification scripts: `scripts/verify-rls.sh`, `scripts/verify-functions.sh`, and `scripts/verify-anon-denied.sh`.
- Added stronger security-policy guidance for backend-only use, service-role/direct database secrets, Stripe test-key validation, client-role denial, and the supported Stripe + Supabase boundary.
- Added standalone external-repo workflows under `.github/workflows/` for CodeQL, TypeScript package checks, Python package checks, verification-script syntax, and package dry-runs.
- Added an explicit README status note explaining that this is a working v0.x OSS primitive with validated invariants and evolving pre-1.0 public contracts.

### Changed

- Replaced the public status badge, security-policy wording, and Python development classifier from alpha to working/beta, matching the validated production-derived implementation.
- Normalized the Apache 2.0 `LICENSE` wording to the canonical BabySea OSS format used across public packages.
- Re-validated `ledger-fortress` against BabySea's production payment and credit implementation across Supabase schemas, the inference credit service, billing webhooks, generation cleanup, and team billing guards.
- Narrowed the documented OSS contract to the BabySea-derived Stripe + Supabase lifecycle: `add_credits`, `reserve_credits`, `charge_credits`, `refund_credits`, low-balance alerts, crash recovery, and backend-only Supabase security boundaries.
- Updated README, architecture, provenance, Stripe integration, crash recovery, edge-case, SDK, example, smoke-test, and JSON schema docs to define Stripe and Supabase as the supported stack.
- Updated TypeScript and Python SDKs/tests so the public API only exposes supported reserve, charge, refund, add, alert, ledger-listing, plan-credit, and orphan-recovery helpers.
- Updated Docker Compose and real-stack smoke validation to apply only the three supported migrations.
- Hardened the concurrency simulation so it refuses to run without `LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1`, always generates a fresh account id, never overwrites existing balances, and cleans up only rows it created.
- Typed the concurrency simulation's local Postgres loader so editor diagnostics can resolve the `pg` runtime dependency from the TypeScript client package and keep reserve-race result types explicit.
- Expanded client-role denial checks to probe all fortress tables and revoked RPC functions with transaction-wrapped test statements.
- Documented Supavisor pooler settings for environments where direct Supabase database hosts resolve to IPv6-only addresses.

### Removed

- Removed previously documented advanced ledger flows that are not implemented in BabySea production: variable-cost terminal reconciliation, credit clawbacks, debt/shortfall ledger entries, detailed charge-status APIs, and automatic Stripe refund/dispute credit deductions.
- Deleted the unsupported fourth advanced migration and removed all SDK methods, tests, schemas, examples, and docs that depended on it.

### Validated

- Confirmed BabySea production uses additive Stripe invoice/checkout credit grants, pre-generation reserve, success charge confirmation, failure/cancel/cleanup refund, low-balance alerts, and scheduled stale-generation cleanup.
- Confirmed BabySea production does not implement the removed advanced refund/dispute or debt-tracking flows, so they are intentionally outside this OSS surface.
- Ran TypeScript lint, Vitest, build, package dry-run, and shell syntax checks for verification scripts.
- Ran the real-stack smoke harness against Stripe test mode and Supabase on 2026-05-06. Result: disposable Stripe customer created/deleted, disposable Supabase schema applied/dropped, migrations loaded, additive grants, reserve, charge, refund, duplicate idempotency, low-balance alerts, RLS, and client-role grant posture validated with 52 assertions.

## [0.1.2] - 2026-05-02

### Added

- Non-destructive `examples/real-stack-smoke/` validation harness for real Stripe test-mode API credentials and a real Supabase project using a disposable schema.
- Explicit Stripe + Supabase stack contract, terminology, and non-goals in the README and architecture docs.
- Sentry code-guard for the `babysea-ai/ledger-fortress` OSS project.
- Standalone OSS security policy and Dependabot dependency-security configuration for the public `babysea-ai/ledger-fortress` repository.

### Changed

- Reframed the public package metadata and SDK docs to Stripe + Supabase.
- Switched SQL UUID defaults from `uuid-ossp`/`uuid_generate_v4()` to Supabase-friendly `pgcrypto`/`gen_random_uuid()`.
- TypeScript SDK dev toolchain updated to TypeScript 6, Vitest 4, and Stripe 22 test dependency; the `pg.Pool` unit-test mock now uses a constructable class compatible with Vitest 4.
- TypeScript SDK contributing docs now distinguish the Node.js 18+ runtime target from the Node.js 20.19+/22.12+ local development toolchain requirement.
- README architecture section now uses an inline text diagram instead of a CDN-hosted image.
- Replaced the unrelated roadmap with the current validated v0.1 surface.

### Validated

- Re-grounded the OSS scope against BabySea's internal production credit implementation: credit schema, credit alert schema, the credit service module, the Stripe billing webhook handler, and the team billing checkout guard.
- Confirmed the real-stack smoke harness refuses live Stripe keys, drops its disposable Supabase schema by default, and only creates a disposable Stripe test customer.

## [0.1.1] - 2026-05-02

### Added

- `get_plan_credits()` TypeScript/Python SDK helpers for Stripe Price ID credit lookup.

### Changed

- Late success callbacks after refund now attempt to re-deduct the reserved amount atomically before logging success; if the balance cannot cover it, `charge_credits` returns `FALSE` for application review.
- Stripe custom credit resolvers run even when Stripe reports a zero amount, supporting fixed-credit plans, discounts, trials, and enterprise contracts.
- Ledger amount inputs are rejected when they exceed the supported three-decimal scale or `NUMERIC(10,3)` range instead of being silently rounded or surfacing database overflow errors.

### Validated

- TypeScript typecheck, tests, and build; Python syntax/metadata checks; PostgreSQL 16 migration load; and focused local SQL assertions for reservation idempotency, orphan recovery, plan lookup, and amount validation.

### Removed

- GitHub Actions CI workflow and README CI badge from the standalone OSS repo surface.

## [0.1.0] - 2026-04-30

Initial public release.

### Added

- Three PostgreSQL migrations for core ledger tables, low-balance alerts, and RLS hardening.
- Thirteen public SQL functions: `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, `has_credits`, `get_balance`, `get_plan_credits`, `list_credit_ledger`, `find_orphaned_reservations`, `check_credit_alerts`, `reset_credit_alerts`, `get_credit_alert_settings`, and `upsert_credit_alert_settings`.
- Idempotency guarantees via unique partial indexes on the ledger for exactly-once add, charge, refund, and reserve paths.
- Credit alert state machine: `credit_alert_settings`, `credit_alert_log`, `check_credit_alerts`, and `reset_credit_alerts`.
- TypeScript SDK (`LedgerFortress`) with reserve, charge, refund, add, alert management, and crash recovery helpers.
- TypeScript Stripe webhook handlers for `invoice.paid`, `checkout.session.completed`, and `checkout.session.async_payment_succeeded` credit grants.
- Python SDK (`LedgerFortress`) for the reserve/charge/refund/add/crash-recovery lifecycle.
- JSON Schemas: `credit-event.v1.json`, `credit-alert.v1.json`.
- Docker Compose local stack (PostgreSQL with auto-applied migrations).
- TypeScript and Python SDK demo scripts with full lifecycle walkthrough.
- Documentation: architecture, edge cases, Stripe integration, and crash recovery guides.
- Apache 2.0 license.

### Validated

- Reserve ➜ charge ➜ refund lifecycle across the documented edge cases.
- Idempotent Stripe webhook handling across invoice and checkout retries.
- Crash recovery on orphaned reservations older than a configurable window.
- Credit alert state machine fires exactly once per threshold descent.
