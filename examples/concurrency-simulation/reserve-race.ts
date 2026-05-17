/**
 * Copyright 2026 BabySea, Inc.
 * Licensed under the Apache License, Version 2.0.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

type QueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

type PgPool = {
  query<Row = Record<string, unknown>>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  end(): Promise<void>;
};

type PgModule = {
  Pool: new (config: { connectionString: string; max: number }) => PgPool;
};

const requireFromTypeScriptClient = createRequire(
  new URL('../../client/typescript/package.json', import.meta.url),
);
const pg = requireFromTypeScriptClient('pg') as PgModule;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Refusing to run without an explicit test database.');
}

if (process.env.LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB !== '1') {
  throw new Error('Set LEDGER_FORTRESS_CONFIRM_DISPOSABLE_DB=1 to confirm this is a disposable test database.');
}

const accountId = randomUUID();
const attempts = Number(process.env.LEDGER_FORTRESS_RACE_ATTEMPTS ?? 100);
const initialBalance = Number(process.env.LEDGER_FORTRESS_RACE_BALANCE ?? 10);
const amount = Number(process.env.LEDGER_FORTRESS_RACE_AMOUNT ?? 1);
const keepRows = process.env.LEDGER_FORTRESS_RACE_KEEP === '1';

if (!Number.isInteger(attempts) || attempts <= 0) {
  throw new Error('LEDGER_FORTRESS_RACE_ATTEMPTS must be a positive integer.');
}

if (initialBalance <= 0 || amount <= 0) {
  throw new Error('LEDGER_FORTRESS_RACE_BALANCE and LEDGER_FORTRESS_RACE_AMOUNT must be positive.');
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: Math.min(attempts, 20) });

async function main(): Promise<void> {
  const generationPrefix = `race_${Date.now()}_`;
  const expectedSuccesses = Math.min(attempts, Math.floor(initialBalance / amount));

  try {
    await pool.query('insert into credits (account_id, credits) values ($1, $2)', [accountId, initialBalance]);

    const results = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        pool.query<{ reserve_credits: boolean }>(
          'select reserve_credits($1, $2, $3, $4) as reserve_credits',
          [accountId, amount, `${generationPrefix}${index}`, 'race-model'],
        ),
      ),
    );

    const successes = results.filter((result) => result.rows[0]?.reserve_credits).length;
    const balanceAfterRace = await getBalance(accountId);
    const reserveRows = await countLedgerRows(accountId, 'reserve', generationPrefix);

    if (successes !== expectedSuccesses) {
      throw new Error(`expected ${expectedSuccesses} successful reserves, got ${successes}`);
    }
    if (reserveRows !== expectedSuccesses) {
      throw new Error(`expected ${expectedSuccesses} reserve rows, got ${reserveRows}`);
    }
    if (balanceAfterRace !== initialBalance - expectedSuccesses * amount) {
      throw new Error(`unexpected balance after race: ${balanceAfterRace}`);
    }

    const orphans = await pool.query<{
      account_id: string;
      amount: string;
      generation_id: string;
      model: string | null;
    }>('select account_id, amount, generation_id, model from find_orphaned_reservations(0, $1) where account_id = $2 and generation_id like $3', [attempts, accountId, `${generationPrefix}%`]);

    for (const orphan of orphans.rows) {
      await pool.query('select refund_credits($1, $2, $3, $4)', [
        orphan.account_id,
        orphan.amount,
        orphan.generation_id,
        orphan.model,
      ]);
    }

    const balanceAfterRecovery = await getBalance(accountId);
    if (balanceAfterRecovery !== initialBalance) {
      throw new Error(`crash recovery should restore balance to ${initialBalance}, got ${balanceAfterRecovery}`);
    }

    console.log(JSON.stringify({
      ok: true,
      account_id: accountId,
      attempts,
      expected_successes: expectedSuccesses,
      successful_reserves: successes,
      balance_after_race: balanceAfterRace,
      orphaned_reservations_refunded: orphans.rowCount,
      balance_after_recovery: balanceAfterRecovery,
      rows_kept: keepRows,
    }, null, 2));
  } finally {
    if (!keepRows) {
      await pool.query('delete from credit_ledger where account_id = $1 and generation_id like $2', [accountId, 'race_%']);
      await pool.query('delete from credits where account_id = $1', [accountId]);
    }
    await pool.end();
  }
}

async function getBalance(accountId: string): Promise<number> {
  const result = await pool.query<{ get_balance: string }>('select get_balance($1) as get_balance', [accountId]);
  return Number(result.rows[0]?.get_balance ?? 0);
}

async function countLedgerRows(accountId: string, type: string, generationPrefix: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'select count(*)::text from credit_ledger where account_id = $1 and type = $2 and generation_id like $3',
    [accountId, type, `${generationPrefix}%`],
  );
  return Number(result.rows[0]?.count ?? 0);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
