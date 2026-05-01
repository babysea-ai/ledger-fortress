# Changelog

All notable changes to `ledger-fortress` will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- GitHub Actions CI workflow and README CI badge from the standalone OSS repo surface.

## [0.1.0] - 2026-04-30

Initial public release.

### Added
- Four PostgreSQL migrations for core ledger tables, low-balance alerts, RLS hardening, and true-up / clawback support.
- Fifteen public SQL functions: `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, `settle_credits`, `clawback_credits`, `has_credits`, `get_balance`, `get_uncollectible_total`, `list_credit_ledger`, `find_orphaned_reservations`, `check_credit_alerts`, `reset_credit_alerts`, `get_credit_alert_settings`, and `upsert_credit_alert_settings`.
- Idempotency guarantees via unique partial indexes on the ledger (exactly-once add, charge, refund, clawback, and settle paths).
- Credit alert state machine: `credit_alert_settings`, `credit_alert_log`, `check_credit_alerts`, and `reset_credit_alerts`.
- TypeScript SDK (`LedgerFortress`) with reserve, charge, refund, add, settle, clawback, alert management, and crash recovery helpers.
- TypeScript Stripe webhook handlers for `invoice.paid`, `checkout.session.completed`, `charge.refunded`, and `charge.dispute.created` reconciliation.
- Python SDK (`LedgerFortress`) for the core reserve / charge / refund / add / crash-recovery lifecycle.
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
