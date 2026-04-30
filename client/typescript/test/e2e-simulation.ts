/**
 * ledger-fortress E2E Simulation
 *
 * Tests the full credit lifecycle against a real Supabase Postgres database
 * and real Stripe test-mode API. Verifies every edge case the fortress handles.
 *
 * Usage:
 *   npx tsx test/e2e-simulation.ts
 *
 * Required env:
 *   DATABASE_URL   - Supabase session pooler URL
 *   STRIPE_SECRET  - Stripe test-mode restricted key
 */

import { LedgerFortress } from '../src/index.js';
import { createStripeWebhookHandler, verifyStripeSignature, type StripeEvent } from '../src/stripe.js';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL!;
const STRIPE_SECRET = process.env.STRIPE_SECRET!;

if (!DATABASE_URL || !STRIPE_SECRET) {
  console.error('Missing DATABASE_URL or STRIPE_SECRET');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2025-04-30.basil' as Stripe.LatestApiVersion });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passCount++;
    console.log(`  PASS: ${label}`);
  } else {
    failCount++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertClose(actual: number, expected: number, label: string, tolerance = 0.001) {
  assert(Math.abs(actual - expected) < tolerance, `${label} (got ${actual}, expected ${expected})`);
}

const testAccountId = '10000000-0000-0000-0000-000000000001';
const testAccountId2 = '20000000-0000-0000-0000-000000000002';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n========================================');
  console.log('  ledger-fortress E2E Simulation');
  console.log('========================================\n');

  const fortress = new LedgerFortress({ databaseUrl: DATABASE_URL });

  try {
    // ------------------------------------------------------------------
    // 0. Clean up from any previous runs
    // ------------------------------------------------------------------
    console.log('--- Cleanup ---');
    await fortress['pool'].query('DELETE FROM credit_alert_log');
    await fortress['pool'].query('DELETE FROM credit_alert_settings');
    await fortress['pool'].query('DELETE FROM credit_ledger');
    await fortress['pool'].query('DELETE FROM credits');
    await fortress['pool'].query('DELETE FROM plans');
    console.log('  Cleaned all tables\n');

    // ------------------------------------------------------------------
    // 1. Test: add_credits (basic)
    // ------------------------------------------------------------------
    console.log('--- Test 1: add_credits (basic) ---');
    const added = await fortress.addCredits({
      accountId: testAccountId,
      amount: 10.0,
      description: 'initial-grant',
    });
    assert(added === true, 'add_credits returns true');

    const balance = await fortress.getBalance(testAccountId);
    assertClose(balance, 10.0, 'balance is 10.0');

    // ------------------------------------------------------------------
    // 2. Test: add_credits (idempotency)
    // ------------------------------------------------------------------
    console.log('\n--- Test 2: add_credits (idempotency) ---');
    const addedAgain = await fortress.addCredits({
      accountId: testAccountId,
      amount: 10.0,
      description: 'initial-grant',
    });
    assert(addedAgain === false, 'duplicate add_credits returns false (idempotent)');

    const balanceAfterDupe = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterDupe, 10.0, 'balance unchanged after duplicate');

    // ------------------------------------------------------------------
    // 3. Test: has_credits
    // ------------------------------------------------------------------
    console.log('\n--- Test 3: has_credits ---');
    const canAfford = await fortress.canGenerate(testAccountId, 5.0);
    assert(canAfford === true, 'can afford $5');

    const cantAfford = await fortress.canGenerate(testAccountId, 15.0);
    assert(cantAfford === false, 'cannot afford $15');

    // ------------------------------------------------------------------
    // 4. Test: reserve_credits (success)
    // ------------------------------------------------------------------
    console.log('\n--- Test 4: reserve_credits (success) ---');
    const genId1 = 'gen_test_001';
    const reserved = await fortress.reserve({
      accountId: testAccountId,
      amount: 3.0,
      generationId: genId1,
      model: 'flux-schnell',
    });
    assert(reserved === true, 'reserve $3 succeeds');

    const balanceAfterReserve = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterReserve, 7.0, 'balance is 7.0 after reserve');

    // ------------------------------------------------------------------
    // 5. Test: reserve_credits (insufficient balance)
    // ------------------------------------------------------------------
    console.log('\n--- Test 5: reserve_credits (insufficient) ---');
    const reserveFail = await fortress.reserve({
      accountId: testAccountId,
      amount: 100.0,
      generationId: 'gen_test_fail',
      model: 'test',
    });
    assert(reserveFail === false, 'reserve $100 fails (insufficient)');

    const balanceUnchanged = await fortress.getBalance(testAccountId);
    assertClose(balanceUnchanged, 7.0, 'balance unchanged after failed reserve');

    // ------------------------------------------------------------------
    // 6. Test: charge_credits (confirm reservation)
    // ------------------------------------------------------------------
    console.log('\n--- Test 6: charge_credits ---');
    const charged = await fortress.charge({
      accountId: testAccountId,
      generationId: genId1,
      amount: 3.0,
      model: 'flux-schnell',
    });
    assert(charged === true, 'charge succeeds');

    const balanceAfterCharge = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterCharge, 7.0, 'balance unchanged after charge (log-only)');

    // ------------------------------------------------------------------
    // 7. Test: charge_credits (idempotency)
    // ------------------------------------------------------------------
    console.log('\n--- Test 7: charge_credits (idempotency) ---');
    const chargedAgain = await fortress.charge({
      accountId: testAccountId,
      generationId: genId1,
      amount: 3.0,
      model: 'flux-schnell',
    });
    assert(chargedAgain === false, 'duplicate charge returns false (idempotent)');

    // ------------------------------------------------------------------
    // 8. Test: refund after charge (no-op guard)
    // ------------------------------------------------------------------
    console.log('\n--- Test 8: refund after charge (guard) ---');
    const refundAfterCharge = await fortress.refund({
      accountId: testAccountId,
      generationId: genId1,
      amount: 3.0,
      model: 'flux-schnell',
    });
    assert(refundAfterCharge === false, 'refund after charge returns false (guard)');

    const balanceAfterRefundGuard = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterRefundGuard, 7.0, 'balance unchanged (refund blocked)');

    // ------------------------------------------------------------------
    // 9. Test: reserve + refund (generation failure)
    // ------------------------------------------------------------------
    console.log('\n--- Test 9: reserve + refund flow ---');
    const genId2 = 'gen_test_002';
    await fortress.reserve({
      accountId: testAccountId,
      amount: 2.0,
      generationId: genId2,
      model: 'sdxl-turbo',
    });
    const balanceAfterReserve2 = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterReserve2, 5.0, 'balance is 5.0 after second reserve');

    const refunded = await fortress.refund({
      accountId: testAccountId,
      generationId: genId2,
      amount: 2.0,
      model: 'sdxl-turbo',
    });
    assert(refunded === true, 'refund succeeds');

    const balanceAfterRefund = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterRefund, 7.0, 'balance restored to 7.0 after refund');

    // ------------------------------------------------------------------
    // 10. Test: refund idempotency
    // ------------------------------------------------------------------
    console.log('\n--- Test 10: refund (idempotency) ---');
    const refundedAgain = await fortress.refund({
      accountId: testAccountId,
      generationId: genId2,
      amount: 2.0,
      model: 'sdxl-turbo',
    });
    assert(refundedAgain === false, 'duplicate refund returns false (idempotent)');

    const balanceAfterDupeRefund = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterDupeRefund, 7.0, 'balance unchanged after duplicate refund');

    // ------------------------------------------------------------------
    // 11. Test: charge after refund (guard + re-deduct)
    // ------------------------------------------------------------------
    console.log('\n--- Test 11: charge after refund (guard + re-deduct) ---');
    const chargeAfterRefund = await fortress.charge({
      accountId: testAccountId,
      generationId: genId2,
      amount: 2.0,
      model: 'sdxl-turbo',
    });
    assert(chargeAfterRefund === true, 'charge after refund succeeds (re-deducts)');

    const balanceAfterReDeduct = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterReDeduct, 5.0, 'balance reduced to 5.0 (re-deducted)');

    // ------------------------------------------------------------------
    // 12. Test: overdraw protection (CHECK >= 0)
    // ------------------------------------------------------------------
    console.log('\n--- Test 12: overdraw protection ---');
    const overReserve = await fortress.reserve({
      accountId: testAccountId,
      amount: 5.001,
      generationId: 'gen_test_overdraw',
      model: 'test',
    });
    assert(overReserve === false, 'overdraw blocked (5.001 > 5.0)');

    // ------------------------------------------------------------------
    // 13. Test: amount validation (SDK level)
    // ------------------------------------------------------------------
    console.log('\n--- Test 13: amount validation (SDK level) ---');
    let threwOnZero = false;
    try {
      await fortress.reserve({ accountId: testAccountId, amount: 0, generationId: 'x' });
    } catch (e: unknown) {
      threwOnZero = (e as Error).message.includes('positive');
    }
    assert(threwOnZero, 'reserve(amount=0) throws');

    let threwOnNeg = false;
    try {
      await fortress.addCredits({ accountId: testAccountId, amount: -5, description: 'x' });
    } catch (e: unknown) {
      threwOnNeg = (e as Error).message.includes('positive');
    }
    assert(threwOnNeg, 'addCredits(amount=-5) throws');

    // ------------------------------------------------------------------
    // 14. Test: ledger audit trail
    // ------------------------------------------------------------------
    console.log('\n--- Test 14: ledger audit trail ---');
    const ledger = await fortress.listLedger(testAccountId, { limit: 50 });
    assert(ledger.length > 0, 'ledger has entries');

    const types = ledger.map((e) => e.type);
    assert(types.includes('add'), 'ledger has add entries');
    assert(types.includes('reserve'), 'ledger has reserve entries');
    assert(types.includes('charge'), 'ledger has charge entries');
    assert(types.includes('refund'), 'ledger has refund entries');

    // ------------------------------------------------------------------
    // 15. Test: crash recovery (orphaned reservations)
    // ------------------------------------------------------------------
    console.log('\n--- Test 15: crash recovery ---');

    // Create an orphan: reserve but never charge/refund, with old timestamp
    const orphanGenId = 'gen_orphan_001';
    await fortress.reserve({
      accountId: testAccountId,
      amount: 1.0,
      generationId: orphanGenId,
      model: 'test-orphan',
    });
    const balanceBeforeOrphan = await fortress.getBalance(testAccountId);
    assertClose(balanceBeforeOrphan, 4.0, 'balance is 4.0 after orphan reserve');

    // Backdate the reservation so crash recovery finds it
    await fortress['pool'].query(
      `UPDATE credit_ledger SET created_at = NOW() - INTERVAL '10 minutes' WHERE generation_id = $1 AND type = 'reserve'`,
      [orphanGenId],
    );

    const recovered: string[] = [];
    const result = await fortress.recoverOrphans({
      windowMinutes: 5,
      limit: 100,
      onRecovered: async (genId, accId) => {
        recovered.push(genId);
      },
    });

    assert(result.refunded >= 1, `crash recovery refunded >= 1 orphan (got ${result.refunded})`);
    assert(recovered.includes(orphanGenId), 'orphan generation ID was in callback');

    const balanceAfterRecovery = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterRecovery, 5.0, 'balance restored to 5.0 after orphan recovery');

    // ------------------------------------------------------------------
    // 16. Test: credit alerts
    // ------------------------------------------------------------------
    console.log('\n--- Test 16: credit alerts ---');

    await fortress.setAlertSettings({
      accountId: testAccountId,
      enabled: true,
      thresholds: [3.0, 1.0],
      channels: { inApp: true, email: true, webhook: false },
    });

    const settings = await fortress.getAlertSettings(testAccountId);
    assert(settings !== null, 'alert settings saved');
    assert(settings?.enabled === true, 'alerts enabled');

    // Drain below $3 threshold
    const genDrain = 'gen_drain_001';
    await fortress.reserve({
      accountId: testAccountId,
      amount: 2.5,
      generationId: genDrain,
      model: 'test-drain',
    });
    await fortress.charge({
      accountId: testAccountId,
      generationId: genDrain,
      amount: 2.5,
      model: 'test-drain',
    });

    const balanceAfterDrain = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterDrain, 2.5, 'balance is 2.5 after drain');

    const alerts = await fortress.checkAlerts(testAccountId);
    assert(alerts.length >= 1, `alert fired for $3 threshold (got ${alerts.length} alerts)`);

    // Second check should not fire again
    const alertsAgain = await fortress.checkAlerts(testAccountId);
    assert(alertsAgain.length === 0, 'no duplicate alert on second check');

    // Reset alerts (simulating top-up)
    await fortress.resetAlerts(testAccountId);
    // After reset, the same threshold can fire again once balance drops again

    // ------------------------------------------------------------------
    // 17. Test: alert threshold validation (negative threshold)
    // ------------------------------------------------------------------
    console.log('\n--- Test 17: alert threshold validation ---');
    let threwOnNegThreshold = false;
    try {
      await fortress.setAlertSettings({
        accountId: testAccountId2,
        enabled: true,
        thresholds: [-1.0],
        channels: { inApp: true, email: false, webhook: false },
      });
    } catch {
      threwOnNegThreshold = true;
    }
    assert(threwOnNegThreshold, 'negative threshold rejected by trigger');

    // ------------------------------------------------------------------
    // 18. Test: Stripe webhook handler (simulated invoice.paid)
    // ------------------------------------------------------------------
    console.log('\n--- Test 18: Stripe webhook handler (invoice.paid) ---');

    // First, create a real Stripe product + price for the plans table
    const product = await stripe.products.create({
      name: 'Ledger Fortress Test - Pro Monthly',
      metadata: { ledger_fortress_test: 'true' },
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 2900, // $29
      currency: 'usd',
      recurring: { interval: 'month' },
    });

    // Insert plan into DB
    await fortress['pool'].query(
      `INSERT INTO plans (name, variant_id, tokens) VALUES ($1, $2, $3)`,
      ['Pro Monthly', price.id, 29.0],
    );

    // Create test customer
    const customer = await stripe.customers.create({
      email: 'test@ledger-fortress.dev',
      name: 'E2E Test User',
      metadata: { account_id: testAccountId },
    });

    // Build the webhook handler
    const handler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async (customerId: string) => {
        const cust = await stripe.customers.retrieve(customerId);
        if ('deleted' in cust && cust.deleted) return null;
        return (cust.metadata?.account_id as string) ?? null;
      },
    });

    // Simulate invoice.paid event
    const invoiceEvent: StripeEvent = {
      type: 'invoice.paid',
      data: {
        object: {
          id: 'inv_test_e2e_001',
          customer: customer.id,
          amount_paid: 2900,
          billing_reason: 'subscription_create',
        },
      },
    };

    const webhookResult = await handler(invoiceEvent);
    assert(webhookResult.handled === true, 'webhook handled');
    assert(webhookResult.action === 'credits_added', 'action is credits_added');

    const balanceAfterInvoice = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterInvoice, 31.5, 'balance increased by $29 (2.5 + 29 = 31.5)');

    // ------------------------------------------------------------------
    // 19. Test: Stripe webhook idempotency (same invoice)
    // ------------------------------------------------------------------
    console.log('\n--- Test 19: Stripe webhook idempotency ---');
    const webhookResult2 = await handler(invoiceEvent);
    assert(webhookResult2.action === 'skipped_duplicate', 'duplicate invoice skipped');

    const balanceAfterDupeInvoice = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterDupeInvoice, 31.5, 'balance unchanged after duplicate webhook');

    // ------------------------------------------------------------------
    // 20. Test: Stripe webhook - checkout.session.completed
    // ------------------------------------------------------------------
    console.log('\n--- Test 20: Stripe webhook (checkout.session.completed) ---');

    // Insert credit pack plan
    const packProduct = await stripe.products.create({
      name: 'Ledger Fortress Test - Credit Pack $10',
      metadata: { ledger_fortress_test: 'true' },
    });

    const packPrice = await stripe.prices.create({
      product: packProduct.id,
      unit_amount: 1000, // $10
      currency: 'usd',
    });

    await fortress['pool'].query(
      `INSERT INTO plans (name, variant_id, tokens) VALUES ($1, $2, $3)`,
      ['Credit Pack $10', packPrice.id, 10.0],
    );

    const checkoutEvent: StripeEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_e2e_001',
          customer: customer.id,
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1000,
          metadata: {},
        },
      },
    };

    const checkoutResult = await handler(checkoutEvent);
    assert(checkoutResult.handled === true, 'checkout handled');
    assert(checkoutResult.action === 'credits_added', 'checkout action is credits_added');

    const balanceAfterPack = await fortress.getBalance(testAccountId);
    assertClose(balanceAfterPack, 41.5, 'balance is 41.5 (31.5 + 10)');

    // ------------------------------------------------------------------
    // 21. Test: concurrent reserve (race condition prevention)
    // ------------------------------------------------------------------
    console.log('\n--- Test 21: concurrent reserves ---');

    // Set balance to exactly $1
    await fortress['pool'].query(
      `UPDATE credits SET tokens = 1.000 WHERE account_id = $1`,
      [testAccountId],
    );
    const balBeforeConcurrent = await fortress.getBalance(testAccountId);
    assertClose(balBeforeConcurrent, 1.0, 'balance set to $1');

    // Fire two concurrent $0.8 reserves - only one should succeed
    const [r1, r2] = await Promise.all([
      fortress.reserve({
        accountId: testAccountId,
        amount: 0.8,
        generationId: 'gen_concurrent_1',
        model: 'test',
      }),
      fortress.reserve({
        accountId: testAccountId,
        amount: 0.8,
        generationId: 'gen_concurrent_2',
        model: 'test',
      }),
    ]);

    const successes = [r1, r2].filter(Boolean).length;
    assert(successes === 1, `exactly 1 concurrent reserve succeeded (got ${successes})`);

    const balAfterConcurrent = await fortress.getBalance(testAccountId);
    assertClose(balAfterConcurrent, 0.2, 'balance is 0.2 after one reserve');

    // ------------------------------------------------------------------
    // 22. Test: multi-account isolation
    // ------------------------------------------------------------------
    console.log('\n--- Test 22: multi-account isolation ---');

    await fortress.addCredits({
      accountId: testAccountId2,
      amount: 50.0,
      description: 'account2-grant',
    });

    const bal1 = await fortress.getBalance(testAccountId);
    const bal2 = await fortress.getBalance(testAccountId2);
    assert(bal1 < 1.0, `account1 balance is low (${bal1})`);
    assertClose(bal2, 50.0, 'account2 balance is 50.0 (isolated)');

    // ------------------------------------------------------------------
    // 23. Test: buildEvent
    // ------------------------------------------------------------------
    console.log('\n--- Test 23: buildEvent ---');
    const event = fortress.buildEvent({
      id: 'evt_test_001',
      accountId: testAccountId,
      type: 'reserve',
      amount: 0.062,
      generationId: 'gen_event_test',
      model: 'flux-schnell',
      balanceAfter: 9.938,
      description: null,
      createdAt: new Date(),
    });
    assert(event.schema_version === 'credit-event.v1', 'event has correct schema version');
    assert(event.account_id === testAccountId, 'event has correct account_id');
    assert(event.type === 'reserve', 'event has correct type');
    assert(typeof event.occurred_at === 'string', 'event has timestamp');
    assert(typeof event.event_id === 'string', 'event has event_id');

    // ------------------------------------------------------------------
    // 24. Test: Stripe signature verification (valid)
    // ------------------------------------------------------------------
    console.log('\n--- Test 24: Stripe signature verification (valid) ---');
    const webhookSecret = 'whsec_test_' + 'a'.repeat(40);
    const samplePayload = JSON.stringify({
      id: 'evt_test_sig',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'inv_test_sig' } },
    });
    // Build a valid Stripe signature header.
    // Format: t=<timestamp>,v1=<hex hmac sha256>
    const crypto = await import('node:crypto');
    const ts = Math.floor(Date.now() / 1000);
    const signedPayload = `${ts}.${samplePayload}`;
    const sig = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
    const validHeader = `t=${ts},v1=${sig}`;

    let verifiedEvent: StripeEvent | null = null;
    try {
      verifiedEvent = verifyStripeSignature(stripe, samplePayload, validHeader, webhookSecret);
    } catch (e) {
      console.error('  unexpected error:', (e as Error).message);
    }
    assert(verifiedEvent !== null, 'valid signature accepted');
    assert(verifiedEvent?.type === 'invoice.paid', 'verified event has correct type');

    // ------------------------------------------------------------------
    // 25. Test: Stripe signature verification (tampered)
    // ------------------------------------------------------------------
    console.log('\n--- Test 25: Stripe signature verification (tampered) ---');
    let tamperedRejected = false;
    try {
      verifyStripeSignature(stripe, samplePayload + 'tampered', validHeader, webhookSecret);
    } catch {
      tamperedRejected = true;
    }
    assert(tamperedRejected, 'tampered payload rejected');

    let badSigRejected = false;
    try {
      verifyStripeSignature(stripe, samplePayload, 't=123,v1=deadbeef', webhookSecret);
    } catch {
      badSigRejected = true;
    }
    assert(badSigRejected, 'bad signature rejected');

    let missingSigRejected = false;
    try {
      verifyStripeSignature(stripe, samplePayload, null, webhookSecret);
    } catch {
      missingSigRejected = true;
    }
    assert(missingSigRejected, 'missing signature header rejected');

    // ------------------------------------------------------------------
    // 26. Test: RLS enforcement (anon cannot access tables)
    // ------------------------------------------------------------------
    console.log('\n--- Test 26: RLS enforcement ---');
    const anonKey = 'sb_publishable_p5GwBdR3wS27YCLc0M8T1w_-KTNch9A';
    const supabaseUrl = 'https://iprguzbqaiujddjubtxx.supabase.co';

    // Try to read credits via PostgREST as anon.
    const readResp = await fetch(`${supabaseUrl}/rest/v1/credits?select=*`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    assert(readResp.status === 401 || readResp.status === 403,
      `anon read denied (got HTTP ${readResp.status})`);

    // Try to insert into credit_ledger as anon.
    const writeResp = await fetch(`${supabaseUrl}/rest/v1/credit_ledger`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account_id: testAccountId,
        type: 'add',
        amount: 999999,
        balance_after: 999999,
        description: 'attempted-forge',
      }),
    });
    assert(writeResp.status === 401 || writeResp.status === 403,
      `anon write denied (got HTTP ${writeResp.status})`);

    // ------------------------------------------------------------------
    // 27. Test: Cost true-up (actual < reserved → refund difference)
    // ------------------------------------------------------------------
    console.log('\n--- Test 27: settle (true-down: actual < reserved) ---');

    // Set account2 balance for clean settle tests
    await fortress['pool'].query(
      `UPDATE credits SET tokens = 10.000 WHERE account_id = $1`,
      [testAccountId2],
    );

    // Reserve $1 (max estimate), actual cost $0.30
    const settleGenId1 = 'gen_settle_001';
    await fortress.reserve({
      accountId: testAccountId2,
      generationId: settleGenId1,
      amount: 1.0,
      model: 'flux-pro',
    });
    let settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 9.0, 'balance is 9.0 after reserve $1');

    const settled1 = await fortress.settle({
      accountId: testAccountId2,
      generationId: settleGenId1,
      reservedAmount: 1.0,
      actualAmount: 0.3,
      model: 'flux-pro',
    });
    assert(settled1 === true, 'settle (true-down) succeeds');
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 9.7, 'balance is 9.7 after settle (refunded $0.70)');

    // ------------------------------------------------------------------
    // 28. Test: settle idempotency
    // ------------------------------------------------------------------
    console.log('\n--- Test 28: settle (idempotency) ---');
    const settledAgain = await fortress.settle({
      accountId: testAccountId2,
      generationId: settleGenId1,
      reservedAmount: 1.0,
      actualAmount: 0.3,
    });
    assert(settledAgain === false, 'duplicate settle returns false');
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 9.7, 'balance unchanged after duplicate settle');

    // ------------------------------------------------------------------
    // 29. Test: settle (true-up: actual > reserved, sufficient balance)
    // ------------------------------------------------------------------
    console.log('\n--- Test 29: settle (true-up: actual > reserved) ---');
    const settleGenId2 = 'gen_settle_002';
    await fortress.reserve({
      accountId: testAccountId2,
      generationId: settleGenId2,
      amount: 0.5,
      model: 'video-large',
    });
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 9.2, 'balance is 9.2 after reserve $0.5');

    const settled2 = await fortress.settle({
      accountId: testAccountId2,
      generationId: settleGenId2,
      reservedAmount: 0.5,
      actualAmount: 0.85,
      model: 'video-large',
    });
    assert(settled2 === true, 'settle (true-up) succeeds');
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 8.85, 'balance is 8.85 after true-up (deducted extra $0.35)');

    // ------------------------------------------------------------------
    // 30. Test: settle (true-up exceeds balance, uncollectible recorded)
    // ------------------------------------------------------------------
    console.log('\n--- Test 30: settle (true-up shortfall) ---');

    // Drain account2 to almost zero
    await fortress['pool'].query(
      `UPDATE credits SET tokens = 0.10 WHERE account_id = $1`,
      [testAccountId2],
    );

    // Reserve $0.10, but actual cost balloons to $5
    const settleGenId3 = 'gen_settle_003';
    await fortress.reserve({
      accountId: testAccountId2,
      generationId: settleGenId3,
      amount: 0.10,
      model: 'video-xl',
    });
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 0.0, 'balance is 0 after reserving all of it');

    const settled3 = await fortress.settle({
      accountId: testAccountId2,
      generationId: settleGenId3,
      reservedAmount: 0.10,
      actualAmount: 5.0,
      model: 'video-xl',
    });
    assert(settled3 === true, 'settle with shortfall still succeeds');
    settleBal = await fortress.getBalance(testAccountId2);
    assertClose(settleBal, 0.0, 'balance stays at 0 (cannot go negative)');

    const uncollectible = await fortress.getUncollectibleTotal(testAccountId2);
    assertClose(uncollectible, 4.9, 'uncollectible is $4.90 (5.0 - 0.10 reserved)');

    // ------------------------------------------------------------------
    // 31. Test: charge_credits and settle_credits are mutually exclusive
    // ------------------------------------------------------------------
    console.log('\n--- Test 31: charge/settle mutex ---');

    // Reset account2
    await fortress['pool'].query(
      `UPDATE credits SET tokens = 5.0 WHERE account_id = $1`,
      [testAccountId2],
    );

    const mutexGenId = 'gen_mutex_001';
    await fortress.reserve({
      accountId: testAccountId2,
      generationId: mutexGenId,
      amount: 0.5,
    });
    await fortress.charge({
      accountId: testAccountId2,
      generationId: mutexGenId,
      amount: 0.5,
    });

    // Now try to settle the same generation
    let mutexThrew = false;
    try {
      await fortress.settle({
        accountId: testAccountId2,
        generationId: mutexGenId,
        reservedAmount: 0.5,
        actualAmount: 0.4,
      });
    } catch (e: unknown) {
      mutexThrew = (e as Error).message.includes('charge entry');
    }
    assert(mutexThrew, 'settle after charge throws (mutex enforced)');

    // ------------------------------------------------------------------
    // 32. Test: clawback (full, balance sufficient)
    // ------------------------------------------------------------------
    console.log('\n--- Test 32: clawback (full) ---');

    // Setup: account with balance
    const clawAccountId = '30000000-0000-0000-0000-000000000003';
    await fortress.addCredits({
      accountId: clawAccountId,
      amount: 50.0,
      description: 'clawback-test-grant',
    });

    const claw1 = await fortress.clawback({
      accountId: clawAccountId,
      amount: 20.0,
      idempotencyKey: 'refund:re_test_001',
      reason: 'stripe_refund',
    });
    assert(claw1.applied === true, 'clawback applied');
    assertClose(claw1.uncollectible, 0, 'no uncollectible');

    const clawBal = await fortress.getBalance(clawAccountId);
    assertClose(clawBal, 30.0, 'balance is 30.0 after $20 clawback');

    // ------------------------------------------------------------------
    // 33. Test: clawback (idempotency)
    // ------------------------------------------------------------------
    console.log('\n--- Test 33: clawback (idempotency) ---');
    const claw2 = await fortress.clawback({
      accountId: clawAccountId,
      amount: 20.0,
      idempotencyKey: 'refund:re_test_001',
      reason: 'stripe_refund',
    });
    assertClose(claw2.uncollectible, 0, 'duplicate clawback no-op');
    const clawBal2 = await fortress.getBalance(clawAccountId);
    assertClose(clawBal2, 30.0, 'balance unchanged after duplicate clawback');

    // ------------------------------------------------------------------
    // 34. Test: clawback (insufficient balance, partial + uncollectible)
    // ------------------------------------------------------------------
    console.log('\n--- Test 34: clawback (insufficient balance) ---');
    const claw3 = await fortress.clawback({
      accountId: clawAccountId,
      amount: 100.0,
      idempotencyKey: 'refund:re_test_002',
      reason: 'stripe_refund',
    });
    assert(claw3.applied === true, 'clawback partially applied');
    assertClose(claw3.uncollectible, 70.0, 'uncollectible is $70 (100 - 30 available)');

    const clawBal3 = await fortress.getBalance(clawAccountId);
    assertClose(clawBal3, 0, 'balance is 0 (fully drained, never negative)');

    const totalUncoll = await fortress.getUncollectibleTotal(clawAccountId);
    assertClose(totalUncoll, 70.0, 'uncollectible total is $70');

    // ------------------------------------------------------------------
    // 35. Test: Stripe charge.refunded webhook handler
    // ------------------------------------------------------------------
    console.log('\n--- Test 35: Stripe webhook (charge.refunded) ---');

    // Setup: customer with balance
    const refundCustomer = await stripe.customers.create({
      email: 'refund-test@ledger-fortress.dev',
      metadata: { account_id: testAccountId },
    });

    // Top up testAccountId for refund test
    await fortress['pool'].query(
      `UPDATE credits SET tokens = 50.0 WHERE account_id = $1`,
      [testAccountId],
    );

    const refundHandler = createStripeWebhookHandler({
      fortress,
      resolveAccountId: async (customerId: string) => {
        const cust = await stripe.customers.retrieve(customerId);
        if ('deleted' in cust && cust.deleted) return null;
        return (cust.metadata?.account_id as string) ?? null;
      },
    });

    const refundEvent: StripeEvent = {
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_test_refund_001',
          customer: refundCustomer.id,
          amount_refunded: 1500, // $15
          refunds: { data: [{ id: 're_test_webhook_001' }] },
        },
      },
    };

    const refundResult = await refundHandler(refundEvent);
    assert(refundResult.action === 'credits_clawed_back', 'refund webhook clawed back credits');
    assertClose(refundResult.amount ?? 0, 15.0, 'refund amount is $15');
    assertClose(refundResult.uncollectible ?? 0, 0, 'no uncollectible');

    const balAfterRefund = await fortress.getBalance(testAccountId);
    assertClose(balAfterRefund, 35.0, 'balance is $35 after $15 refund clawback');

    // ------------------------------------------------------------------
    // 36. Test: Stripe charge.refunded webhook idempotency
    // ------------------------------------------------------------------
    console.log('\n--- Test 36: charge.refunded idempotency ---');
    const refundResult2 = await refundHandler(refundEvent);
    assert(refundResult2.action === 'credits_clawed_back', 'still returns handled');
    const balAfterDuplicate = await fortress.getBalance(testAccountId);
    assertClose(balAfterDuplicate, 35.0, 'balance unchanged after duplicate refund webhook');

    // ------------------------------------------------------------------
    // 37. Test: Stripe charge.dispute.created webhook handler
    // ------------------------------------------------------------------
    console.log('\n--- Test 37: Stripe webhook (charge.dispute.created) ---');
    const disputeEvent: StripeEvent = {
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_test_001',
          amount: 2000, // $20
          charge: { customer: refundCustomer.id },
        },
      },
    };

    const disputeResult = await refundHandler(disputeEvent);
    assert(disputeResult.action === 'credits_clawed_back', 'dispute webhook clawed back');
    assertClose(disputeResult.amount ?? 0, 20.0, 'dispute amount is $20');

    const balAfterDispute = await fortress.getBalance(testAccountId);
    assertClose(balAfterDispute, 15.0, 'balance is $15 after $20 dispute clawback');

    // Cleanup the additional Stripe customer
    await stripe.customers.del(refundCustomer.id);

    // ------------------------------------------------------------------
    // Cleanup Stripe test objects
    // ------------------------------------------------------------------
    console.log('\n--- Cleanup Stripe ---');
    await stripe.customers.del(customer.id);
    await stripe.products.update(product.id, { active: false });
    await stripe.products.update(packProduct.id, { active: false });
    console.log('  Cleaned up test Stripe objects');

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    console.log('\n========================================');
    console.log(`  Results: ${passCount} passed, ${failCount} failed`);
    console.log('========================================\n');

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
    process.exit(1);
  } finally {
    await fortress.close();
  }
}

main();
