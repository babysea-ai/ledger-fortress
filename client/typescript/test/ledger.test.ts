import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LedgerFortress } from '../src/index.js';

// Mock pg.Pool to test SDK logic without a real database.
const mockPool = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}));

vi.mock('pg', () => {
  class MockPool {
    query = mockPool.query;
    end = mockPool.end;
    on = mockPool.on;
  }

  return {
    default: {
      Pool: MockPool,
    },
    Pool: MockPool,
  };
});

describe('LedgerFortress', () => {
  let fortress: LedgerFortress;

  beforeEach(() => {
    mockPool.query.mockReset();
    mockPool.end.mockReset();
    mockPool.on.mockReset();
    fortress = new LedgerFortress({
      databaseUrl: 'postgresql://test:test@localhost/test',
    });
  });

  describe('canGenerate', () => {
    it('returns true when account has sufficient credits', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ has_credits: true }] });
      const result = await fortress.canGenerate('acct_123', 5.0);
      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT has_credits($1, $2) AS has_credits',
        ['acct_123', 5.0],
      );
    });

    it('returns false when account has insufficient credits', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ has_credits: false }] });
      const result = await fortress.canGenerate('acct_123', 100.0);
      expect(result).toBe(false);
    });
  });

  describe('getPlanCredits', () => {
    it('returns configured credits for a Stripe Price ID', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ get_plan_credits: '29.000' }],
      });

      const result = await fortress.getPlanCredits('price_123');

      expect(result).toBe(29);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT get_plan_credits($1) AS get_plan_credits',
        ['price_123'],
      );
    });

    it('returns null when a Stripe Price ID is not configured', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await fortress.getPlanCredits('price_missing');

      expect(result).toBeNull();
    });
  });

  describe('reserve', () => {
    it('returns true on successful reservation', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reserve_credits: true }],
      });
      const result = await fortress.reserve({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
        model: 'flux-schnell',
      });
      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT reserve_credits($1, $2, $3, $4) AS reserve_credits',
        ['acct_123', 0.062, 'gen_abc', 'flux-schnell'],
      );
    });

    it('returns false when balance insufficient', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reserve_credits: false }],
      });
      const result = await fortress.reserve({
        accountId: 'acct_123',
        amount: 1000,
      });
      expect(result).toBe(false);
    });

    it('rejects amounts with more than three decimals', async () => {
      await expect(
        fortress.reserve({
          accountId: 'acct_123',
          generationId: 'gen_precise',
          amount: 0.0625,
        }),
      ).rejects.toThrow('at most 3 decimal places');
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('rejects amounts outside NUMERIC(10,3) range', async () => {
      await expect(
        fortress.reserve({
          accountId: 'acct_123',
          generationId: 'gen_huge',
          amount: 10_000_000,
        }),
      ).rejects.toThrow('9999999.999');
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('charge', () => {
    it('confirms a reservation', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ status: 'charged', uncollectible: '0' }],
      });
      const result = await fortress.charge({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
        model: 'flux-schnell',
      });
      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM charge_credits_detailed($1, $2, $3, $4)',
        ['acct_123', 0.062, 'gen_abc', 'flux-schnell'],
      );
    });

    it('returns false for duplicate charge (idempotent)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ status: 'duplicate', uncollectible: '0' }],
      });
      const result = await fortress.charge({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
      });
      expect(result).toBe(false);
    });

    it('returns structured shortfall status for late charge debt', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ status: 'shortfall', uncollectible: '0.300' }],
      });

      const result = await fortress.chargeDetailed({
        accountId: 'acct_123',
        generationId: 'gen_late',
        amount: 0.5,
      });

      expect(result).toEqual({
        status: 'shortfall',
        charged: false,
        uncollectible: 0.3,
      });
    });
  });

  describe('refund', () => {
    it('returns credits on failure', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ refund_credits: true }],
      });
      const result = await fortress.refund({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
      });
      expect(result).toBe(true);
    });

    it('returns false if already charged (guard 1)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ refund_credits: false }],
      });
      const result = await fortress.refund({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
      });
      expect(result).toBe(false);
    });
  });

  describe('addCredits', () => {
    it('adds credits with idempotency key', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ add_credits: true }] });
      const result = await fortress.addCredits({
        accountId: 'acct_123',
        amount: 29.0,
        description: 'Pro Monthly',
        idempotencyKey: 'invoice:inv_xxx',
      });
      expect(result).toBe(true);
    });

    it('returns false for duplicate add (idempotent)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ add_credits: false }] });
      const result = await fortress.addCredits({
        accountId: 'acct_123',
        amount: 29.0,
        description: 'Pro Monthly',
        idempotencyKey: 'invoice:inv_xxx',
      });
      expect(result).toBe(false);
    });
  });

  describe('clawback', () => {
    it('returns applied and uncollectible amount', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ applied: true, uncollectible: '38.000' }],
      });

      const result = await fortress.clawback({
        accountId: 'acct_123',
        amount: 50,
        idempotencyKey: 'refund:re_123',
      });

      expect(result).toEqual({ applied: true, uncollectible: 38 });
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM clawback_credits($1, $2, $3, $4)',
        ['acct_123', 50, 'refund:re_123', 'stripe_refund'],
      );
    });

    it('returns applied false for duplicate clawback events', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ applied: false, uncollectible: '0' }],
      });

      const result = await fortress.clawback({
        accountId: 'acct_123',
        amount: 50,
        idempotencyKey: 'refund:re_123',
      });

      expect(result).toEqual({ applied: false, uncollectible: 0 });
    });
  });

  describe('recoverOrphans', () => {
    it('finds and refunds orphaned reservations', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              ledger_id: 'lid_1',
              account_id: 'acct_123',
              generation_id: 'gen_orphan',
              amount: '0.062',
              model: 'flux-schnell',
              reserved_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ refund_credits: true }] });

      const onRecovered = vi.fn();
      const result = await fortress.recoverOrphans({ onRecovered });

      expect(result.inspected).toBe(1);
      expect(result.refunded).toBe(1);
      expect(result.errors).toBe(0);
      expect(onRecovered).toHaveBeenCalledWith('gen_orphan', 'acct_123');
    });
  });

  describe('buildEvent', () => {
    it('builds a credit-event.v1 payload', () => {
      const event = fortress.buildEvent({
        id: 'evt_123',
        accountId: 'acct_123',
        type: 'reserve',
        amount: 0.062,
        balanceAfter: 9.938,
        generationId: 'gen_abc',
        model: 'flux-schnell',
        description: null,
        createdAt: new Date('2026-04-30T00:00:00Z'),
      });

      expect(event.schema_version).toBe('credit-event.v1');
      expect(event.type).toBe('reserve');
      expect(event.amount).toBe(0.062);
      expect(event.balance_after).toBe(9.938);
    });
  });
});
