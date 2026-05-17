/**
 * ledger-fortress TypeScript SDK.
 *
 * Atomic Stripe + Supabase credit ledger for async AI workloads.
 * Wraps the Supabase SQL functions with a type-safe interface.
 *
 * Copyright 2026 BabySea, Inc.
 * Licensed under the Apache License, Version 2.0.
 */
import pg from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LedgerFortressOptions {
  /** Supabase database connection string. */
  databaseUrl: string;
  /** pg.Pool options override. */
  poolOptions?: pg.PoolConfig;
}

export interface ReserveInput {
  accountId: string;
  generationId?: string;
  amount: number;
  model?: string;
}

export interface ChargeInput {
  accountId: string;
  generationId: string;
  amount: number;
  model?: string;
}

export interface RefundInput {
  accountId: string;
  generationId: string;
  amount: number;
  model?: string;
}

export interface AddCreditsInput {
  accountId: string;
  amount: number;
  description: string;
  idempotencyKey?: string;
}

export type CreditEventType = 'reserve' | 'charge' | 'refund' | 'add';

export interface LedgerEntry {
  id: string;
  type: CreditEventType;
  amount: number;
  balanceAfter: number;
  generationId: string | null;
  model: string | null;
  description: string | null;
  createdAt: Date;
}

export interface OrphanedReservation {
  ledgerId: string;
  accountId: string;
  generationId: string;
  amount: number;
  model: string | null;
  reservedAt: Date;
}

export interface RecoverResult {
  inspected: number;
  refunded: number;
  errors: number;
}

export interface AlertSettings {
  accountId: string;
  enabled?: boolean;
  thresholds?: number[];
  channels?: {
    inApp?: boolean;
    email?: boolean;
    webhook?: boolean;
  };
}

export interface AlertThreshold {
  threshold: number;
  balance: number;
}

export interface CreditEvent {
  schema_version: 'credit-event.v1';
  event_id: string;
  account_id: string;
  type: CreditEventType;
  amount: number;
  balance_after: number;
  generation_id: string | null;
  model: string | null;
  description: string | null;
  occurred_at: string;
}

function assertCreditAmount(
  amount: number,
  fieldName = 'amount',
  options?: { allowZero?: boolean },
): void {
  if (!Number.isFinite(amount)) {
    throw new Error(`ledger-fortress: ${fieldName} must be a finite number`);
  }

  if (options?.allowZero ? amount < 0 : amount <= 0) {
    throw new Error(
      `ledger-fortress: ${fieldName} must be ${options?.allowZero ? 'non-negative' : 'positive'}`,
    );
  }

  const scaled = amount * 1000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    throw new Error(
      `ledger-fortress: ${fieldName} must have at most 3 decimal places`,
    );
  }

  if (Math.abs(amount) > 9_999_999.999) {
    throw new Error(`ledger-fortress: ${fieldName} must be <= 9999999.999`);
  }
}

// ---------------------------------------------------------------------------
// LedgerFortress
// ---------------------------------------------------------------------------

export class LedgerFortress {
  private readonly pool: pg.Pool;

