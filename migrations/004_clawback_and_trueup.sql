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
-- 'trueup' entries can be negative (extra deduction), positive (refund), or
-- zero (exact settlement). 'clawback' entries may be zero when the customer
-- already spent every refunded/disputed credit; the shortfall is then logged as
-- 'uncollectible'. All other types must stay positive.
-- ============================================================================

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_amount_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_amount_check
  CHECK (
    type = 'trueup'
    OR (type = 'clawback' AND amount >= 0)
    OR amount > 0
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
-- Returns: whether a new clawback was applied and the uncollectible amount
--          (0 if fully clawed back or if this was a duplicate event).
-- ============================================================================

DROP FUNCTION IF EXISTS clawback_credits(UUID, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION clawback_credits(
  p_account_id      UUID,
  p_amount          NUMERIC,
  p_idempotency_key TEXT,
  p_reason          TEXT DEFAULT 'stripe_refund'
)
RETURNS TABLE (applied BOOLEAN, uncollectible NUMERIC)
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance NUMERIC;
  v_clawed_back     NUMERIC;
  v_uncollectible   NUMERIC;
  v_new_balance     NUMERIC;
BEGIN
  p_amount := lf_validate_credit_amount(p_amount, 'clawback_credits');

  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'clawback_credits: idempotency_key is required';
  END IF;

  -- Ensure there is a row to lock. This serializes clawbacks even when a
  -- refund/dispute arrives for an account that has already spent every credit.
  INSERT INTO credits (account_id, tokens, updated_at)
  VALUES (p_account_id, 0, NOW())
  ON CONFLICT (account_id) DO NOTHING;

  -- Serialize and lock the account row.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- Idempotency check: already clawed back?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE account_id = p_account_id
      AND description = p_idempotency_key
      AND type = 'clawback'
  ) THEN
    applied := FALSE;
    uncollectible := 0;
    RETURN NEXT;  -- idempotent no-op
    RETURN;
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
    applied := FALSE;
    uncollectible := 0;
    RETURN NEXT;
    RETURN;
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

  applied := TRUE;
  uncollectible := v_uncollectible;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION clawback_credits IS 'Clawback credits from a Stripe refund or dispute. Returns applied flag and uncollectible amount.';

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
  v_uncollectible  NUMERIC := 0;
  v_applied_deduct NUMERIC := 0;
  v_already_refunded BOOLEAN;
  v_reserved_amount NUMERIC;
BEGIN
  IF p_generation_id IS NULL OR p_generation_id = '' THEN
    RAISE EXCEPTION 'settle_credits: generation_id is required';
  END IF;

  p_reserved := lf_validate_credit_amount(p_reserved, 'settle_credits: reserved');
  p_actual := lf_validate_credit_amount(p_actual, 'settle_credits: actual', TRUE);

  -- Serialize concurrent operations on the same account.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- A settlement closes an existing reservation. Without this guard, a caller
  -- could accidentally mint credits via true-down without a prior reserve.
  SELECT amount INTO v_reserved_amount
  FROM credit_ledger
  WHERE account_id = p_account_id
    AND generation_id = p_generation_id
    AND type = 'reserve'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF p_reserved <> v_reserved_amount THEN
    RAISE EXCEPTION 'settle_credits: reserved amount % does not match ledger reserve amount % for generation_id %', p_reserved, v_reserved_amount, p_generation_id;
  END IF;

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

  -- If crash recovery or a failure callback already refunded the reservation,
  -- reconcile from that refunded baseline by deducting the actual cost. Without
  -- this branch, settle would only deduct the overage and undercharge late
  -- success callbacks that arrive after recovery.
  v_already_refunded := EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'refund'
  );

  IF v_already_refunded THEN
    v_delta := -p_actual;
  ELSE
    v_delta := v_reserved_amount - p_actual;
  END IF;

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
      v_applied_deduct := v_can_deduct;
    ELSE
      v_applied_deduct := v_extra_needed;
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
      'actual=' || p_actual || ',reserved=' || v_reserved_amount ||
        CASE WHEN v_already_refunded THEN ',baseline=refunded' ELSE ',baseline=reserved' END
    );
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent settlement won the race. Roll back balance change.
    IF v_delta > 0 THEN
      UPDATE credits SET tokens = tokens - v_delta, updated_at = NOW() WHERE account_id = p_account_id;
    ELSIF v_delta < 0 AND v_applied_deduct > 0 THEN
      UPDATE credits SET tokens = tokens + v_applied_deduct, updated_at = NOW() WHERE account_id = p_account_id;
    END IF;
    RETURN FALSE;
  END;

  -- Log the uncollectible portion only after the terminal true-up row exists.
  IF v_uncollectible > 0 THEN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model, description)
    VALUES (
      p_account_id, 'uncollectible', v_uncollectible, v_balance, p_generation_id, p_model,
      'trueup_shortfall:' || p_generation_id
    );
  END IF;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION settle_credits IS 'Variable-cost settlement: reserve max, settle actual. Idempotent per generation.';

