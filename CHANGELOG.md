# Changelog

All notable changes to `ledger-fortress` will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-08

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
- Added the upcoming `execution-arrow` primitive to the shared README architecture map with its temporary `/#` launch link and `/v1/generate/image` + `/v1/generate/video` scope.
- Added README workflow badges for the standalone CodeQL and Package Check workflows.
- Added `scripts/sentry-project-check.mjs`, a README badge, ignored local `.sentryclirc` support, and a scheduled `Sentry Project Check` workflow. The workflow reads Sentry org/project configuration from GitHub Actions secrets, verifies the configured project slug, active status, `other` platform, ownership, and Code Guard rules, and does not add runtime tracking.
- Non-destructive `examples/real-stack-smoke/` validation harness for real Stripe test-mode API credentials and a real Supabase project using a disposable schema.
- Explicit Stripe + Supabase stack contract, terminology, and non-goals in the README and architecture docs.
- Sentry code-guard for the `babysea-ai/ledger-fortress` OSS project.
- Standalone OSS security policy and Dependabot dependency-security configuration for the public `babysea-ai/ledger-fortress` repository.
- `get_plan_credits()` TypeScript/Python SDK helpers for Stripe Price ID credit lookup.
- Three Supabase SQL migrations for core ledger tables, low-balance alerts, and RLS hardening.
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

### Changed

- Added a bullet-point table of contents after the BabySea OSS architecture section for quick navigation.
- Numbered all H2 sections after BabySea OSS architecture for consistent cross-primitive README structure.
- Renamed "Who's using it" to "Who's using the pattern" for cross-primitive consistency.
- Reorder the badge.
- Replaced the public status badge, security-policy wording, and Python development classifier from alpha to working/beta, matching the validated production-derived implementation.
- Changed the working status badge color from green to blue for OSS primitive status consistency.
- Clarified the README status as production-grade Stripe + Supabase ledger invariants with v0.x distribution ergonomics, rather than uncertain invariant maturity.
- Refined Stripe integration docs so the default grant path mirrors BabySea's current amount-paid behavior, while `get_plan_credits()` and custom resolvers are documented as explicit plan-table helpers rather than a separate payment workflow.
- Added a provenance section distinguishing BabySea-specific production tables from OSS helpers for plan lookup, orphan detection, and charge-after-refund re-collection.
- Corrected the architecture guide to state that a late charge after refund re-deducts the reserved amount when possible instead of no-oping after refund.
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
- Reframed the public package metadata and SDK docs to Stripe + Supabase.
- Switched SQL UUID defaults from `uuid-ossp`/`uuid_generate_v4()` to Supabase-friendly `pgcrypto`/`gen_random_uuid()`.
- TypeScript SDK dev toolchain updated to TypeScript 6, Vitest 4, and Stripe 22 test dependency; the `pg.Pool` unit-test mock now uses a constructable class compatible with Vitest 4.
- TypeScript SDK contributing docs now distinguish the Node.js 18+ runtime target from the Node.js 20.19+/22.12+ local development toolchain requirement.
- README architecture section now uses an inline text diagram instead of a CDN-hosted image.
- Replaced the unrelated roadmap with the current validated v0.1 surface.
- Late success callbacks after refund now attempt to re-deduct the reserved amount atomically before logging success; if the balance cannot cover it, `charge_credits` returns `FALSE` for application review.
- Stripe custom credit resolvers run before the default amount-paid fallback so adopters can explicitly use `plans.tokens` for fixed-credit Stripe Price IDs without changing the supported Stripe event set.
- Ledger amount inputs are rejected when they exceed the supported three-decimal scale or `NUMERIC(10,3)` range instead of being silently rounded or surfacing database overflow errors.

### Removed

- Removed previously documented advanced ledger flows that are not implemented in BabySea production: variable-cost terminal reconciliation, credit clawbacks, debt/shortfall ledger entries, detailed charge-status APIs, and automatic Stripe refund/dispute credit deductions.
- Deleted the unsupported fourth advanced migration and removed all SDK methods, tests, schemas, examples, and docs that depended on it.
- GitHub Actions CI workflow and README CI badge from the standalone OSS repo surface.

### Validated

- Confirmed BabySea production uses additive Stripe invoice/checkout credit grants, pre-generation reserve, success charge confirmation, failure/cancel/cleanup refund, low-balance alerts, and scheduled stale-generation cleanup.
- Confirmed BabySea production does not implement the removed advanced refund/dispute or debt-tracking flows, so they are intentionally outside this OSS surface.
- Re-checked the OSS surface on 2026-05-07 against BabySea's Supabase credit schema, credit alert schema, inference credit service, Stripe billing webhook, generation cleanup, user cancel flow, and team credit-pack subscription guard; docs now explicitly separate real BabySea flows from OSS portability helpers.
- Re-ran ledger-fortress validation on 2026-05-07: TypeScript Vitest suite, TypeScript `tsc --noEmit`, TypeScript package build, edited-file diagnostics, and verification-script shell syntax checks.
- Ran TypeScript lint, Vitest, build, package dry-run, and shell syntax checks for verification scripts.
- Ran the real-stack smoke harness against Stripe test mode and Supabase on 2026-05-06. Result: disposable Stripe customer created/deleted, disposable Supabase schema applied/dropped, migrations loaded, additive grants, reserve, charge, refund, duplicate idempotency, low-balance alerts, RLS, and client-role grant posture validated with 52 assertions.
- Re-grounded the OSS scope against BabySea's internal production credit implementation: credit schema, credit alert schema, the credit service module, the Stripe billing webhook handler, and the team billing checkout guard.
- Confirmed the real-stack smoke harness refuses live Stripe keys, drops its disposable Supabase schema by default, and only creates a disposable Stripe test customer.
- TypeScript typecheck, tests, and build; Python syntax/metadata checks; PostgreSQL 16 migration load; and focused local SQL assertions for reservation idempotency, orphan recovery, plan lookup, and amount validation.
- Reserve ➜ charge ➜ refund lifecycle across the documented edge cases.
- Idempotent Stripe webhook handling across invoice and checkout retries.
- Crash recovery on orphaned reservations older than a configurable window.
- Credit alert state machine fires exactly once per threshold descent.
