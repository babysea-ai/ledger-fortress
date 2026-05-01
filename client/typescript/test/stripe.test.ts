import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerFortress } from '../src/index.js';
import { type StripeEvent, createStripeWebhookHandler } from '../src/stripe.js';

const fortress = {
  addCredits: vi.fn(),
  resetAlerts: vi.fn(),
  clawback: vi.fn(),
} as unknown as LedgerFortress;

const addCredits = fortress.addCredits as ReturnType<typeof vi.fn>;
const resetAlerts = fortress.resetAlerts as ReturnType<typeof vi.fn>;
const clawback = fortress.clawback as ReturnType<typeof vi.fn>;

describe('Stripe webhook handler', () => {
  beforeEach(() => {
    addCredits.mockReset().mockResolvedValue(true);
    resetAlerts.mockReset().mockResolvedValue(0);
    clawback.mockReset().mockResolvedValue({ applied: true, uncollectible: 0 });
  });

  it('uses a custom invoice credit resolver when provided', async () => {
    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async () => 'acct_123',
      resolveInvoiceCredits: async () => 29,
    });

    const event: StripeEvent = {
      type: 'invoice.paid',
      data: {
        object: {
          id: 'inv_123',
          customer: 'cus_123',
          amount_paid: 1900,
          billing_reason: 'subscription_cycle',
        },
      },
    };

    const result = await handler(event);

    expect(result.action).toBe('credits_added');
    expect(result.amount).toBe(29);
    expect(addCredits).toHaveBeenCalledWith({
      accountId: 'acct_123',
      amount: 29,
      description: 'invoice:inv_123',
      idempotencyKey: 'invoice:inv_123',
    });
  });

  it('uses custom invoice credits even when amount_paid is zero', async () => {
    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async () => 'acct_123',
      resolveInvoiceCredits: async () => 29,
    });

    const event: StripeEvent = {
      type: 'invoice.paid',
      data: {
        object: {
          id: 'inv_zero',
          customer: 'cus_123',
          amount_paid: 0,
          billing_reason: 'subscription_cycle',
        },
      },
    };

    const result = await handler(event);

    expect(result.action).toBe('credits_added');
    expect(result.amount).toBe(29);
    expect(addCredits).toHaveBeenCalledWith({
      accountId: 'acct_123',
      amount: 29,
      description: 'invoice:inv_zero',
      idempotencyKey: 'invoice:inv_zero',
    });
  });

  it('uses custom checkout credits even when amount_total is zero', async () => {
    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async () => 'acct_123',
      resolveCheckoutCredits: async () => 10,
    });

    const event: StripeEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_zero',
          customer: 'cus_123',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 0,
        },
      },
    };

    const result = await handler(event);

    expect(result.action).toBe('credits_added');
    expect(result.amount).toBe(10);
    expect(addCredits).toHaveBeenCalledWith({
      accountId: 'acct_123',
      amount: 10,
      description: 'order:cs_zero',
      idempotencyKey: 'order:cs_zero',
    });
  });

  it('skips unpaid checkout sessions', async () => {
    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async () => 'acct_123',
    });

    const event: StripeEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          customer: 'cus_123',
          mode: 'payment',
          payment_status: 'unpaid',
          amount_total: 1000,
        },
      },
    };

    const result = await handler(event);

    expect(result.action).toBe('skipped_unrelated');
    expect(addCredits).not.toHaveBeenCalled();
  });

  it('reports duplicate refund clawbacks as skipped duplicates', async () => {
    clawback.mockResolvedValueOnce({ applied: false, uncollectible: 0 });

    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async () => 'acct_123',
    });

    const event: StripeEvent = {
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_123',
          customer: 'cus_123',
          refunds: { data: [{ id: 're_123', amount: 500 }] },
        },
      },
    };

    const result = await handler(event);

    expect(result.action).toBe('skipped_duplicate');
    expect(result.idempotencyKey).toBe('refund:re_123');
  });
});