-- ============================================================================
-- FUNCTION: charge_credits_detailed(account_id, tokens, generation_id, model)
--
-- Override the core charge function now that migration 004 adds the
-- 'uncollectible' ledger type. If a late success callback arrives after a
-- refund/crash-recovery path and the account no longer has enough balance,
-- charge_credits_detailed records a durable terminal charge plus an
-- uncollectible shortfall and returns status='shortfall'.
-- ============================================================================

CREATE OR REPLACE FUNCTION charge_credits_detailed(
  p_account_id    UUID,
  p_tokens        NUMERIC,
  p_generation_id TEXT,
  p_model         TEXT DEFAULT NULL
)
RETURNS TABLE (status TEXT, uncollectible NUMERIC)
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance            NUMERIC;
  v_already_refunded   BOOLEAN;
  v_reserved_amount    NUMERIC;
  v_can_deduct         NUMERIC := 0;
  v_uncollectible      NUMERIC := 0;
  v_charge_description TEXT;
BEGIN
  IF p_generation_id IS NULL THEN
    RAISE EXCEPTION 'charge_credits_detailed: generation_id is required';
  END IF;

  p_tokens := lf_validate_credit_amount(p_tokens, 'charge_credits_detailed');

  -- Serialize concurrent operations on the same account.
  -- Prevents the charge+refund race under READ COMMITTED isolation.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- A charge confirms an existing reservation. Without this guard, an app bug
  -- could log a successful generation without ever deducting credits.
  SELECT amount INTO v_reserved_amount
  FROM credit_ledger
  WHERE account_id = p_account_id
    AND generation_id = p_generation_id
    AND type = 'reserve'
  LIMIT 1;

  IF NOT FOUND THEN
    status := 'missing_reserve';
    uncollectible := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_tokens <> v_reserved_amount THEN
    RAISE EXCEPTION 'charge_credits_detailed: amount % does not match reserved amount % for generation_id %', p_tokens, v_reserved_amount, p_generation_id;
  END IF;

  -- Fast path: already charged?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'charge'
  ) THEN
    status := 'duplicate';
    uncollectible := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Variable-cost settlement is terminal. Do not add a fixed charge after it.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'trueup'
  ) THEN
    status := 'already_settled';
    uncollectible := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Check if this generation was already refunded (out-of-order webhooks).
  -- If so, we must re-deduct because refund returned the credits.
  v_already_refunded := EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'refund'
  );

  IF v_already_refunded THEN
    SELECT COALESCE(tokens, 0) INTO v_balance
    FROM credits
    WHERE account_id = p_account_id;

    IF NOT FOUND THEN
      status := 'missing_account';
      uncollectible := 0;
      RETURN NEXT;
      RETURN;
    END IF;

    IF v_balance >= v_reserved_amount THEN
      v_can_deduct := v_reserved_amount;
    ELSE
      v_can_deduct := GREATEST(v_balance, 0);
      v_uncollectible := v_reserved_amount - v_can_deduct;
    END IF;

    IF v_can_deduct > 0 THEN
      UPDATE credits
      SET tokens = tokens - v_can_deduct,
          updated_at = NOW()
      WHERE account_id = p_account_id
      RETURNING tokens INTO v_balance;
    END IF;
  ELSE
    SELECT tokens INTO v_balance FROM credits WHERE account_id = p_account_id;
  END IF;

  v_charge_description := CASE
    WHEN v_already_refunded AND v_uncollectible > 0
      THEN 'baseline=refunded,uncollectible=' || v_uncollectible
    WHEN v_already_refunded
      THEN 'baseline=refunded'
    ELSE NULL
  END;

  -- Insert with unique_violation safety net (race between two concurrent charges).
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model, description)
    VALUES (p_account_id, 'charge', v_reserved_amount, v_balance, p_generation_id, p_model, v_charge_description);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent duplicate. If we re-deducted, undo it.
    IF v_already_refunded AND v_can_deduct > 0 THEN
      UPDATE credits
      SET tokens = tokens + v_can_deduct, updated_at = NOW()
      WHERE account_id = p_account_id;
    END IF;
    status := 'duplicate';
    uncollectible := 0;
    RETURN NEXT;
    RETURN;
  END;

  IF v_uncollectible > 0 THEN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model, description)
    VALUES (
      p_account_id,
      'uncollectible',
      v_uncollectible,
      v_balance,
      p_generation_id,
      p_model,
      'charge_after_refund_shortfall:' || p_generation_id
    );
  END IF;

  status := CASE WHEN v_uncollectible > 0 THEN 'shortfall' ELSE 'charged' END;
  uncollectible := v_uncollectible;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION charge_credits_detailed IS 'Confirm a reservation and return status. Distinguishes charged, duplicate/no-op, missing reserve, already settled, and shortfall outcomes.';