  constructor(opts: LedgerFortressOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.databaseUrl,
      // Pool sizing: enough headroom for concurrent reserves but not so large
      // that we exhaust Supabase pooler limits. Override via poolOptions.
      max: 10,
      // Close idle clients after 30s to free connections.
      idleTimeoutMillis: 30_000,
      // Fail fast if the database is unreachable instead of hanging the request.
      connectionTimeoutMillis: 10_000,
      // Hard ceiling on individual queries (prevents lock-up on stuck queries).
      statement_timeout: 30_000,
      // Idle-in-transaction timeout (prevents leaked transactions).
      idle_in_transaction_session_timeout: 60_000,
      ...opts.poolOptions,
    });

    // Surface pool errors instead of crashing the process silently.
    this.pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[ledger-fortress] pg pool error:', err);
    });
  }

  /**
   * Check if an account can afford a generation.
   * Pure read, no side effects.
   */
  async canGenerate(accountId: string, amount: number): Promise<boolean> {
    assertCreditAmount(amount);
    const result = await this.pool.query<{ has_credits: boolean }>(
      'SELECT has_credits($1, $2) AS has_credits',
      [accountId, amount],
    );
    return result.rows[0]?.has_credits ?? false;
  }

  /**
   * Get the current credit balance for an account.
   */
  async getBalance(accountId: string): Promise<number> {
    const result = await this.pool.query<{ get_balance: string }>(
      'SELECT get_balance($1) AS get_balance',
      [accountId],
    );
    return parseFloat(result.rows[0]?.get_balance ?? '0');
  }

  /**
   * Look up the configured credit allocation for a Stripe Price ID.
   * Useful from custom Stripe webhook credit resolvers.
   */
  async getPlanCredits(variantId: string): Promise<number | null> {
    const result = await this.pool.query<{ get_plan_credits: string | null }>(
      'SELECT get_plan_credits($1) AS get_plan_credits',
      [variantId],
    );
    const credits = result.rows[0]?.get_plan_credits;
    return credits === null || credits === undefined ? null : parseFloat(credits);
  }

  /**
   * Atomically reserve credits for a generation.
   * Returns true if the reservation succeeded, false if insufficient balance.
   *
   * This is a single `UPDATE ... WHERE credits >= cost` - no TOCTOU race.
   */
  async reserve(input: ReserveInput): Promise<boolean> {
    assertCreditAmount(input.amount);
    const result = await this.pool.query<{ reserve_credits: boolean }>(
      'SELECT reserve_credits($1, $2, $3, $4) AS reserve_credits',
      [
        input.accountId,
        input.amount,
        input.generationId ?? null,
        input.model ?? null,
      ],
    );
    return result.rows[0]?.reserve_credits ?? false;
  }

  /**
   * Confirm a reservation after successful generation.
    * Usually log-only: credits were already deducted at reserve time.
    * If a prior refund exists, the SQL function re-deducts the reserved amount first.
   *
   * Idempotent: second call for the same generation_id is a no-op.
   */
  async charge(input: ChargeInput): Promise<boolean> {
    assertCreditAmount(input.amount);
    const result = await this.pool.query<{ charge_credits: boolean }>(
      'SELECT charge_credits($1, $2, $3, $4) AS charge_credits',
      [
        input.accountId,
        input.amount,
        input.generationId,
        input.model ?? null,
      ],
    );
    return result.rows[0]?.charge_credits ?? false;
  }

  /**
   * Return reserved credits after a failed or cancelled generation.
   *
   * Guards:
   * - If already charged ➜ no-op (prevents free output)
   * - If already refunded ➜ no-op (prevents double-refund)
   *
   * Idempotent: safe to call from webhooks, crash recovery, and cancel endpoints.
   */
  async refund(input: RefundInput): Promise<boolean> {
    assertCreditAmount(input.amount);
    const result = await this.pool.query<{ refund_credits: boolean }>(
      'SELECT refund_credits($1, $2, $3, $4) AS refund_credits',
      [input.accountId, input.amount, input.generationId, input.model ?? null],
    );
    return result.rows[0]?.refund_credits ?? false;
  }

  /**
   * Grant credits from a Stripe invoice, credit pack, or manual grant.
   * Additive (rollover): always adds to existing balance, never resets.
   *
   * Idempotent: safe to call from Stripe webhook retries.
   */
  async addCredits(input: AddCreditsInput): Promise<boolean> {
    assertCreditAmount(input.amount);
    const result = await this.pool.query<{ add_credits: boolean }>(
      'SELECT add_credits($1, $2, $3, $4) AS add_credits',
      [
        input.accountId,
        input.amount,
        input.description,
        input.idempotencyKey ?? null,
      ],
    );
    return result.rows[0]?.add_credits ?? false;
  }

  /**
   * List ledger entries for an account.
   */
  async listLedger(
    accountId: string,
    options?: { type?: CreditEventType; limit?: number; offset?: number },
  ): Promise<LedgerEntry[]> {
    const result = await this.pool.query<{
      id: string;
      type: CreditEventType;
      amount: string;
      balance_after: string;
      generation_id: string | null;
      model: string | null;
      description: string | null;
      created_at: Date | string;
    }>('SELECT * FROM list_credit_ledger($1, $2, $3, $4)', [
      accountId,
      options?.type ?? null,
      options?.limit ?? 50,
      options?.offset ?? 0,
    ]);
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      amount: parseFloat(row.amount),
      balanceAfter: parseFloat(row.balance_after),
      generationId: row.generation_id,
      model: row.model,
      description: row.description,
      createdAt: new Date(row.created_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  /**
   * Find and refund orphaned reservations.
   * Call this from a cron job every ~5 minutes.
   */
  async recoverOrphans(options?: {
    windowMinutes?: number;
    limit?: number;
    onRecovered?: (generationId: string, accountId: string) => Promise<void>;
  }): Promise<RecoverResult> {
    const windowMinutes = options?.windowMinutes ?? 5;
    const limit = options?.limit ?? 100;

    const orphans = await this.pool.query<{
      ledger_id: string;
      account_id: string;
      generation_id: string;
      amount: string;
      model: string | null;
      reserved_at: Date;
    }>('SELECT * FROM find_orphaned_reservations($1, $2)', [
      windowMinutes,
      limit,
    ]);

    let refunded = 0;
    let errors = 0;

    for (const orphan of orphans.rows) {
      try {
        const success = await this.refund({
          accountId: orphan.account_id,
          generationId: orphan.generation_id,
          amount: parseFloat(orphan.amount),
          model: orphan.model ?? undefined,
        });

        if (success) {
          refunded++;
          if (options?.onRecovered) {
            await options.onRecovered(orphan.generation_id, orphan.account_id);
          }
        }
      } catch {
        errors++;
      }
    }

    return {
      inspected: orphans.rows.length,
      refunded,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Credit alerts
  // -------------------------------------------------------------------------

  /**
   * Check if any alert thresholds have been crossed.
   * Returns newly-crossed thresholds. Fire-and-forget: callers should not await.
   */
  async checkAlerts(accountId: string): Promise<AlertThreshold[]> {
    try {
      const result = await this.pool.query<{
        threshold: string;
        balance: string;
      }>('SELECT * FROM check_credit_alerts($1)', [accountId]);
      return result.rows.map((row) => ({
        threshold: parseFloat(row.threshold),
        balance: parseFloat(row.balance),
      }));
    } catch {
      return []; // fire-and-forget: never throw
    }
  }

  /**
   * Reset alert thresholds where balance has recovered.
   */
  async resetAlerts(accountId: string): Promise<number> {
    try {
      const result = await this.pool.query<{ reset_credit_alerts: number }>(
        'SELECT reset_credit_alerts($1) AS reset_credit_alerts',
        [accountId],
      );
      return result.rows[0]?.reset_credit_alerts ?? 0;
    } catch {
      return 0; // fire-and-forget: never throw
    }
  }

  /**
   * Configure alert settings for an account.
   */
  async setAlertSettings(settings: AlertSettings): Promise<void> {
    await this.pool.query(
      'SELECT upsert_credit_alert_settings($1, $2, $3, $4, $5, $6)',
      [
        settings.accountId,
        settings.enabled ?? true,
        settings.thresholds ?? [0.5],
        settings.channels?.inApp ?? true,
        settings.channels?.email ?? true,
        settings.channels?.webhook ?? false,
      ],
    );
  }

  /**
   * Get alert settings for an account (with defaults).
   */
  async getAlertSettings(accountId: string): Promise<{
    enabled: boolean;
    thresholds: number[];
    channels: { inApp: boolean; email: boolean; webhook: boolean };
  }> {
    const result = await this.pool.query(
      'SELECT * FROM get_credit_alert_settings($1)',
      [accountId],
    );
    const row = result.rows[0];
    return {
      enabled: row?.enabled ?? true,
      thresholds: (row?.thresholds ?? [0.5]).map(Number),
      channels: {
        inApp: row?.channel_in_app ?? true,
        email: row?.channel_email ?? true,
        webhook: row?.channel_webhook ?? false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Build a CreditEvent payload conforming to credit-event.v1.json schema.
   */
  buildEvent(entry: LedgerEntry & { accountId: string }): CreditEvent {
    return {
      schema_version: 'credit-event.v1',
      event_id: entry.id,
      account_id: entry.accountId,
      type: entry.type,
      amount: entry.amount,
      balance_after: entry.balanceAfter,
      generation_id: entry.generationId,
      model: entry.model,
      description: entry.description,
      occurred_at: entry.createdAt.toISOString(),
    };
  }

  /**
   * Gracefully close the connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
