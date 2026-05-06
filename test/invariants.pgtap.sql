-- Copyright 2026 BabySea, Inc.
-- Licensed under the Apache License, Version 2.0.
--
-- ledger-fortress PgTAP invariant checks.
--
-- Prerequisites:
--   psql "$DATABASE_URL" < migrations/001_credits.sql
--   psql "$DATABASE_URL" < migrations/002_credit_alerts.sql
--   psql "$DATABASE_URL" < migrations/003_security.sql
--
-- Run:
--   psql "$DATABASE_URL" -f test/invariants.pgtap.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(20);

SELECT has_table('public', 'credits', 'credits table exists');
SELECT has_table('public', 'credit_ledger', 'credit_ledger table exists');
SELECT has_function('public', 'reserve_credits', ARRAY['uuid', 'numeric', 'text', 'text'], 'reserve_credits function exists');
SELECT has_function('public', 'charge_credits', ARRAY['uuid', 'numeric', 'text', 'text'], 'charge_credits function exists');
SELECT has_function('public', 'refund_credits', ARRAY['uuid', 'numeric', 'text', 'text'], 'refund_credits function exists');

SELECT lives_ok(
  $$ SELECT add_credits('00000000-0000-0000-0000-000000000101'::uuid, 10.000, 'pgtap seed', 'pgtap:seed:101') $$,
  'add_credits grants an initial balance'
);

SELECT is(
  get_balance('00000000-0000-0000-0000-000000000101'::uuid),
  10.000::numeric,
  'initial grant sets balance to 10 credits'
);

SELECT ok(
  reserve_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_101', 'test-model'),
  'reserve succeeds when balance is sufficient'
);

SELECT is(
  get_balance('00000000-0000-0000-0000-000000000101'::uuid),
  9.000::numeric,
  'reserve deducts exactly once'
);

SELECT ok(
  reserve_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_101', 'test-model'),
  'duplicate reserve with same amount is idempotent success'
);

SELECT is(
  get_balance('00000000-0000-0000-0000-000000000101'::uuid),
  9.000::numeric,
  'duplicate reserve does not double-deduct'
);

SELECT throws_like(
  $$ SELECT reserve_credits('00000000-0000-0000-0000-000000000101'::uuid, 2.000, 'pgtap_gen_101', 'test-model') $$,
  '%idempotency conflict%',
  'duplicate reserve with a different amount raises an idempotency conflict'
);

SELECT ok(
  charge_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_101', 'test-model'),
  'charge confirms an existing reserve'
);

SELECT is(
  get_balance('00000000-0000-0000-0000-000000000101'::uuid),
  9.000::numeric,
  'charge after reserve is log-only when not previously refunded'
);

SELECT is(
  charge_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_101', 'test-model'),
  false,
  'duplicate charge is an idempotent no-op'
);

SELECT is(
  refund_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_101', 'test-model'),
  false,
  'refund after charge is blocked to prevent free output'
);

SELECT ok(
  reserve_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_102', 'test-model'),
  'second reserve succeeds for refund test'
);

SELECT ok(
  refund_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_102', 'test-model'),
  'refund returns a prior reserve'
);

SELECT is(
  refund_credits('00000000-0000-0000-0000-000000000101'::uuid, 1.000, 'pgtap_gen_102', 'test-model'),
  false,
  'duplicate refund is an idempotent no-op'
);

SELECT is(
  get_balance('00000000-0000-0000-0000-000000000101'::uuid),
  9.000::numeric,
  'final balance reflects one charged generation only'
);

SELECT * FROM finish();

ROLLBACK;