-- Boolean-compatible wrapper for existing callers. Use charge_credits_detailed
-- when the application needs to distinguish duplicate/no-op from shortfall.
CREATE OR REPLACE FUNCTION charge_credits(
  p_account_id    UUID,
  p_tokens        NUMERIC,
  p_generation_id TEXT,
  p_model         TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT status = 'charged'
  FROM charge_credits_detailed(p_account_id, p_tokens, p_generation_id, p_model)
  LIMIT 1;
$$;

COMMENT ON FUNCTION charge_credits IS 'Boolean-compatible charge wrapper. Use charge_credits_detailed for structured shortfall status.';

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
ALTER FUNCTION charge_credits_detailed(UUID, NUMERIC, TEXT, TEXT)       SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)                SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION get_uncollectible_total(UUID)                            SET search_path = pg_catalog, public;

DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)        FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION charge_credits_detailed(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)          FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION get_uncollectible_total(UUID)                      FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)        FROM anon;
    REVOKE EXECUTE ON FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT) FROM anon;
    REVOKE EXECUTE ON FUNCTION charge_credits_detailed(UUID, NUMERIC, TEXT, TEXT) FROM anon;
    REVOKE EXECUTE ON FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)          FROM anon;
    REVOKE EXECUTE ON FUNCTION get_uncollectible_total(UUID)                       FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)        FROM authenticated;
    REVOKE EXECUTE ON FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION charge_credits_detailed(UUID, NUMERIC, TEXT, TEXT) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)          FROM authenticated;
    REVOKE EXECUTE ON FUNCTION get_uncollectible_total(UUID)                       FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION clawback_credits(UUID, NUMERIC, TEXT, TEXT)        TO service_role;
    GRANT EXECUTE ON FUNCTION settle_credits(UUID, TEXT, NUMERIC, NUMERIC, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION charge_credits_detailed(UUID, NUMERIC, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)          TO service_role;
    GRANT EXECUTE ON FUNCTION get_uncollectible_total(UUID)                      TO service_role;
  END IF;
END $$;
