-- ledger-fortress: 004_clawback_and_trueup.sql
--
-- Generative media payment flows demand two patterns that fixed-price billing
-- doesn't need:
--
--   1. CLAWBACK   - Stripe customer disputes a charge or you refund a payment.
--                   The credits granted from that payment must be returned.
--                   If the customer already spent some, the gap is uncollectible
--                   (recorded for accounting, balance never goes negative).
--
--   2. TRUE-UP    - Generation cost is known only AFTER the model runs.
--                   Reserve the maximum estimate; settle with the actual cost.
--                   Excess is refunded; shortfall is re-deducted atomically.
--
-- Apply with: psql "$DATABASE_URL" < migrations/004_clawback_and_trueup.sql
--
-- Copyright 2026 BabySea, Inc.
-- Licensed under the Apache License, Version 2.0.

-- ============================================================================
-- EXTEND credit_ledger.type CHECK constraint
-- Add 'clawback', 'trueup', 'uncollectible' to the allowed types.
-- ============================================================================

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_type_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_type_check
  CHECK (type IN ('reserve', 'charge', 'refund', 'add', 'clawback', 'trueup', 'uncollectible'));

-- ============================================================================
-- RELAX credit_ledger.amount CHECK constraint
-- 'trueup' entries can be negative (extra deduction) so we allow != 0 for
-- trueup type, while keeping > 0 for all other types.
-- ============================================================================

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_amount_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_amount_check
  CHECK (
    -- 'trueup' can be any value (positive = refund, negative = deduct, zero = no-op)
    type = 'trueup' OR amount > 0
  );

-- ============================================================================
-- INDEX: idempotency for clawbacks
-- One clawback per (account, idempotency_key).
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_clawback_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'clawback';

-- ============================================================================
-- INDEX: idempotency for true-up settlements
-- One settlement per generation_id.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_trueup_idempotent
  ON credit_ledger (generation_id) WHERE type = 'trueup';

-- ============================================================================
-- FUNCTION: clawback_credits(account_id, amount, idempotency_key, reason)
--
-- Returns credits granted from a Stripe payment that has been refunded or
-- disputed. Deducts from balance up to the available amount; records any
-- shortfall as 'uncollectible' (separate audit entry).
--
-- Balance NEVER goes negative (CHECK >= 0 enforced).
--
-- Use the Stripe event ID or charge ID as idempotency_key:
--   "refund:{stripe_refund_id}"
--   "dispute:{stripe_dispute_id}"
--
-- Returns: the uncollectible amount (0 if fully clawed back).
-- ============================================================================

CREATE OR REPLACE FUNCTION clawback_credits(
  p_account_id      UUID,
  p_amount          NUMERIC,
  p_idempotency_key TEXT,
  p_reason          TEXT DEFAULT 'stripe_refund'
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance NUMERIC;
  v_clawed_back     NUMERIC;
  v_uncollectible   NUMERIC;
  v_new_balance     NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'clawback_credits: amount must be positive';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'clawback_credits: idempotency_key is required';
  END IF;

  -- Serialize and lock the account row.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- Idempotency check: already clawed back?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE account_id = p_account_id
      AND description = p_idempotency_key
      AND type = 'clawback'
  ) THEN
    RETURN 0;  -- idempotent no-op
  END IF;

  -- Read current balance (default 0 if account never received credits).
  SELECT COALESCE(tokens, 0) INTO v_current_balance
  FROM credits WHERE account_id = p_account_id;

  IF v_current_balance IS NULL THEN
    v_current_balance := 0;
  END IF;

  -- Clawback = min(balance, requested). Uncollectible = the rest.
  v_clawed_back   := LEAST(v_current_balance, p_amount);
  v_uncollectible := p_amount - v_clawed_back;
  v_new_balance   := v_current_balance - v_clawed_back;

  -- Apply the deduction.
  IF v_clawed_back > 0 THEN
    UPDATE credits
    SET tokens = v_new_balance, updated_at = NOW()
    WHERE account_id = p_account_id;
  END IF;

  -- Log the clawback (always, even if 0 was deducted, for audit).
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, description)
    VALUES (p_account_id, 'clawback', v_clawed_back, v_new_balance, p_idempotency_key);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent clawback won; roll back our deduction.
    IF v_clawed_back > 0 THEN
      UPDATE credits
      SET tokens = tokens + v_clawed_back, updated_at = NOW()
      WHERE account_id = p_account_id;
    END IF;
    RETURN 0;
  END;

  -- Log uncollectible amount separately if any.
  IF v_uncollectible > 0 THEN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, description)
    VALUES (
      p_account_id,
      'uncollectible',
      v_uncollectible,
      v_new_balance,
      p_idempotency_key || ':uncollectible'
    );
  END IF;

  RETURN v_uncollectible;
END;
$$;

COMMENT ON FUNCTION clawback_credits IS 'Clawback credits from a Stripe refund or dispute. Returns the uncollectible amount.';

-- ============================================================================
-- FUNCTION: settle_credits(account_id, generation_id, reserved, actual, model)
--
-- Variable-cost settlement. Use when the actual generation cost is only
-- known after the model finishes (most common in generative media).
--
-- Three cases:
--   1. actual == reserved  ➜ equivalent to charge_credits (log only)
--   2. actual <  reserved  ➜ refund the difference (true-down)
--   3. actual >  reserved  ➜ atomic re-deduct the difference (true-up)
--                            If insufficient balance, settle still succeeds
--                            but an 'uncollectible' entry is recorded.
--
-- Idempotent via generation_id (unique partial index on type='trueup').
--
-- Returns:
--   TRUE  if settled
--   FALSE if already settled (idempotent no-op)
-- ============================================================================

