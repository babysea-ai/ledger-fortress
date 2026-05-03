# Stripe Integration Guide

`ledger-fortress` integrates with Stripe to convert subscription payments and credit pack purchases into spendable credits stored in Supabase/Postgres.

## Overview

```
Stripe                      ledger-fortress             Your App
  │                              │                        │
  │  invoice.paid                │                        │
  │ ───────────────────────────► │                        │
  │                              │  Supabase RPC          │
  │                              │  add_credits()         │
  │                              │  (idempotent via       │
  │                              │   invoice ID)          │
  │                              │                        │
  │  checkout.session.completed  │                        │
  │ ───────────────────────────► │                        │
  │                              │  Supabase RPC          │
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
import { createStripeWebhookHandler, verifyStripeSignature } from 'ledger-fortress/stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const fortress = new LedgerFortress({ databaseUrl: process.env.SUPABASE_DATABASE_URL! });

const handler = createStripeWebhookHandler({
  fortress,
  resolveAccountId: async (customerId) => {
    // Your logic to map Stripe customer ➜ account
    const account = await db.accounts.findFirst({
      where: { stripeCustomerId: customerId },
    });
    return account?.id ?? null;
  },
  // Optional: useful when charge.dispute.created carries an unexpanded charge ID.
  resolveChargeAccountId: async (chargeId) => {
    const payment = await db.payments.findFirst({
      where: { stripeChargeId: chargeId },
    });
    return payment?.accountId ?? null;
  },
  // Optional: use get_plan_credits()/plans.tokens instead of amount_paid/100.
  resolveInvoiceCredits: async (invoice) => {
    const line = (invoice.lines as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data?.[0];
    const priceId = line?.price?.id;
    return priceId ? fortress.getPlanCredits(priceId) : null;
  },
  // Optional: same idea for fixed-credit one-time packs.
  resolveCheckoutCredits: async (session) => {
    const line = (session.line_items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data?.[0];
    const priceId = line?.price?.id;
    return priceId ? fortress.getPlanCredits(priceId) : null;
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

  const event = verifyStripeSignature(
    stripe,
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  const result = await handler(event);
  return Response.json(result);
}
```

### 3. Handle the events

The webhook handler processes four Stripe events. In production, pass only events that were verified with Stripe's raw-body signature verification.

#### `invoice.paid`

Triggered when a subscription is created, renewed, or updated. The handler:

1. Extracts `amount_paid` from the invoice (cents)
2. Converts to credits (`amount/100`, since 1 credit = $1) by default, or calls `resolveInvoiceCredits` if provided. Custom resolvers run even when `amount_paid` is zero.
3. Calls `add_credits()` with idempotency key `invoice:{invoiceId}`
4. Resets any credit alert thresholds that are now above balance

Only subscription-related invoices are processed (`subscription_create`, `subscription_cycle`, `subscription_update`). Manual invoices are ignored.

#### `checkout.session.completed`

Triggered when a customer completes a one-time purchase (credit pack). The handler:

1. Checks that the session mode is `payment` (not `subscription`)
2. Requires `payment_status === 'paid'` when Stripe includes that field
3. Optionally verifies the account has an active subscription (prevents stale checkout)
4. Converts `amount_total` to credits by default, or calls `resolveCheckoutCredits` if provided. Custom resolvers run even when `amount_total` is zero.
5. Calls `add_credits()` with idempotency key `order:{paymentIntentId}`

For asynchronous payment methods, also subscribe to `checkout.session.async_payment_succeeded`; it runs through the same paid checkout handler.

#### `charge.refunded`

Triggered when Stripe records a full or partial refund. The handler:

1. Reads the latest refund object from the charge payload
2. Converts the individual refund amount to credits
3. Calls `clawback_credits()` with idempotency key `refund:{refundId}`
4. Returns `skipped_duplicate` when the same refund was already processed

#### `charge.dispute.created`

Triggered when a customer disputes a charge. The handler:

1. Maps the expanded charge customer to an account, or uses `resolveChargeAccountId` for unexpanded charge IDs
2. Converts the disputed amount to credits
3. Calls `clawback_credits()` with idempotency key `dispute:{disputeId}`
4. Records any balance shortfall as `uncollectible` instead of letting the balance go negative

### 4. Idempotency guarantees

Every `add_credits` call uses a unique idempotency key derived from the Stripe object ID:

| Event | Idempotency key |
|---|---|
| `invoice.paid` | `invoice:inv_xxx` |
| `checkout.session.completed` | `order:pi_xxx` |
| `charge.refunded` | `refund:re_xxx` |
| `charge.dispute.created` | `dispute:dp_xxx` |

The `idx_credit_ledger_add_idempotent` and `idx_credit_ledger_clawback_idempotent` unique partial indexes ensure that even if Stripe retries the webhook 10 times, credits are granted or clawed back exactly once.

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

## Amount-based vs plan-based grants

The default handler grants credits from the amount Stripe says was actually paid. This matches products where `1 credit = $1 paid` and handles discounts, prorations, and taxes according to the final Stripe amount.

If your product grants a fixed number of credits per Stripe Price ID, use `resolveInvoiceCredits` or `resolveCheckoutCredits` and look up `plans.tokens` through the hardened `get_plan_credits()` boundary with `fortress.getPlanCredits(priceId)`. Return `null` to skip allocation when the event does not contain the price metadata you require.

Custom resolvers are evaluated before the default amount-based fallback, so fixed-credit plans still work for 100% discounts, trials, migration credits, or custom enterprise contracts where the Stripe amount can be zero.
