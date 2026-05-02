# Changelog

All notable changes to `ledger-fortress` will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [0.1.2] - 2026-05-02

### Added
- Non-destructive `examples/real-stack-smoke/` validation harness for real Stripe test-mode API credentials and a real Supabase/Postgres project using a disposable schema.
- Explicit Stripe + Supabase/Postgres stack contract, terminology, and non-goals in the README and architecture docs.
- Sentry code-guard for the `babysea-ai/ledger-fortress` OSS project.
- Standalone OSS security policy and Dependabot dependency-security configuration for the public `babysea-ai/ledger-fortress` repository.

### Changed
- Reframed the public package metadata and SDK docs from generic Stripe/Postgres to Stripe + Supabase/Postgres.
- Switched SQL UUID defaults from `uuid-ossp`/`uuid_generate_v4()` to Supabase-friendly `pgcrypto`/`gen_random_uuid()`.
- Replaced the unrelated roadmap with the current validated v0.1 surface.

### Validated
- Re-grounded the OSS scope against BabySea production credit files: `21-credits.sql`, `34-credit-alerts.sql`, the inference-hub credit service, the Stripe billing webhook route, and the team billing checkout guard.
- Confirmed the real-stack smoke harness refuses live Stripe keys, drops its disposable Supabase schema by default, and only creates a disposable Stripe test customer.

## [0.1.1] - 2026-05-02

### Added
- `get_plan_credits()` SQL boundary plus TypeScript/Python SDK helpers for Stripe Price ID credit lookup.
- `charge_credits_detailed()` plus TypeScript/Python SDK helpers for distinguishing charged, duplicate/no-op, missing-reserve, already-settled, and shortfall outcomes.

### Changed
- Late success callbacks after refund now record durable `uncollectible` shortfalls when the account cannot fully recollect the reserved amount, and expose `status = 'shortfall'` through detailed charge APIs.
- Stripe custom credit resolvers run even when Stripe reports a zero amount, supporting fixed-credit plans, discounts, trials, and enterprise contracts.
- Ledger amount inputs are rejected when they exceed the supported three-decimal scale or `NUMERIC(10,3)` range instead of being silently rounded or surfacing database overflow errors.

### Validated
- TypeScript typecheck, tests, and build; Python syntax/metadata checks; PostgreSQL 16 migration load; and focused local SQL assertions for reservation idempotency, detailed charge shortfalls, clawbacks, true-ups, orphan recovery, plan lookup, and amount validation.

### Removed
- GitHub Actions CI workflow and README CI badge from the standalone OSS repo surface.

## [0.1.0] - 2026-04-30

Initial public release.

### Added
- Four PostgreSQL migrations for core ledger tables, low-balance alerts, RLS hardening, and true-up / clawback support.
- Seventeen public SQL functions: `reserve_credits`, `charge_credits`, `charge_credits_detailed`, `refund_credits`, `add_credits`, `settle_credits`, `clawback_credits`, `has_credits`, `get_balance`, `get_plan_credits`, `get_uncollectible_total`, `list_credit_ledger`, `find_orphaned_reservations`, `check_credit_alerts`, `reset_credit_alerts`, `get_credit_alert_settings`, and `upsert_credit_alert_settings`.
- Idempotency guarantees via unique partial indexes on the ledger (exactly-once add, charge, refund, clawback, and settle paths).
- Credit alert state machine: `credit_alert_settings`, `credit_alert_log`, `check_credit_alerts`, and `reset_credit_alerts`.
- TypeScript SDK (`LedgerFortress`) with reserve, charge, refund, add, settle, clawback, alert management, and crash recovery helpers.
- TypeScript Stripe webhook handlers for `invoice.paid`, `checkout.session.completed`, `charge.refunded`, and `charge.dispute.created` reconciliation.
- Python SDK (`LedgerFortress`) for the reserve / charge / refund / add / settle / clawback / crash-recovery lifecycle.
- JSON Schemas: `credit-event.v1.json`, `credit-alert.v1.json`.
- Docker Compose local stack (PostgreSQL with auto-applied migrations).
- TypeScript and Python SDK demo scripts with full lifecycle walkthrough.
- Documentation: architecture, edge cases, Stripe integration, and crash recovery guides.
- Apache 2.0 license.

### Validated
- Reserve ➜ charge ➜ refund lifecycle across all six documented edge cases.
- Variable-cost true-up via `settle_credits`, including uncollectible shortfall handling.
- Idempotent Stripe webhook handling across invoice retries, refunds, and disputes.
- Crash recovery on orphaned reservations older than a configurable window.
- Credit alert state machine fires exactly once per threshold descent.