CREATE OR REPLACE FUNCTION settle_credits(
  p_account_id    UUID,
  p_generation_id TEXT,
  p_reserved      NUMERIC,
  p_actual        NUMERIC,
  p_model         TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance        NUMERIC;
  v_delta          NUMERIC;       -- reserved - actual: positive = refund, negative = re-deduct
  v_extra_needed   NUMERIC;
  v_can_deduct     NUMERIC;
  v_uncollectible  NUMERIC;
BEGIN
  IF p_generation_id IS NULL OR p_generation_id = '' THEN
    RAISE EXCEPTION 'settle_credits: generation_id is required';
  END IF;
  IF p_reserved < 0 OR p_actual < 0 THEN
    RAISE EXCEPTION 'settle_credits: reserved and actual must be non-negative';
  END IF;

  -- Serialize concurrent operations on the same account.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- Idempotency check: already settled?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'trueup'
  ) THEN
    RETURN FALSE;
  END IF;

  -- Also block if a regular charge already happened for this generation.
  -- Settle and charge are mutually exclusive on the same generation_id.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'charge'
  ) THEN
    RAISE EXCEPTION 'settle_credits: generation_id % already has a charge entry; use only one of charge_credits or settle_credits per generation', p_generation_id;
  END IF;

  v_delta := p_reserved - p_actual;

  IF v_delta > 0 THEN
    -- True-down: actual was less than reserved, return the difference.
    UPDATE credits
    SET tokens = tokens + v_delta, updated_at = NOW()
    WHERE account_id = p_account_id
    RETURNING tokens INTO v_balance;

    IF NOT FOUND THEN
      -- Account row missing (shouldn't happen if reserve worked, but guard).
      RAISE EXCEPTION 'settle_credits: account % has no credits row', p_account_id;
    END IF;

  ELSIF v_delta < 0 THEN
    -- True-up: actual exceeded reserved, deduct extra atomically.
    v_extra_needed := -v_delta;

    -- Try to deduct the extra. Use atomic UPDATE with WHERE guard.
    UPDATE credits
    SET tokens = tokens - v_extra_needed, updated_at = NOW()
    WHERE account_id = p_account_id AND tokens >= v_extra_needed
    RETURNING tokens INTO v_balance;

    IF NOT FOUND THEN
      -- Insufficient balance for the true-up: deduct what we can, mark gap.
      SELECT COALESCE(tokens, 0) INTO v_balance FROM credits WHERE account_id = p_account_id;
      v_can_deduct    := LEAST(v_balance, v_extra_needed);
      v_uncollectible := v_extra_needed - v_can_deduct;

      IF v_can_deduct > 0 THEN
        UPDATE credits
        SET tokens = tokens - v_can_deduct, updated_at = NOW()
        WHERE account_id = p_account_id
        RETURNING tokens INTO v_balance;
      END IF;

      -- Log the uncollectible portion for audit.
      INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model, description)
      VALUES (
        p_account_id, 'uncollectible', v_uncollectible, v_balance, p_generation_id, p_model,
        'trueup_shortfall:' || p_generation_id
      );
    END IF;

  ELSE
    -- v_delta = 0: actual matched reserved exactly, just need to log.
    SELECT tokens INTO v_balance FROM credits WHERE account_id = p_account_id;
  END IF;

  -- Log the trueup entry (records the delta).
  -- Sign convention: positive amount means refunded to user (true-down),
  -- negative means deducted from user (true-up).
  -- The actual cost is stored in the description for audit traceability:
  --   "actual=<actual>, reserved=<reserved>"
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model, description)
    VALUES (
      p_account_id,
      'trueup',
      v_delta,
      v_balance,
      p_generation_id,
      p_model,
      'actual=' || p_actual || ',reserved=' || p_reserved
    );
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent settlement won the race. Roll back balance change.
    IF v_delta > 0 THEN
      UPDATE credits SET tokens = tokens - v_delta, updated_at = NOW() WHERE account_id = p_account_id;
    ELSIF v_delta < 0 THEN
      UPDATE credits SET tokens = tokens + (-v_delta) WHERE account_id = p_account_id;
    END IF;
    RETURN FALSE;
  END;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION settle_credits IS 'Variable-cost settlement: reserve max, settle actual. Idempotent per generation.';

-- ============================================================================
-- FUNCTION: get_uncollectible_total(account_id)
--
-- Returns the total uncollectible amount for an account.
-- Use this for monitoring (e.g., flag accounts with high uncollectible debt
-- for manual review or collection).
-- ============================================================================

CREATE OR REPLACE FUNCTION get_uncollectible_total(p_account_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(amount), 0)
  FROM credit_ledger
  WHERE account_id = p_account_id AND type = 'uncollectible';
$$;

COMMENT ON FUNCTION get_uncollectible_total IS 'Sum of uncollectible amounts (clawback shortfall, trueup shortfall) for an account.';

-- ============================================================================
-- HARDEN new functions (matching migration 003)
-- ============================================================================

ALTER FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)              SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT)       SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION get_uncollectible_total(UUID)                            SET search_path = pg_catalog, public;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)        FROM anon;
    REVOKE EXECUTE ON FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT) FROM anon;
    REVOKE EXECUTE ON FUNCTION get_uncollectible_total(UUID)                       FROM anon;
  END IF;
END $$;
