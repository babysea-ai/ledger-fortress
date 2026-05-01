<div align="center">

# 🏰 ledger-fortress

**An atomic credit settlement engine for async AI workloads, built on Stripe + Postgres.**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Stripe](https://img.shields.io/badge/built%20on-Stripe-635BFF.svg)](https://stripe.com)
[![Postgres](https://img.shields.io/badge/storage-PostgreSQL-4169E1.svg)](https://www.postgresql.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

*Every generation settles.*

</div>

---

## What this is

`ledger-fortress` is the open-source pattern behind [BabySea](https://babysea.ai)'s production credit system: an atomic reserve ➜ charge ➜ refund lifecycle that turns Stripe subscriptions and one-time purchases into spendable credits, settles them against async AI generations, and is designed to prevent the failure modes that lose cents to race conditions, duplicate webhooks, or crashed handlers.

If you run an **AI generation platform** (images, video, audio, 3D - anything where the workload runs asynchronously for 2-120 seconds), this repo gives you the entire credit lifecycle. Apply the SQL migrations to your Postgres, then call the SDK (TypeScript or Python) from your application.

You bring your Stripe account and your Postgres database. The fortress handles the rest.

## Why it's different

Every AI generation platform reinvents the same billing stack. They hit the same wall.

| Problem (real, painful, recurring) | How `ledger-fortress` solves it |
|---|---|
| **Race conditions.** User clicks "Generate" twice in 50ms. Both requests check the balance before either deducts. Overdraw. | Single `UPDATE ... WHERE tokens >= cost` - atomic check-and-deduct in one statement. No TOCTOU window exists. |
| **Lost credits.** Provider crashes mid-generation. No webhook arrives. Credits reserved forever. User churns. | Crash recovery cron finds orphans older than `windowMinutes` and refunds them. Idempotent with the success path. |
| **Double settlement.** Stripe retries a webhook. Handler runs twice. User charged twice. Or refunded twice. | Unique partial indexes cover `charge`, `refund`, `trueup`, and clawback paths, plus additive grants keyed on `(account_id, description)`. Exactly-once at the SQL level. |
| **Webhooks arrive out of order.** Refund hits before the charge confirmation. User generates for free. | `charge_credits` checks for prior refund and re-deducts atomically. `refund_credits` checks for prior charge and no-ops. Both serialized via `FOR UPDATE`. |
| **Variable cost generation.** Reserve $1 max for video, actual cost is $0.30. Most billing systems can't true-up. | `settle_credits(reserved, actual)` atomically returns the difference, or re-deducts on overshoot. Idempotent per generation. |
| **Customer disputes the charge.** Stripe refunds the payment. Your books still show the credits as granted. | `charge.refunded` and `charge.dispute.created` webhooks claw back credits up to available balance. Shortfall recorded as `uncollectible` for accounting. Balance never goes negative. |
| **Credit packs vanish on subscription renewal.** User buys $10 pack, then renewal "resets" the balance. Pack lost. | `add_credits` is additive (`tokens = tokens + amount`), never resets. Audit trail shows every grant. |
| **Anyone with the anon key can read or forge ledger entries.** | Migration `003_security.sql` enables RLS + FORCE RLS on every table, REVOKEs anon access, and runs mutations as `SECURITY DEFINER` with locked `search_path`. |

## Architecture

<img src="https://cdn.babysea.live/oss-architecture/ledger-fortress.png" alt="ledger-fortress by BabySea" />

**Three pillars, all battle-tested:**

- 🐘 **[PostgreSQL](https://www.postgresql.org)** - atomic transactions, CHECK constraints, unique partial indexes
- 💳 **[Stripe](https://stripe.com)** - subscriptions, one-time purchases, webhook reconciliation
- 🔒 **Exactly-once guarantees** - idempotency keys at the SQL level, not the application level

## Quick start

### Option 1. Apply the migrations to your Postgres database

```bash
git clone https://github.com/babysea-ai/ledger-fortress
cd ledger-fortress
psql "$DATABASE_URL" < migrations/001_credits.sql            # core tables + functions
psql "$DATABASE_URL" < migrations/002_credit_alerts.sql      # low-balance alerts
psql "$DATABASE_URL" < migrations/003_security.sql           # RLS + SECURITY DEFINER
psql "$DATABASE_URL" < migrations/004_clawback_and_trueup.sql  # refunds + variable cost
```

That's it. You get:

- `credits` table (one row per account, CHECK >= 0)
- `credit_ledger` table (immutable audit trail with idempotency indexes)
- `plans` table (Stripe price ID -> credit allocation mapping)
- Fifteen public SQL functions: `reserve_credits`, `charge_credits`, `refund_credits`, `add_credits`, `settle_credits`, `clawback_credits`, `has_credits`, `get_balance`, `get_uncollectible_total`, `list_credit_ledger`, `find_orphaned_reservations`, `check_credit_alerts`, `reset_credit_alerts`, `get_credit_alert_settings`, `upsert_credit_alert_settings`
- Credit alert tables with state-machine deduplication
- **RLS enabled and FORCED on every table** (deny-all to anon/authenticated; access only via service-role or fortress functions)
- All mutating functions run as `SECURITY DEFINER` with locked `search_path`

### Option 2. Use the TypeScript SDK

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
  databaseUrl: process.env.DATABASE_URL!,
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

### Option 3. Use the Python SDK

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

fortress = LedgerFortress(database_url=os.environ["DATABASE_URL"])

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

> The Python SDK currently exposes the core `reserve`/`charge`/`refund`/`add_credits`/`recover_orphans` operations. `settle`, `clawback`, and `get_uncollectible_total` are TypeScript-only in 0.1; until parity ships, call those SQL functions directly from Python via `psycopg2` or your preferred PostgreSQL driver.

### Option 4. Just use the schemas

The JSON schemas in [`schemas/`](schemas/) are the contract. Emit `credit-event.v1.json` events; your pipeline consumes them.

## The credit lifecycle

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

## Using the SDK

The TypeScript and Python SDKs share the same reserve ➜ charge ➜ refund core contract. Use `charge()` when the reserved amount is the final amount. Use `settle()` for variable-cost true-up from the TypeScript SDK today, or call `settle_credits` directly from Python until parity ships.

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

## The six edge cases

| Edge case | What goes wrong | How the fortress handles it |
|---|---|---|
| **Two clicks, 50ms apart** | Both `SELECT balance` return 10, both deduct 5 ➜ overdraw | Single `UPDATE ... WHERE tokens >= cost` - atomic, no separate SELECT |
| **Provider never responds** | Credits locked forever, user complains | Crash recovery cron finds reservations older than threshold, refunds them |
| **Duplicate success webhook** | Double-charge | Unique partial index on `(generation_id) WHERE type='charge'` - second INSERT is a no-op |
| **Duplicate failure webhook** | Double-refund, free credits | Unique partial index on `(generation_id) WHERE type='refund'` - second INSERT is a no-op |
| **Charge arrives AFTER refund** | Refund returned credits, charge would confirm the reservation ➜ user generated for free | Guard: `charge_credits` checks if already refunded - if yes, re-deducts the balance. Serialized via `FOR UPDATE` |
| **Refund arrives AFTER charge** | Would return credits for a successful generation | Guard: `refund_credits` checks if already charged - if yes, no-op. Serialized via `FOR UPDATE` |

## Stripe integration

`ledger-fortress` includes ready-to-use Stripe webhook handlers with HMAC signature verification:

```typescript
import Stripe from 'stripe';
import { LedgerFortress } from 'ledger-fortress';
import { createStripeWebhookHandler, verifyStripeSignature } from 'ledger-fortress/stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const fortress = new LedgerFortress({ databaseUrl: process.env.DATABASE_URL! });

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
// - checkout.session.completed (credit pack purchase, idempotent via order ID)
// - charge.refunded            (clawback credits proportional to refund)
// - charge.dispute.created     (clawback disputed amount)
```

### Plans configuration

Map your Stripe Price IDs to credit allocations:

```sql
INSERT INTO plans (name, variant_id, tokens) VALUES
  ('Starter Monthly',  'price_starter_monthly',  9.000),
  ('Pro Monthly',      'price_pro_monthly',      29.000),
  ('Credit Pack $10',  'price_pack_10',          10.000),
  ('Credit Pack $100', 'price_pack_100',         100.000);
```

Credits are **additive** (rollover, never reset). A Pro subscriber who buys a $10 credit pack gets $39 total, not $29.

## Variable cost true-up

Generative media costs are rarely known up-front. Reserve the maximum estimate, settle the actual cost atomically:

```typescript
// 1. Reserve at max estimate (e.g. video at full duration)
await fortress.reserve({
  accountId, generationId, amount: 1.50, model: 'video-5s',
});

// 2. Generation completes - actual cost was lower
await fortress.settle({
  accountId,
  generationId,
  reservedAmount: 1.50,
  actualAmount: 0.95,    // refunds $0.55 atomically
});

// Or higher (true-up):
await fortress.settle({
  accountId,
  generationId,
  reservedAmount: 1.50,
  actualAmount: 1.85,    // re-deducts $0.35 atomically; if insufficient,
                         // records the gap as 'uncollectible'
});
```

`settle_credits` is mutually exclusive with `charge_credits` for the same `generation_id`. Pick one settlement style per generation. Both are idempotent.

## Refunds & disputes (clawback)

When a customer disputes a charge or you refund a Stripe payment, the credits granted from that payment must be returned. The fortress handles this atomically and idempotently:

```typescript
// Wired automatically by createStripeWebhookHandler() for:
//   charge.refunded
//   charge.dispute.created

// Manual clawback:
const result = await fortress.clawback({
  accountId,
  amount: 50.0,
  idempotencyKey: 'refund:re_1Abc...',  // Stripe refund/dispute ID
  reason: 'stripe_refund',
});

// result.uncollectible > 0 means the customer already spent more than they owe back.
// The shortfall is logged as 'uncollectible' for accounting; balance never goes negative.

const owed = await fortress.getUncollectibleTotal(accountId);
if (owed > 0) {
  // Block further generations, send to collections, etc.
}
```

| Behavior | Detail |
|---|---|
| Idempotent | One clawback per `idempotencyKey` (use Stripe refund/dispute ID) |
| Never negative | Balance floors at 0; the gap is recorded as `uncollectible` |
| Atomic | Single `FOR UPDATE` serialized transaction |
| Auditable | Every clawback gets a ledger entry; uncollectible gets a separate entry |

## Credit alerts

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

## Crash recovery

One cron endpoint. Run it every 5 minutes:

```typescript
import { LedgerFortress } from 'ledger-fortress';

const fortress = new LedgerFortress({ databaseUrl: process.env.DATABASE_URL });

// Find reservations older than `windowMinutes` with no charge or refund
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

## Fail-open by design

| Failure | Behavior |
|---|---|
| Stripe webhook delayed | Credits already reserved - generation proceeds. Webhook reconciles later |
| Stripe down entirely | Existing credits work. New purchases queue in Stripe |
| Database slow | Reserve is a single atomic UPDATE - the fastest possible query |
| Crash recovery cron misses a cycle | Window is configurable, orphans wait for next cycle |
| Alert delivery fails | Fire-and-forget - never blocks generation. Retry on next reservation |

The settlement engine is **on the critical path** (it must be - you can't generate without credits). But it's exactly one atomic SQL statement. Everything else is eventually consistent.

## Production checklist

Before going live with real Stripe payments:

- [ ] Apply all four migrations (`001`, `002`, `003`, `004`)
- [ ] Confirm RLS is `ENABLED` and `FORCED` on all five tables (`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('plans','credits','credit_ledger','credit_alert_settings','credit_alert_log');`)
- [ ] Verify the `anon` role cannot read or write any fortress table via PostgREST (`curl ... | grep 42501`)
- [ ] Always call `verifyStripeSignature()` before passing events to the handler
- [ ] Subscribe your Stripe webhook to: `invoice.paid`, `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`
- [ ] Use a direct connection for migrations and a transaction-mode pooler (PgBouncer or PostgREST/Supavisor in transaction mode) for runtime. On Supabase specifically, that means session pooler (port 5432) for migrations and transaction pooler (port 6543) for runtime.
- [ ] Set `STRIPE_WEBHOOK_SECRET` from your Stripe webhook endpoint (not your API key)
- [ ] Schedule `recoverOrphans()` every 5 minutes via cron
- [ ] Map Stripe Price IDs into the `plans` table before enabling subscriptions
- [ ] Configure alert thresholds per account before exposing low-balance UI
- [ ] Cap `pg.Pool` connection limits well below your Postgres provider's connection cap (Supabase tiers cap at 60-500 depending on plan; default SDK setting is `max: 10`)
- [ ] Restrict your Stripe API key to the [permissions listed in `docs/stripe-integration.md`](docs/stripe-integration.md)
- [ ] Monitor `getUncollectibleTotal()` - non-zero values mean a customer owes credits (chargeback or true-up shortfall)
- [ ] For variable-cost models, use `settle()` instead of `charge()` and reserve the maximum estimate

## Status

`ledger-fortress` is **alpha** (v0.1.0). The pattern is battle-tested in [BabySea](https://babysea.ai)'s production stack serving 80+ AI models across 12+ labs. This repo packages and generalizes that pattern. APIs may change before 1.0. See [`CHANGELOG.md`](CHANGELOG.md).

Both the TypeScript and Python SDKs build. The TypeScript SDK ships with tests. Neither is published to npm/PyPI yet for 0.1; install from source or pin to a commit SHA.

## Roadmap

- [x] Atomic reserve ➜ charge ➜ refund lifecycle
- [x] Idempotent Stripe webhook reconciliation
- [x] Crash recovery for orphaned reservations
- [x] Credit alert state machine
- [x] TypeScript + Python SDKs
- [x] JSON schemas (event contract)
- [x] PostgreSQL migrations
- [ ] Redis cache layer for sub-ms `canGenerate()` checks
- [ ] Multi-currency credit types (image credits vs. video credits)
- [ ] Supabase Edge Function template for crash recovery
- [ ] Drizzle/Prisma schema generation from migrations
- [ ] Margin tracker (connect revenue to provider COGS via [adaptive-island](https://github.com/babysea-ai/adaptive-island))

## Who's using it

- 🌊 **[BabySea](https://babysea.ai)**: the execution control plane for generative media. 80+ image and video models from 12+ AI labs, settled through this exact pattern in production.

*Using `ledger-fortress`? Open a PR to add yourself.*

## Related projects

- 🏝️ **[adaptive-island](https://github.com/babysea-ai/adaptive-island)**: adaptive provider-selection engine for multi-vendor AI workloads, built on Databricks. Routes traffic to the right provider. `ledger-fortress` makes sure every generation is paid for.

## Contributing

We welcome PRs, issues, and design discussion. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE). Use it, fork it, ship it. Just keep the notice.

## Acknowledgements

Built on the shoulders of giants: **PostgreSQL** and **Stripe**, two of the most reliable pieces of infrastructure in production software. Thank you.
