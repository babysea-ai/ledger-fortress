<div align="center">

# 🏰 ledger-fortress

**Atomic credit settlement engine for async inference workloads. Built with Stripe and Supabase.**

<br/>

[![Open Source](https://img.shields.io/badge/open%20source-BabySea-48d1cc.svg)](https://babysea.ai)
[![BabySea OSS Primitives](https://img.shields.io/badge/oss%20primitives-BabySea-ea580c.svg)](#babysea-oss-taxonomy)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-production--grade-0969da.svg)](#9-status)
[![Sentry](https://img.shields.io/badge/Sentry-code%20guard-362D59.svg?logo=sentry&logoColor=white)](https://sentry.io)
[![Sentry Project Check](https://github.com/babysea-ai/ledger-fortress/actions/workflows/sentry-check.yml/badge.svg)](https://github.com/babysea-ai/ledger-fortress/actions/workflows/sentry-check.yml)
[![CodeQL](https://github.com/babysea-ai/ledger-fortress/actions/workflows/codeql.yml/badge.svg)](https://github.com/babysea-ai/ledger-fortress/actions/workflows/codeql.yml)
[![Package Check](https://github.com/babysea-ai/ledger-fortress/actions/workflows/publish-check.yml/badge.svg)](https://github.com/babysea-ai/ledger-fortress/actions/workflows/publish-check.yml)

<br/>

**Infrastructure**

[![Stripe](https://img.shields.io/badge/payments-Stripe-635BFF.svg)](https://stripe.com)
[![Supabase](https://img.shields.io/badge/ledger-Supabase-3ECF8E.svg)](https://supabase.com)

<br/>

*Every credit movement is accounted for.*

</div>

---

## BabySea OSS taxonomy

BabySea open source projects are organized into three categories:

[![BabySea OSS Primitives](https://img.shields.io/badge/oss%20primitives-BabySea-ea580c.svg)](#babysea-oss-taxonomy)
[![BabySea SDKs](https://img.shields.io/badge/sdks-BabySea-4f46e5.svg)](#babysea-oss-taxonomy)
[![BabySea OSS Starters](https://img.shields.io/badge/oss%20starters-BabySea-0284c7.svg)](#babysea-oss-taxonomy)

| Category           | Description                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OSS Primitives** | Production-derived infrastructure patterns extracted from BabySea's execution control plane. These projects isolate one hard system invariant at a time, such as provider routing, credit settlement, idempotency, failover, reconciliation, or operational safety. |
| **SDKs**           | Typed developer entry points into BabySea's execution control plane. SDKs provide application developers with a clean interface for creating, tracking, managing, and settling generative-media workloads without rebuilding provider-specific lifecycle logic.     |
| **OSS Starters**   | Deployable reference applications that help builders adopt BabySea patterns quickly. Starters combine product UI, auth, billing, storage, rate limits, and BabySea SDK execution into working examples optimized for onboarding and implementation.                 |

## BabySea OSS architecture

```text
Application developers
  │
  ▼
babysea SDK
  │
  ▼
BabySea execution control plane
  ├─ rosetta-bridge     request normalization
  ├─ adaptive-island    provider ranking
  ├─ execution-arrow    /v1/generate image/video execution (coming-soon)
  └─ ledger-fortress    credit settlement
```

## Table of contents

1. [Overview](#1-overview)
    - [What this is](#what-this-is)
    - [Short version](#short-version)
    - [Production lineage](#production-lineage)
    - [Grounding rule](#grounding-rule)
    - [Adoption path](#adoption-path)
2. [Stack contract](#2-stack-contract)
3. [Terminology](#3-terminology)
4. [Boundaries](#4-boundaries)
5. [Architecture](#5-architecture)
6. [Quick start](#6-quick-start)
    - [Apply the migrations to your Supabase database](#apply-the-migrations-to-your-supabase-database)
    - [Validate against real Stripe + Supabase services](#validate-against-real-stripe--supabase-services)
    - [Verify deployment security posture](#verify-deployment-security-posture)
    - [Use the TypeScript SDK](#use-the-typescript-sdk)
    - [Use the Python SDK](#use-the-python-sdk)
    - [Just use the schemas](#just-use-the-schemas)
7. [Core capabilities](#7-core-capabilities)
    - [Why it's different](#why-its-different)
    - [The credit lifecycle](#the-credit-lifecycle)
    - [Using the SDK](#using-the-sdk)
    - [The seven edge cases](#the-seven-edge-cases)
    - [Stripe integration](#stripe-integration)
    - [Stripe refund and dispute boundary](#stripe-refund-and-dispute-boundary)
    - [Pricing boundary](#pricing-boundary)
    - [Credit alerts](#credit-alerts)
    - [Crash recovery](#crash-recovery)
    - [Fail-open by design](#fail-open-by-design)
8. [Production readiness](#8-production-readiness)
9. [Status](#9-status)
10. [Community](#10-community)
    - [Who's using it](#whos-using-it)
    - [Related projects](#related-projects)
    - [Contributing](#contributing)
11. [License](#11-license)
12. [Acknowledgements](#12-acknowledgements)

---

## 1. Overview

### What this is

`ledger-fortress` is a production-grade open-source credit ledger inspired by the core invariants used in BabySea's real Stripe + Supabase credit system: atomic reserve ➜ charge ➜ refund, additive Stripe grants, database-enforced idempotency, low-balance alert state, stale-generation cleanup, and backend-only Supabase security boundaries. The OSS package adapts that proven pattern for teams building on **Stripe + Supabase**.

### Short version

AI generation billing is hard because work is async. You must reserve before dispatch, charge on success, refund on failure, survive duplicate webhooks, and recover crashed jobs. `ledger-fortress` packages that lifecycle with Stripe + Supabase.

### Production lineage

`ledger-fortress` packages the credit-lifecycle pattern BabySea operates for async image and video generation workloads. It turns the production Stripe + Supabase ledger boundary into a standalone OSS primitive for community deployments.

### Grounding rule

Public OSS behavior is limited to flows BabySea actually operates: Stripe subscription invoices, Stripe one-time credit-pack checkouts, Supabase `credits`/`credit_ledger`, reserve-before-dispatch, charge-on-success, refund-on-failure/cancel/cleanup, low-balance alert state, and service-role/backend-only mutation access. Where the OSS uses a different helper name or removes BabySea-specific tables, the underlying invariant maps back to those production paths.

For the exact split between BabySea-mirrored behavior and OSS-generalized extensions, see [`docs/babysea-provenance.md`](docs/babysea-provenance.md).

### Adoption path

If you run an **AI generation platform** (images, video, audio, 3D - anything where the workload runs asynchronously), this repo gives you the BabySea-style credit lifecycle. Apply the SQL migrations to Supabase, then call the SDK (TypeScript or Python) from your backend. You bring your Stripe account and your Supabase project. The fortress handles the ledger boundary.

## 2. Stack contract

`ledger-fortress` deliberately uses the same stack boundary as BabySea's credit system:

| Layer | Stack | Contract |
|---|---|---|
| External money movement | Stripe | Subscriptions, invoices, checkout sessions, credit packs, and webhook retries. |
| Ledger authority | Supabase | `credits`, `credit_ledger`, `plans`, RLS, `SECURITY DEFINER` functions, unique partial indexes, and non-negative balance checks. |
| Application runtime | Backend TypeScript/Python | Calls SQL functions through a service-role/direct database connection; never writes ledger tables from client code. |
| Customer notification state | Supabase | Low-balance alert settings and deduplication state. Delivery is fire-and-forget outside the credit ledger invariant. |

Supabase is the supported production and community ledger authority. PostgreSQL appears only when referring to Supabase's SQL engine behavior, PostgreSQL-compatible connection URLs, `psql` migration tooling, database client libraries, Supabase connection details, or local developer smoke stand-ins.

## 3. Terminology

| Term | Meaning in this package |
|---|---|
| Credit | Spendable balance unit. Default convention is `1 credit = $1 USD`, stored as `NUMERIC(10,3)`. |
| Reservation | A pre-dispatch atomic deduction by `reserve_credits()` for a generation. |
| Charge | A terminal success confirmation. It is log-only unless a prior refund must be corrected. |
| Refund | A terminal failure/cancel/crash-recovery reversal of a prior reservation. |
| Additive grant | Credits from Stripe invoice or checkout events. Grants add to existing balance and never reset rollover credits. |
| Backend-only boundary | Client roles must not read or write ledger tables directly; app servers call hardened functions. |

## 4. Boundaries

- Not a provider router, model catalog, or generation orchestrator.
- Not a client-side balance cache; Supabase is the source of truth.
- Not a generic payment abstraction. The implemented reconciliation path is Stripe-specific.
- Not automatic clawback handling for Stripe refunds, disputes, chargebacks, uncollectible invoices, or support-driven deductions.
- Not BabySea's account, subscription, notification, or provider schema. You map your app's account IDs into the fortress functions.

## 5. Architecture

```text
Stripe Checkout/Billing
  │  checkout and invoice webhooks
  ▼
Your backend webhook handler
  │  maps Stripe customer + generation IDs to account IDs
  ▼
Supabase fortress functions
  ├─ add_credits(...)        paid grants and renewals
  ├─ reserve_credits(...)    pre-generation balance gate
  ├─ charge_credits(...)     final successful cost
  └─ refund_credits(...)     failed or cancelled work
  │
  ▼
credits balance + immutable credit_ledger
  │
  ▼
RLS + SECURITY DEFINER backend-only mutation boundary
```

**Three pillars, based on the same credit ledger invariants BabySea relies on:**

- 🐘 **[Supabase](https://supabase.com)** - atomic transactions, CHECK constraints, RLS, `SECURITY DEFINER`, unique partial indexes
- 💳 **[Stripe](https://stripe.com)** - subscriptions, one-time purchases, webhook reconciliation
- 🔒 **Exactly-once guarantees** - idempotency keys at the SQL level, not the application level

## 6. Quick start

### Apply the migrations to your Supabase database

```bash
git clone https://github.com/babysea-ai/ledger-fortress
cd ledger-fortress
psql "$DATABASE_URL" < migrations/001_credits.sql        # core tables + functions
psql "$DATABASE_URL" < migrations/002_credit_alerts.sql  # low-balance alerts
psql "$DATABASE_URL" < migrations/003_security.sql       # RLS + SECURITY DEFINER
```

That's it. You get:

- `credits` table (one row per account, CHECK >= 0)
- `credit_ledger` table (immutable audit trail with idempotency indexes)
- `plans` table (Stripe price ID -> credit allocation mapping)
- Thirteen public SQL functions: `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, `has_credits`, `get_balance`, `get_plan_credits`, `list_credit_ledger`, `find_orphaned_reservations`, `check_credit_alerts`, `reset_credit_alerts`, `get_credit_alert_settings`, `upsert_credit_alert_settings`
- Credit alert tables with state-machine deduplication
- **RLS enabled on every table** with anon/authenticated table access revoked; runtime access goes through your backend and fortress functions
- All mutating functions run as `SECURITY DEFINER` with locked `search_path`

### Validate against real Stripe + Supabase services

Use the non-destructive smoke harness before promoting a deployment:

```bash
python -m venv /tmp/ledger-fortress-smoke-venv
/tmp/ledger-fortress-smoke-venv/bin/pip install "psycopg[binary]>=3.2"
STRIPE_SECRET_KEY="rk_test_..." \
SUPABASE_PROJECT_ID="<project-ref>" \
SUPABASE_DB_PASSWORD="..." \
/tmp/ledger-fortress-smoke-venv/bin/python examples/real-stack-smoke/validate.py
```

See [`examples/real-stack-smoke/`](examples/real-stack-smoke/) for the required environment and cleanup behavior.

### Verify deployment security posture

After applying all three migrations to a real deployment, verify RLS, hardened
functions, and client-role denial:

```bash
DATABASE_URL="postgresql://..." ./scripts/verify-rls.sh
DATABASE_URL="postgresql://..." ./scripts/verify-functions.sh
DATABASE_URL="postgresql://..." ./scripts/verify-anon-denied.sh
```

If your runner cannot reach `db.<project-ref>.supabase.co` because it resolves
to IPv6 only, use the Supavisor pooler with `SUPABASE_DB_HOST`,
`SUPABASE_DB_PORT=6543`, and `SUPABASE_DB_USER=postgres.<project-ref>` when
building the database URL.

### Use the TypeScript SDK

The TypeScript SDK is not yet published to npm. Apply the Option 1 migrations first so the tables and SQL functions exist, then build it from a checked-out copy of the repo and install it into your application from that local path:

```bash
git clone https://github.com/babysea-ai/ledger-fortress
cd ledger-fortress/client/typescript
npm install
npm run build

cd /path/to/your-app
npm install /path/to/ledger-fortress/client/typescript
```

```typescript
import { LedgerFortress } from 'ledger-fortress';

const fortress = new LedgerFortress({
  databaseUrl: process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL!,
});

async function runGeneration() {
  // Before generation: reserve credits atomically
  const reserved = await fortress.reserve({
    accountId: '00000000-0000-0000-0000-000000000001',
    generationId: 'gen_abc',
    amount: 0.062,
    model: 'flux-schnell',
  });

  if (!reserved) {
    return { error: 'insufficient_credits' };
  }

  // … run your async AI generation …
  const succeeded = true;

  if (succeeded) {
    // On success webhook: confirm the charge (log-only, no balance change)
    await fortress.charge({
      accountId: '00000000-0000-0000-0000-000000000001',
      generationId: 'gen_abc',
      amount: 0.062,
      model: 'flux-schnell',
    });
  } else {
    // On failure webhook: return the credits
    await fortress.refund({
      accountId: '00000000-0000-0000-0000-000000000001',
      generationId: 'gen_abc',
      amount: 0.062,
      model: 'flux-schnell',
    });
  }
}

runGeneration().catch(console.error);
```

### Use the Python SDK

The Python SDK is not yet published to PyPI. Apply the Option 1 migrations first so the tables and SQL functions exist, then install from source or pin to a commit SHA:

```bash
# from source
git clone https://github.com/babysea-ai/ledger-fortress
cd ledger-fortress/client/python && pip install -e .

# or pin via pip
# pip install "ledger-fortress @ git+https://github.com/babysea-ai/ledger-fortress.git@<commit-sha>#subdirectory=client/python"
```

```python
import os

from ledger_fortress import LedgerFortress

fortress = LedgerFortress(
    database_url=os.environ.get("SUPABASE_DATABASE_URL") or os.environ["DATABASE_URL"],
)

# Reserve ➜ generate ➜ charge or refund
reserved = fortress.reserve(
    account_id="00000000-0000-0000-0000-000000000001",
    generation_id="gen_abc",
    amount=0.062,
    model="flux-schnell",
)

if not reserved:
    raise RuntimeError("insufficient_credits")

succeeded = True

if succeeded:
    fortress.charge(
        account_id="00000000-0000-0000-0000-000000000001",
        generation_id="gen_abc",
        amount=0.062,
        model="flux-schnell",
    )
else:
    fortress.refund(
        account_id="00000000-0000-0000-0000-000000000001",
        generation_id="gen_abc",
        amount=0.062,
        model="flux-schnell",
    )
```

The Python SDK exposes the same core lifecycle as the TypeScript SDK: add credits, reserve, charge, refund, list the ledger, and run crash recovery.

### Just use the schemas

The JSON schemas in [`schemas/`](schemas/) are the contract. Emit `credit-event.v1.json` events; your pipeline consumes them.

## 7. Core capabilities

### Why it's different

Every AI generation platform reinvents the same billing stack. They hit the same wall.

| Problem (real, painful, recurring) | How `ledger-fortress` solves it |
|---|---|
| **Race conditions.** User clicks "Generate" twice in 50ms. Both requests check the balance before either deducts. Overdraw. | Single `UPDATE ... WHERE tokens >= cost` - atomic check-and-deduct in one statement. No TOCTOU window exists. |
| **Lost credits.** Provider crashes mid-generation. No webhook arrives. Credits reserved forever. User churns. | Crash recovery cron finds orphans older than `windowMinutes` and refunds them. Idempotent with the success path. |
| **Duplicate ledger events.** Stripe retries a webhook. Handler runs twice. User credited twice. Or a provider callback refunds twice. | Unique partial indexes cover `charge`, `refund`, `reserve`, and additive Stripe grants keyed on `(account_id, description)`. Exactly-once at the SQL level. |
| **Webhooks arrive out of order.** Refund hits before the charge confirmation. User could generate for free. | `charge_credits` checks for prior refund and re-deducts atomically before logging charge. If it cannot fully collect, it returns `FALSE` for application review. `refund_credits` checks for prior charge and no-ops. |
| **Stale credit-pack checkout.** User starts a credit-pack checkout, cancels subscription, then completes payment. | The Stripe helper supports a `hasActiveSubscription` callback so checkout completion can be denied at webhook time, not only at session creation. |
| **Credit packs vanish on subscription renewal.** User buys $10 pack, then renewal "resets" the balance. Pack lost. | `add_credits` is additive (`tokens = tokens + amount`), never resets. Audit trail shows every grant. |
| **Anyone with the Supabase anon key can read or forge ledger entries.** | Migration `003_security.sql` enables RLS, REVOKEs anon/authenticated access, and runs mutations as `SECURITY DEFINER` with locked `search_path`. |

### The credit lifecycle

```
 reserve()          charge()            refund()
    │                  │                   │
    ▼                  ▼                   ▼
┌────────┐      ┌────────────┐      ┌────────────┐
│RESERVE │─────►│  CHARGED   │      │  REFUNDED  │
│        │      │ (log-only, │      │ (credits   │
│balance │      │  no balance│      │  returned) │
│deducted│      │  change)   │      │            │
└────────┘      └────────────┘      └────────────┘
    │                                     ▲
    │              5 min timeout          │
    └─────────────────────────────────────┘
                crash recovery cron
```

### Using the SDK

The TypeScript and Python SDKs share the same reserve ➜ charge ➜ refund core contract. BabySea computes model cost before reserve; use one reservation amount and then either `charge()` on success or `refund()` on failure/cancel/cleanup.

```typescript
const reserved = await fortress.reserve({
  accountId,
  generationId,
  amount: 0.062,
  model: 'flux-schnell',
});

if (reserved) {
  // Dispatch the async workload.
  await fortress.charge({
    accountId,
    generationId,
    amount: 0.062,
    model: 'flux-schnell',
  });
}
```

See [`examples/typescript-sdk-demo/`](examples/typescript-sdk-demo/) and [`examples/python-sdk-demo/`](examples/python-sdk-demo/) for end-to-end demos that add credits, reserve, charge or refund, inspect the ledger, and run crash recovery.

### The seven edge cases

| Edge case | What goes wrong | How the fortress handles it |
|---|---|---|
| **Two clicks, 50ms apart** | Both `SELECT balance` return 10, both deduct 5 ➜ overdraw | Single `UPDATE ... WHERE tokens >= cost` - atomic, no separate SELECT |
| **Provider never responds** | Credits locked forever, user complains | Crash recovery cron finds reservations older than threshold, refunds them |
| **Duplicate success webhook** | Double-charge | Unique partial index on `(generation_id) WHERE type='charge'` - second INSERT is a no-op |
| **Duplicate failure webhook** | Double-refund, free credits | Unique partial index on `(generation_id) WHERE type='refund'` - second INSERT is a no-op |
| **Charge arrives AFTER refund** | Refund returned credits, charge would confirm the reservation ➜ user generated for free | Guard: `charge_credits` checks if already refunded. If yes, it re-deducts before logging charge; if it cannot collect, it returns `FALSE` for application review. |
| **Refund arrives AFTER charge** | Would return credits for a successful generation | Guard: `refund_credits` checks if already charged - if yes, no-op. Serialized via `FOR UPDATE` |
| **Terminal event without reserve** | App bug calls charge/refund for a generation that never reserved credits | Terminal functions require a matching `reserve` row for the same account and generation |

### Stripe integration

`ledger-fortress` includes ready-to-use Stripe webhook handlers with HMAC signature verification:

```typescript
import Stripe from 'stripe';
import { LedgerFortress } from 'ledger-fortress';
import { createStripeWebhookHandler, verifyStripeSignature } from 'ledger-fortress/stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const fortress = new LedgerFortress({ databaseUrl: process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL! });

const handler = createStripeWebhookHandler({
  fortress,
  resolveAccountId: async (customerId) => {
    // Map Stripe customer to your account ID
    return db.accounts.findByStripeCustomer(customerId);
  },
});

// Next.js App Router example (raw body required for signature verification)
export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get('stripe-signature');
  const event = verifyStripeSignature(stripe, payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  const result = await handler(event);
  return Response.json(result);
}

// Handles:
// - invoice.paid               (subscription renewal, idempotent via invoice ID)
// - checkout.session.completed/async_payment_succeeded
//                              (paid credit pack purchase, idempotent via payment intent/session ID)
```

#### Plans configuration

BabySea stores Stripe Price IDs in a Supabase `plans` table. The OSS keeps that table so your backend can map Stripe prices to credit allocations when your product policy needs plan-based grants or plan-aware UI:

```sql
INSERT INTO plans (name, variant_id, tokens) VALUES
  ('Starter Monthly',  'price_starter_monthly',  9.000),
  ('Pro Monthly',      'price_pro_monthly',      29.000),
  ('Credit Pack $10',  'price_pack_10',          10.000),
  ('Credit Pack $100', 'price_pack_100',         100.000);
```

Credits are **additive** (rollover, never reset). A Pro subscriber who buys a $10 credit pack gets $39 total, not $29.

By default, the Stripe helper mirrors BabySea's current grant path: it grants credits from the amount Stripe reports as paid (`amount_paid/100` for subscription invoices or `amount_total/100` for credit-pack checkouts) and skips non-positive amounts. Use `resolveInvoiceCredits` or `resolveCheckoutCredits` only when your own Stripe Price ID policy explicitly maps to fixed credits in `plans.tokens`; those resolvers are a portable helper over the real `plans` table pattern, not a new payment workflow.

### Stripe refund and dispute boundary

BabySea's current credit implementation does not automatically deduct credits for Stripe `charge.refunded` or `charge.dispute.created` events, so `ledger-fortress` does not ship those flows. Handle payment refunds and disputes in Stripe/support workflows outside this package.

For the full handled/skipped event matrix, see [`docs/stripe-event-matrix.md`](docs/stripe-event-matrix.md).

### Pricing boundary

BabySea computes the model cost before `reserve_credits()` using model pricing, duration, resolution, and audio-mode inputs. `ledger-fortress` follows that approach: reserve the exact amount your application has accepted for the generation, then call `charge()` or `refund()` for the same amount.

### Credit alerts

Built-in low-balance notifications with state-machine deduplication:

```typescript
// Configure per-account thresholds
await fortress.setAlertSettings({
  accountId: '00000000-0000-0000-0000-000000000001',
  enabled: true,
  thresholds: [5.0, 1.0, 0.5],
  channels: { inApp: true, email: true, webhook: true },
});

// Check alerts after every reservation (fire-and-forget)
const alerts = await fortress.checkAlerts('00000000-0000-0000-0000-000000000001');
// Returns newly-crossed thresholds: [{ threshold: 1.0, balance: 0.82 }]
// Each threshold fires exactly once until balance recovers above it
```

| Feature | Detail |
|---|---|
| Deduplication | Each threshold fires once per descent; resets when balance recovers |
| Channels | In-app, email, webhook - configure per account |
| Non-blocking | Alert checks never block the generation response |
| Max 10 thresholds | Validated at the SQL level |

### Crash recovery

One cron endpoint. Run it every 5 minutes:

```typescript
import { LedgerFortress } from 'ledger-fortress';

const fortress = new LedgerFortress({ databaseUrl: process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL });

// Find reservations older than `windowMinutes` with no charge/refund terminal event
const result = await fortress.recoverOrphans({
  windowMinutes: 5,
  limit: 100,
  onRecovered: async (generationId, accountId) => {
    // Optional: notify user, fire webhook, mark generation as failed
  },
});

console.log(result);
// { inspected: 12, refunded: 3, errors: 0 }
```

### Fail-open by design

| Failure | Behavior |
|---|---|
| Stripe webhook delayed | Credits already reserved - generation proceeds. Webhook reconciles later |
| Stripe down entirely | Existing credits work. New purchases queue in Stripe |
| Database slow | Reserve is a single atomic UPDATE - the fastest possible query |
| Crash recovery cron misses a cycle | Window is configurable, orphans wait for next cycle |
| Alert delivery fails | Fire-and-forget - never blocks generation. Retry on next reservation |

The reserve path is **on the critical path** (it must be - you can't generate without credits). But it's exactly one atomic SQL statement. Everything else is eventually consistent.

## 8. Production readiness

Before going live with real Stripe payments:

- [ ] Apply all three migrations (`001`, `002`, `003`)
- [ ] Confirm RLS is `ENABLED` on all five tables (`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('plans','credits','credit_ledger','credit_alert_settings','credit_alert_log');`)
- [ ] Verify the `anon` role cannot read or write any fortress table via PostgREST (`curl ... | grep 42501`)
- [ ] Always call `verifyStripeSignature()` before passing events to the handler
- [ ] Subscribe your Stripe webhook to: `invoice.paid`, `checkout.session.completed`, and `checkout.session.async_payment_succeeded` if you support async payment methods
- [ ] Use a direct connection for migrations and a transaction-mode pooler (PgBouncer or PostgREST/Supavisor in transaction mode) for runtime. On Supabase specifically, that means session pooler (port 5432) for migrations and transaction pooler (port 6543) for runtime.
- [ ] Set `STRIPE_WEBHOOK_SECRET` from your Stripe webhook endpoint (not your API key)
- [ ] Schedule `recoverOrphans()` every 5 minutes via cron
- [ ] Map Stripe Price IDs into the `plans` table before using plan-based grants or plan-aware billing UI
- [ ] Configure alert thresholds per account before exposing low-balance UI
- [ ] Cap `pg.Pool` connection limits well below your Supabase connection cap (Supabase tiers cap at 60-500 depending on plan; default SDK setting is `max: 10`)
- [ ] Restrict your Stripe API key to the [permissions listed in `docs/stripe-integration.md`](docs/stripe-integration.md)
- [ ] Keep Stripe refund/dispute handling outside `ledger-fortress`; this package only grants credits from paid invoices and checkout sessions

For a proof-oriented map from invariants to SQL mechanisms, see [`docs/INVARIANTS.md`](docs/INVARIANTS.md).

## 9. Status

`ledger-fortress` is a **production-grade working OSS primitive** (v0.1.0). The reserve ➜ charge ➜ refund core mirrors [BabySea](https://babysea.ai)'s production credit lifecycle approach for 80+ AI models across 12+ labs. This repo packages and generalizes those credit ledger invariants for community Stripe + Supabase deployments. See [`CHANGELOG.md`](CHANGELOG.md).

The ledger invariants are ready for production use when you apply all migrations, keep client roles outside the ledger, verify Stripe signatures, and run the deployment checks. The package is still v0.x, so distribution details such as package publishing and non-invariant SDK ergonomics can evolve before 1.0; that does not weaken the current Stripe + Supabase credit lifecycle guarantees below, which are documented, tested, and real-stack smoke-validated.

Both the TypeScript and Python SDKs build. The TypeScript SDK ships with tests. Neither is published to npm/PyPI yet for 0.1; install from source or pin to a commit SHA.

**Current v0.1 surface:**

- [x] Atomic reserve ➜ charge ➜ refund lifecycle
- [x] Idempotent Stripe invoice and checkout reconciliation
- [x] Crash recovery for orphaned reservations
- [x] Credit alert state machine
- [x] TypeScript + Python SDKs
- [x] JSON schemas (event contract)
- [x] Supabase migrations with RLS and `SECURITY DEFINER`
- [x] Non-destructive real-stack smoke harness for Stripe + Supabase

## 10. Community

### Who's using it

- **[BabySea](https://babysea.ai)**: the execution control plane for generative media. 80+ image and video models from 12+ AI labs, using the reserve ➜ charge ➜ refund core pattern this project packages.

*Using `ledger-fortress`? Open a PR to add yourself.*

### Related projects

- 🌊 [BabySea SDK](https://github.com/babysea-ai/babysea): Production TypeScript SDK for the BabySea execution control plane for generative media. One API, one schema, one lifecycle across image and video inference providers.
- 🏝️ [adaptive-island](https://github.com/babysea-ai/adaptive-island): Cache-first provider selection engine for multi-provider inference workloads. Built with Databricks, Supabase, and Upstash.
- 🌉 [rosetta-bridge](https://github.com/babysea-ai/rosetta-bridge): Request normalization engine for multi-provider inference workloads. Built with JSON Schema and TypeScript adapters.

### Contributing

We welcome PRs, issues, and design discussion. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## 11. License

[Apache License 2.0](LICENSE). Use it, fork it, ship it. Just keep the notice.

## 12. Acknowledgements

Built with [**Stripe**](https://stripe.com) and [**Supabase**](https://supabase.com).
