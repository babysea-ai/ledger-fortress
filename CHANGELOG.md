# Changelog

All notable changes to `ledger-fortress` will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-30

Initial public release.

### Added
- PostgreSQL migrations for `credits`, `credit_ledger`, and `plans` tables with atomic SQL functions.
- Six core SQL functions: `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, `has_credits`, `list_credit_ledger`.
- Crash recovery function: `find_orphaned_reservations` for cron-based reclamation of stuck reservations.
- Idempotency guarantees via unique partial indexes on the ledger (exactly-once charge, refund, and add).
- Credit alert state machine: `credit_alert_settings`, `credit_alert_log` tables with `check_credit_alerts` and `reset_credit_alerts` functions.
- TypeScript SDK (`LedgerFortress`) with `reserve()`, `charge()`, `refund()`, `addCredits()`, `canGenerate()`, `recoverOrphans()`, and alert management.
- TypeScript Stripe webhook handler (`createStripeWebhookHandler`) for `invoice.paid` and `checkout.session.completed` reconciliation.
- Python SDK (`LedgerFortress`) with the same surface as the TypeScript SDK.
- JSON Schemas: `credit-event.v1.json`, `credit-alert.v1.json`.
- Docker Compose local stack (PostgreSQL with auto-applied migrations).
- TypeScript and Python SDK demo scripts with full lifecycle walkthrough.
- Documentation: architecture, edge cases, Stripe integration guide.
- Apache 2.0 license.

### Validated
- Reserve → charge → refund lifecycle with all six documented edge cases.
- Idempotent webhook handling across Stripe invoice retries.
- Crash recovery on orphaned reservations older than configurable window.
- Credit alert state machine fires exactly once per threshold descent.
