# Stripe Integration Guide

`ledger-fortress` integrates with Stripe to convert subscription payments and credit pack purchases into spendable credits.

## Overview

```
Stripe                      ledger-fortress             Your App
  │                              │                        │
  │  invoice.paid                │                        │
  │ ───────────────────────────► │                        │
  │                              │  add_credits()         │
  │                              │  (idempotent via       │
  │                              │   invoice ID)          │
  │                              │                        │
  │  checkout.session.completed  │                        │
  │ ───────────────────────────► │                        │
  │                              │  add_credits()         │
  │                              │  (idempotent via       │
  │                              │   payment intent ID)   │
  │                              │                        │
  │                              │                        │  reserve()
  │                              │ ◄──────────────────────│
  │                              │                        │  ... generate ...
  │                              │                        │  charge() or refund()
  │                              │ ◄──────────────────────│
```

## Setup

### 1. Configure your plans

Map your Stripe Price IDs to credit allocations:

```sql
INSERT INTO plans (name, variant_id, tokens) VALUES
  ('Starter Monthly',    'price_1Abc...', 9.000),
  ('Starter Yearly',     'price_1Def...', 90.000),
  ('Pro Monthly',        'price_1Ghi...', 29.000),
  ('Pro Yearly',         'price_1Jkl...', 290.000),
  ('Credit Pack $10',    'price_1Mno...', 10.000),
  ('Credit Pack $50',    'price_1Pqr...', 50.000),
  ('Credit Pack $100',   'price_1Stu...', 100.000);
```

### 2. Set up the webhook handler

#### TypeScript (Next.js example)

```typescript
// app/api/stripe/webhook/route.ts
import Stripe from 'stripe';
import { LedgerFortress } from 'ledger-fortress';
import { createStripeWebhookHandler } from 'ledger-fortress/stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const fortress = new LedgerFortress({ databaseUrl: process.env.DATABASE_URL! });

const handler = createStripeWebhookHandler({
  fortress,
  stripeSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  resolveAccountId: async (customerId) => {
    // Your logic to map Stripe customer ➜ account
    const account = await db.accounts.findFirst({
      where: { stripeCustomerId: customerId },
    });
    return account?.id ?? null;
  },
  // Optional: guard credit pack purchases
  hasActiveSubscription: async (accountId) => {
    const sub = await db.subscriptions.findFirst({
      where: { accountId, status: 'active' },
    });
    return !!sub;
  },
});

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature')!;

  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  const result = await handler(event);
  return Response.json(result);
}
```

### 3. Handle the events

The webhook handler processes two Stripe events:

#### `invoice.paid`

Triggered when a subscription is created, renewed, or updated. The handler:

1. Extracts `amount_paid` from the invoice (cents)
2. Converts to credits (`amount/100`, since 1 credit = $1)
3. Calls `add_credits()` with idempotency key `invoice:{invoiceId}`
4. Resets any credit alert thresholds that are now above balance

Only subscription-related invoices are processed (`subscription_create`, `subscription_cycle`, `subscription_update`). Manual invoices are ignored.

#### `checkout.session.completed`

Triggered when a customer completes a one-time purchase (credit pack). The handler:

1. Checks that the session mode is `payment` (not `subscription`)
2. Optionally verifies the account has an active subscription (prevents stale checkout)
3. Converts `amount_total` to credits
4. Calls `add_credits()` with idempotency key `order:{paymentIntentId}`

### 4. Idempotency guarantees

Every `add_credits` call uses a unique idempotency key derived from the Stripe object ID:

| Event | Idempotency key |
|---|---|
| `invoice.paid` | `invoice:inv_xxx` |
| `checkout.session.completed` | `order:pi_xxx` |

The `idx_credit_ledger_add_idempotent` unique partial index ensures that even if Stripe retries the webhook 10 times, credits are granted exactly once. No double-crediting.

## Credit pack purchase guard

If you offer credit packs as one-time purchases, implement the `hasActiveSubscription` callback to prevent stale checkout redemption:

**Scenario:** User starts a credit pack checkout ➜ cancels their subscription ➜ completes the checkout. Without the guard, they'd get credits without an active subscription.

**With the guard:** `ledger-fortress` checks for an active subscription before granting credits. If none exists, the checkout is recorded but credits are not added.

## Rollover semantics

Credits are **additive**. When a subscription renews:

```
Before renewal: balance = $3.50 (leftover from last month)
invoice.paid:   add_credits($29.00)
After renewal:  balance = $32.50
```

Credits never reset. This is critical for credit pack purchases - a user who buys a $10 pack should never lose those credits on subscription renewal.
