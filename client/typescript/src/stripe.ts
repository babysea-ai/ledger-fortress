/**
 * ledger-fortress Stripe webhook integration.
 *
 * Ready-to-use handlers for Stripe webhook events that reconcile
 * subscriptions and credit pack purchases into the ledger.
 *
 * Copyright 2026 BabySea, Inc.
 * Licensed under the Apache License, Version 2.0.
 */
import type { LedgerFortress } from './index.js';

// Lazy import: stripe is a peer dependency. Only required if you call
// verifyStripeSignature(). The webhook handler itself works with any source
// of validated StripeEvent objects.
type StripeLike = {
  webhooks: {
    constructEvent: (
      payload: string | Buffer,
      header: string,
      secret: string,
    ) => unknown;
  };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StripeWebhookHandlerOptions {
  /** LedgerFortress instance. */
  fortress: LedgerFortress;
  /** Map a Stripe customer ID to your account ID. */
  resolveAccountId: (customerId: string) => Promise<string | null>;
  /** Optional: map a Stripe charge ID to your account ID for unexpanded dispute events. */
  resolveChargeAccountId?: (chargeId: string) => Promise<string | null>;
  /**
   * Optional: override invoice-to-credit conversion.
   * Return null/undefined to skip credit allocation for this invoice.
   * Runs before the default amount_paid/100 path, including zero-amount invoices.
   */
  resolveInvoiceCredits?: (
    invoice: Record<string, unknown>,
  ) => Promise<number | null | undefined>;
  /**
   * Optional: override checkout-session-to-credit conversion.
   * Return null/undefined to skip credit allocation for this checkout.
   * Runs before the default amount_total/100 path, including zero-amount checkouts.
   */
  resolveCheckoutCredits?: (
    session: Record<string, unknown>,
  ) => Promise<number | null | undefined>;
  /**
   * Optional: check if an account has an active subscription.
   * Used to guard credit pack purchases (prevent stale checkout redemption).
   */
  hasActiveSubscription?: (accountId: string) => Promise<boolean>;
}

export interface WebhookResult {
  handled: boolean;
  action?:
    | 'credits_added'
    | 'credits_clawed_back'
    | 'skipped_duplicate'
    | 'skipped_no_account'
    | 'skipped_no_subscription'
    | 'skipped_unrelated';
  amount?: number;
  /** Amount that could not be deducted on clawback (account didn't have enough balance). */
  uncollectible?: number;
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a Stripe webhook handler that reconciles invoice payments
 * and checkout sessions into credit grants.
 *
 * Usage in a route handler:
 * ```typescript
 * const handler = createStripeWebhookHandler({ fortress, stripeSecret, resolveAccountId });
 * const result = await handler(event);
 * ```
 */
export function createStripeWebhookHandler(
  opts: StripeWebhookHandlerOptions,
): (event: StripeEvent) => Promise<WebhookResult> {
  return async (event: StripeEvent): Promise<WebhookResult> => {
    switch (event.type) {
      case 'invoice.paid':
        return handleInvoicePaid(event, opts);
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return handleCheckoutCompleted(event, opts);
      case 'charge.refunded':
        return handleChargeRefunded(event, opts);
      case 'charge.dispute.created':
        return handleChargeDispute(event, opts);
      default:
        return { handled: false };
    }
  };
}

// ---------------------------------------------------------------------------
// Stripe event types (minimal, no dependency on stripe package at runtime)
// ---------------------------------------------------------------------------

export interface StripeEvent {
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies a Stripe webhook signature and returns the parsed event.
 * Throws if the signature is invalid.
 *
 * MUST be called with the RAW request body (Buffer or string), NOT the
 * JSON-parsed body. Frameworks like Next.js may parse the body by default;
 * disable that for the webhook route.
 *
 * @example
 * ```ts
 * import Stripe from 'stripe';
 * import { verifyStripeSignature, createStripeWebhookHandler } from 'ledger-fortress/stripe';
 *
 * const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
 * const handler = createStripeWebhookHandler({ fortress, resolveAccountId });
 *
 * export async function POST(req: Request) {
 *   const payload = await req.text();
 *   const sig = req.headers.get('stripe-signature')!;
 *   const event = verifyStripeSignature(stripe, payload, sig, process.env.STRIPE_WEBHOOK_SECRET!);
 *   const result = await handler(event);
 *   return Response.json(result);
 * }
 * ```
 */
export function verifyStripeSignature(
  stripe: StripeLike,
  payload: string | Buffer,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
): StripeEvent {
  if (!signatureHeader) {
    throw new Error('ledger-fortress: missing stripe-signature header');
  }
  if (!webhookSecret) {
    throw new Error('ledger-fortress: missing webhookSecret');
  }
  // Stripe's constructEvent throws on invalid signature.
  // It uses HMAC-SHA256 with timestamp tolerance (default 5 minutes)
  // to prevent replay attacks.
  return stripe.webhooks.constructEvent(
    payload,
    signatureHeader,
    webhookSecret,
  ) as StripeEvent;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInvoicePaid(
  event: StripeEvent,
  opts: StripeWebhookHandlerOptions,
): Promise<WebhookResult> {
  const invoice = event.data.object;

  // Only handle subscription invoices (not manual invoices).
  const billingReason = invoice.billing_reason as string | undefined;
  const subscriptionReasons = [
    'subscription_create',
    'subscription_cycle',
    'subscription_update',
  ];
  if (!billingReason || !subscriptionReasons.includes(billingReason)) {
    return { handled: false };
  }

  const customerId = invoice.customer as string;
  const invoiceId = invoice.id as string;
  const amountPaid = invoice.amount_paid as number | undefined; // cents

  if (!customerId || !invoiceId) {
    return { handled: false };
  }

  const accountId = await opts.resolveAccountId(customerId);
  if (!accountId) {
    return { handled: true, action: 'skipped_no_account' };
  }

  // Convert cents to credits (1 credit = $1 = 100 cents) unless the adopter
  // supplies a custom resolver for plan-token mapping or non-USD products.
  const resolvedCredits = opts.resolveInvoiceCredits
    ? await opts.resolveInvoiceCredits(invoice)
    : typeof amountPaid === 'number' && amountPaid > 0
      ? amountPaid / 100
      : null;

  if (!resolvedCredits || resolvedCredits <= 0) {
    return { handled: true, action: 'skipped_unrelated' };
  }

  const credits = resolvedCredits;
  const idempotencyKey = `invoice:${invoiceId}`;

  const added = await opts.fortress.addCredits({
    accountId,
    amount: credits,
    description: idempotencyKey,
    idempotencyKey,
  });

  if (added) {
    // Reset alerts after adding credits (fire-and-forget).
    opts.fortress.resetAlerts(accountId).catch(() => {});
  }

  return {
    handled: true,
    action: added ? 'credits_added' : 'skipped_duplicate',
    amount: credits,
    idempotencyKey,
  };
}

async function handleCheckoutCompleted(
  event: StripeEvent,
  opts: StripeWebhookHandlerOptions,
): Promise<WebhookResult> {
  const session = event.data.object;

  // Only handle payment mode (credit packs), not subscription mode.
  const mode = session.mode as string;
  if (mode !== 'payment') {
    return { handled: false };
  }

  const customerId = session.customer as string;
  const amountTotal = session.amount_total as number | undefined; // cents
  const paymentStatus = session.payment_status as string | undefined;

  if (!customerId) {
    return { handled: false };
  }

  if (paymentStatus && paymentStatus !== 'paid') {
    return { handled: true, action: 'skipped_unrelated' };
  }

  const accountId = await opts.resolveAccountId(customerId);
  if (!accountId) {
    return { handled: true, action: 'skipped_no_account' };
  }

  // Optional: guard against stale checkout sessions.
  if (opts.hasActiveSubscription) {
    const active = await opts.hasActiveSubscription(accountId);
    if (!active) {
      return { handled: true, action: 'skipped_no_subscription' };
    }
  }

  // Use payment_intent or session id as idempotency key.
  const paymentIntent =
    (session.payment_intent as string) || (session.id as string);
  const resolvedCredits = opts.resolveCheckoutCredits
    ? await opts.resolveCheckoutCredits(session)
    : typeof amountTotal === 'number' && amountTotal > 0
      ? amountTotal / 100
      : null;

  if (!resolvedCredits || resolvedCredits <= 0) {
    return { handled: true, action: 'skipped_unrelated' };
  }

  const credits = resolvedCredits;
  const idempotencyKey = `order:${paymentIntent}`;

  const added = await opts.fortress.addCredits({
    accountId,
    amount: credits,
    description: idempotencyKey,
    idempotencyKey,
  });

  if (added) {
    opts.fortress.resetAlerts(accountId).catch(() => {});
  }

  return {
    handled: true,
    action: added ? 'credits_added' : 'skipped_duplicate',
    amount: credits,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// charge.refunded handler
// ---------------------------------------------------------------------------

/**
 * Stripe issues `charge.refunded` when a charge is fully or partially refunded.
 * We claw back credits for the latest individual refund object.
 *
 * Idempotent via the refund ID. If the refunded charge can't be mapped to an
 * account (no Stripe customer attached), we skip and log.
 */
async function handleChargeRefunded(
  event: StripeEvent,
  opts: StripeWebhookHandlerOptions,
): Promise<WebhookResult> {
  const charge = event.data.object;
  const customerId = charge.customer as string | null;
  const refunds = charge.refunds as
    | { data?: Array<{ id: string; amount?: number }> }
    | undefined;
  const latestRefund = refunds?.data?.[0];

  if (!customerId || !latestRefund?.id || !latestRefund.amount) {
    return { handled: true, action: 'skipped_unrelated' };
  }

  const accountId = await opts.resolveAccountId(customerId);
  if (!accountId) {
    return { handled: true, action: 'skipped_no_account' };
  }

  const credits = latestRefund.amount / 100;
  const idempotencyKey = `refund:${latestRefund.id}`;

  const result = await opts.fortress.clawback({
    accountId,
    amount: credits,
    idempotencyKey,
    reason: 'stripe_refund',
  });

  if (!result.applied) {
    return {
      handled: true,
      action: 'skipped_duplicate',
      amount: credits,
      uncollectible: result.uncollectible,
      idempotencyKey,
    };
  }

  return {
    handled: true,
    action: 'credits_clawed_back',
    amount: credits,
    uncollectible: result.uncollectible,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// charge.dispute.created handler
// ---------------------------------------------------------------------------

/**
 * Stripe issues `charge.dispute.created` when a customer files a chargeback.
 * The disputed amount is held by Stripe and the charge is functionally refunded.
 * We claw back the disputed amount immediately.
 *
 * For high-risk businesses, you may want to:
 * - Block the account from further generations (use `getUncollectibleTotal`)
 * - Notify your fraud team
 * - Pause the customer's subscription
 */
async function handleChargeDispute(
  event: StripeEvent,
  opts: StripeWebhookHandlerOptions,
): Promise<WebhookResult> {
  const dispute = event.data.object;
  const charge = dispute.charge as { customer?: string } | string | undefined;
  const customerId =
    typeof charge === 'object' && charge !== null
      ? (charge.customer as string | undefined)
      : undefined;
  const chargeId = typeof charge === 'string' ? charge : undefined;
  const amount = dispute.amount as number; // cents
  const disputeId = dispute.id as string;

  if ((!customerId && !chargeId) || !amount || amount <= 0 || !disputeId) {
    return { handled: true, action: 'skipped_unrelated' };
  }

  const accountId = customerId
    ? await opts.resolveAccountId(customerId)
    : opts.resolveChargeAccountId
      ? await opts.resolveChargeAccountId(chargeId!)
      : null;
  if (!accountId) {
    return { handled: true, action: 'skipped_no_account' };
  }

  const credits = amount / 100;
  const idempotencyKey = `dispute:${disputeId}`;

  const result = await opts.fortress.clawback({
    accountId,
    amount: credits,
    idempotencyKey,
    reason: 'stripe_dispute',
  });

  if (!result.applied) {
    return {
      handled: true,
      action: 'skipped_duplicate',
      amount: credits,
      uncollectible: result.uncollectible,
      idempotencyKey,
    };
  }

  return {
    handled: true,
    action: 'credits_clawed_back',
    amount: credits,
    uncollectible: result.uncollectible,
    idempotencyKey,
  };
}
