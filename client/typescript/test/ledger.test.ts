import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerFortress } from '../src/index.js';

// Mock pg.Pool to test SDK logic without a real database.
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return {
    default: {
      Pool: vi.fn(() => ({
        query: mockQuery,
        end: mockEnd,
      })),
    },
    Pool: vi.fn(() => ({
      query: mockQuery,
      end: mockEnd,
    })),
  };
});

function getMockPool() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg');
  const instance = new pg.Pool();
  return instance;
}

describe('LedgerFortress', () => {
  let fortress: LedgerFortress;
  let mockPool: { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    fortress = new LedgerFortress({ databaseUrl: 'postgresql://test:test@localhost/test' });
    mockPool = getMockPool();
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

  describe('reserve', () => {
    it('returns true on successful reservation', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ reserve_credits: true }] });
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
      mockPool.query.mockResolvedValueOnce({ rows: [{ reserve_credits: false }] });
      const result = await fortress.reserve({
        accountId: 'acct_123',
        amount: 1000,
      });
      expect(result).toBe(false);
    });
  });

  describe('charge', () => {
    it('confirms a reservation', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ charge_credits: true }] });
      const result = await fortress.charge({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
        model: 'flux-schnell',
      });
      expect(result).toBe(true);
    });

    it('returns false for duplicate charge (idempotent)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ charge_credits: false }] });
      const result = await fortress.charge({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
      });
      expect(result).toBe(false);
    });
  });

  describe('refund', () => {
    it('returns credits on failure', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ refund_credits: true }] });
      const result = await fortress.refund({
        accountId: 'acct_123',
        generationId: 'gen_abc',
        amount: 0.062,
      });
      expect(result).toBe(true);
    });

    it('returns false if already charged (guard 1)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ refund_credits: false }] });
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
