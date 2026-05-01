/**
 * ledger-fortress TypeScript SDK demo.
 *
 * Demonstrates the full credit lifecycle:
 * reserve ➜ async generation ➜ charge (success) or refund (failure).
 *
 * Prerequisites:
 *   psql "$DATABASE_URL" < ../../migrations/001_credits.sql
 *   psql "$DATABASE_URL" < ../../migrations/002_credit_alerts.sql
 *
 * Run:
 *   DATABASE_URL=postgresql://... npx tsx demo.ts
 */

import { LedgerFortress } from 'ledger-fortress';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL environment variable.');
  process.exit(1);
}

async function main() {
  const fortress = new LedgerFortress({ databaseUrl: DATABASE_URL! });

  const accountId = '00000000-0000-0000-0000-000000000001';
  const model = 'flux-schnell';
  const cost = 0.062;

  // -------------------------------------------------------------------------
  // 1. Grant credits (idempotent - safe to run multiple times)
  // -------------------------------------------------------------------------
  console.log('\n--- Step 1: Add $10 credits ---');
  const added = await fortress.addCredits({
    accountId,
    amount: 10.0,
    description: 'Demo grant',
    idempotencyKey: 'demo:initial-grant',
  });
  console.log(`  add_credits: ${added ? 'granted' : 'already granted (idempotent)'}`);

  const balance = await fortress.getBalance(accountId);
  console.log(`  balance: $${balance.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // 2. Reserve credits for a generation
  // -------------------------------------------------------------------------
  console.log('\n--- Step 2: Reserve credits ---');
  const generationId = `gen_${Date.now()}`;
  const canAfford = await fortress.canGenerate(accountId, cost);
  console.log(`  can_generate($${cost}): ${canAfford}`);

  const reserved = await fortress.reserve({
    accountId,
    generationId,
    amount: cost,
    model,
  });
  console.log(`  reserve: ${reserved ? 'success' : 'insufficient balance'}`);

  const balanceAfterReserve = await fortress.getBalance(accountId);
  console.log(`  balance after reserve: $${balanceAfterReserve.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // 3. Simulate async generation (2 seconds)
  // -------------------------------------------------------------------------
  console.log('\n--- Step 3: Generating... ---');
  const success = Math.random() > 0.3; // 70% success rate
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`  generation result: ${success ? 'SUCCESS' : 'FAILED'}`);

  // -------------------------------------------------------------------------
  // 4. Settle: charge on success, refund on failure
  // -------------------------------------------------------------------------
  console.log('\n--- Step 4: Settle ---');
  if (success) {
    const charged = await fortress.charge({
      accountId,
      generationId,
      amount: cost,
      model,
    });
    console.log(`  charge: ${charged ? 'confirmed' : 'already charged (idempotent)'}`);

    // Try charging again - should be idempotent no-op
    const chargedAgain = await fortress.charge({
      accountId,
      generationId,
      amount: cost,
      model,
    });
    console.log(`  charge (retry): ${chargedAgain ? 'confirmed' : 'no-op (idempotent)'}`);
  } else {
    const refunded = await fortress.refund({
      accountId,
      generationId,
      amount: cost,
      model,
    });
    console.log(`  refund: ${refunded ? 'returned' : 'already refunded (idempotent)'}`);

    // Try refunding again - should be idempotent no-op
    const refundedAgain = await fortress.refund({
      accountId,
      generationId,
      amount: cost,
      model,
    });
    console.log(`  refund (retry): ${refundedAgain ? 'returned' : 'no-op (idempotent)'}`);
  }

  const finalBalance = await fortress.getBalance(accountId);
  console.log(`  final balance: $${finalBalance.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // 5. Show ledger history
  // -------------------------------------------------------------------------
  console.log('\n--- Step 5: Ledger history ---');
  const ledger = await fortress.listLedger(accountId, { limit: 10 });
  for (const entry of ledger) {
    const sign = entry.type === 'reserve' ? '-' : '+';
    console.log(
      `  ${entry.type.padEnd(8)} ${sign}$${entry.amount.toFixed(3).padStart(7)} ➜ $${entry.balanceAfter.toFixed(3).padStart(7)}  ${entry.model ?? entry.description ?? ''}`,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Crash recovery
  // -------------------------------------------------------------------------
  console.log('\n--- Step 6: Crash recovery ---');
  const recovered = await fortress.recoverOrphans({
    windowMinutes: 5,
    onRecovered: async (genId: string, acctId: string) => {
      console.log(`  recovered orphan: ${genId} for account ${acctId}`);
    },
  });
  console.log(`  inspected: ${recovered.inspected}, refunded: ${recovered.refunded}, errors: ${recovered.errors}`);

  // -------------------------------------------------------------------------
  // 7. Credit alerts
  // -------------------------------------------------------------------------
  console.log('\n--- Step 7: Credit alerts ---');
  await fortress.setAlertSettings({
    accountId,
    thresholds: [5.0, 1.0, 0.5],
    channels: { inApp: true, email: true, webhook: false },
  });
  const alerts = await fortress.checkAlerts(accountId);
  if (alerts.length > 0) {
    for (const alert of alerts) {
      console.log(`  ALERT: balance $${alert.balance.toFixed(3)} crossed threshold $${alert.threshold.toFixed(3)}`);
    }
  } else {
    console.log('  no new alerts');
  }

  console.log('\n✓ Demo complete.\n');
  await fortress.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
