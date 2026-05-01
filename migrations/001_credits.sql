-- ledger-fortress: 001_credits.sql
--
-- Atomic credit settlement for async AI workloads.
-- Apply with: psql "$DATABASE_URL" < migrations/001_credits.sql
--
-- Copyright 2026 BabySea, Inc.
-- Licensed under the Apache License, Version 2.0.

-- ============================================================================
-- EXTENSION: uuid
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: plans
-- Maps Stripe Price IDs to credit allocations.
-- 1 credit = $1 USD (configurable by the adopter).
-- ============================================================================

CREATE TABLE IF NOT EXISTS plans (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  variant_id  TEXT NOT NULL UNIQUE,            -- Stripe Price ID
  tokens      NUMERIC(10, 3) NOT NULL          -- credits granted per invoice
);

COMMENT ON TABLE plans IS 'Maps Stripe Price IDs to credit allocations. 1 credit = $1.';
COMMENT ON COLUMN plans.variant_id IS 'Stripe Price ID (e.g. price_xxx).';
COMMENT ON COLUMN plans.tokens IS 'Credits granted when this plan is purchased or renewed.';

-- ============================================================================
-- TABLE: credits
-- One row per account. The CHECK constraint prevents overdraw at the
-- database level - no application-level validation required.
-- ============================================================================

CREATE TABLE IF NOT EXISTS credits (
  account_id  UUID PRIMARY KEY,                -- FK to your accounts table
  tokens      NUMERIC(10, 3) NOT NULL DEFAULT 0
                CHECK (tokens >= 0),           -- overdraw protection
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE credits IS 'One row per account. Balance with CHECK >= 0 prevents overdraw.';

-- ============================================================================
-- TABLE: credit_ledger
-- Immutable audit trail. Every credit movement is logged here.
--
-- Types:
--   reserve  - credits deducted, generation started (balance reduced)
--   charge   - generation succeeded, confirm reservation (log-only, no balance change)
--   refund   - generation failed or cancelled, credits returned (balance increased)
--   add      - credits granted from Stripe invoice, credit pack, or manual grant
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL,               -- FK to your accounts table
  type            TEXT NOT NULL
                    CHECK (type IN ('reserve', 'charge', 'refund', 'add')),
  amount          NUMERIC(10, 3) NOT NULL CHECK (amount > 0),
  balance_after   NUMERIC(10, 3) NOT NULL,
  generation_id   TEXT,                         -- links generation settlement events to a generation
  model           TEXT,                         -- model identifier for audit
  description     TEXT,                         -- human-readable note
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE credit_ledger IS 'Immutable audit trail of every credit movement.';

-- ============================================================================
-- IDEMPOTENCY INDEXES
-- These unique partial indexes are the core of the fortress. They guarantee
-- exactly-once semantics at the database level, not the application level.
-- ============================================================================

-- One charge per generation. Second INSERT is a unique_violation ➜ no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_charge_idempotent
  ON credit_ledger (generation_id) WHERE type = 'charge';

-- One refund per generation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_refund_idempotent
  ON credit_ledger (generation_id) WHERE type = 'refund';

-- One add per (account, description). Prevents webhook-retry double-credit.
-- The description carries the idempotency key (e.g. "invoice:inv_xxx").
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_add_idempotent
  ON credit_ledger (account_id, description) WHERE type = 'add';

-- One reserve per generation. Prevents double-reservation on client retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_reserve_idempotent
  ON credit_ledger (generation_id) WHERE type = 'reserve' AND generation_id IS NOT NULL;

-- Fast lookup for crash recovery: find reservations without a matching terminal settlement.
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reserve_pending
  ON credit_ledger (generation_id, created_at) WHERE type = 'reserve';

-- Fast lookup for listing a user's ledger history.
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_created
  ON credit_ledger (account_id, created_at DESC);

-- ============================================================================
-- FUNCTION: lf_validate_credit_amount(amount, context, allow_zero)
--
-- Internal helper. All ledger amounts are stored as NUMERIC(10,3), so inputs
-- with more than three decimal places are rejected instead of silently rounded.
-- ============================================================================

CREATE OR REPLACE FUNCTION lf_validate_credit_amount(
  p_amount     NUMERIC,
  p_context    TEXT,
  p_allow_zero BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_amount IS NULL THEN
    RAISE EXCEPTION '%: amount is required', p_context;
  END IF;

  IF p_allow_zero THEN
    IF p_amount < 0 THEN
      RAISE EXCEPTION '%: amount must be non-negative', p_context;
    END IF;
  ELSIF p_amount <= 0 THEN
    RAISE EXCEPTION '%: amount must be positive', p_context;
  END IF;

  IF p_amount <> ROUND(p_amount, 3) THEN
    RAISE EXCEPTION '%: amount must have at most 3 decimal places', p_context;
  END IF;

  IF ABS(p_amount) > 9999999.999 THEN
    RAISE EXCEPTION '%: amount must be <= 9999999.999', p_context;
  END IF;

  RETURN p_amount;
END;
$$;

COMMENT ON FUNCTION lf_validate_credit_amount IS 'Internal helper: rejects ledger amounts with more than 3 decimal places.';

-- ============================================================================
-- FUNCTION: has_credits(account_id, tokens)
-- Pure check, no side effects. Returns TRUE if the account can afford `tokens`.
-- ============================================================================

CREATE OR REPLACE FUNCTION has_credits(
  p_account_id UUID,
  p_tokens     NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 OR p_tokens <> ROUND(p_tokens, 3) THEN
    RETURN FALSE;
  END IF;

  RETURN (
    SELECT tokens >= p_tokens
    FROM credits
    WHERE account_id = p_account_id
  );
END;
$$;

COMMENT ON FUNCTION has_credits IS 'Returns TRUE if the account has at least p_tokens credits.';

-- ============================================================================
-- FUNCTION: reserve_credits(account_id, tokens, generation_id, model)
--
-- Atomically check and deduct credits in a single UPDATE. No separate SELECT.
-- This eliminates TOCTOU race conditions entirely.
--
-- Returns TRUE if the reservation succeeded, FALSE if insufficient balance.
-- ============================================================================

CREATE OR REPLACE FUNCTION reserve_credits(
  p_account_id    UUID,
  p_tokens        NUMERIC,
  p_generation_id TEXT DEFAULT NULL,
  p_model         TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance NUMERIC;
  v_existing_account UUID;
  v_existing_amount NUMERIC;
BEGIN
  p_tokens := lf_validate_credit_amount(p_tokens, 'reserve_credits');

  -- Idempotent retry: if the caller already reserved this generation, report
  -- success without deducting again. This covers client/network retries after
  -- the first reserve committed but the response was lost.
  IF p_generation_id IS NOT NULL THEN
    SELECT account_id, amount INTO v_existing_account, v_existing_amount
    FROM credit_ledger
    WHERE generation_id = p_generation_id
      AND type = 'reserve'
    LIMIT 1;

    IF FOUND THEN
      IF v_existing_account = p_account_id AND v_existing_amount <> p_tokens THEN
        RAISE EXCEPTION 'reserve_credits: idempotency conflict for generation_id %; existing amount % does not match requested amount %', p_generation_id, v_existing_amount, p_tokens;
      END IF;

      RETURN v_existing_account = p_account_id;
    END IF;
  END IF;

  -- Single atomic UPDATE with WHERE guard.
  -- If tokens < p_tokens, zero rows updated ➜ reservation fails.
  UPDATE credits
  SET tokens = tokens - p_tokens,
      updated_at = NOW()
  WHERE account_id = p_account_id
    AND tokens >= p_tokens
  RETURNING tokens INTO v_new_balance;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Log the reservation.
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model)
    VALUES (p_account_id, 'reserve', p_tokens, v_new_balance, p_generation_id, p_model);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent duplicate reserve won the race after our UPDATE. Roll back
    -- only this reserve's balance deduction, then return success if the
    -- existing reservation belongs to the same account.
    UPDATE credits
    SET tokens = tokens + p_tokens,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    IF p_generation_id IS NOT NULL THEN
      SELECT account_id, amount INTO v_existing_account, v_existing_amount
      FROM credit_ledger
      WHERE generation_id = p_generation_id
        AND type = 'reserve'
      LIMIT 1;

      IF v_existing_account = p_account_id AND v_existing_amount <> p_tokens THEN
        RAISE EXCEPTION 'reserve_credits: idempotency conflict for generation_id %; existing amount % does not match requested amount %', p_generation_id, v_existing_amount, p_tokens;
      END IF;

      RETURN v_existing_account = p_account_id;
    END IF;

    RETURN FALSE;
  END;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION reserve_credits IS 'Atomically deduct credits. Returns FALSE if balance insufficient.';

-- ============================================================================
-- FUNCTION: charge_credits(account_id, tokens, generation_id, model)
--
-- Confirms a reservation after successful generation.
-- Log-only: NO balance change (credits were already deducted at reserve time).
--
-- Idempotent: second call for the same generation_id is a no-op.
-- ============================================================================

CREATE OR REPLACE FUNCTION charge_credits(
  p_account_id    UUID,
  p_tokens        NUMERIC,
  p_generation_id TEXT,
  p_model         TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
  v_already_refunded BOOLEAN;
  v_reserved_amount NUMERIC;
BEGIN
  IF p_generation_id IS NULL THEN
    RAISE EXCEPTION 'charge_credits: generation_id is required';
  END IF;
  p_tokens := lf_validate_credit_amount(p_tokens, 'charge_credits');

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
    RETURN FALSE;
  END IF;

  IF p_tokens <> v_reserved_amount THEN
    RAISE EXCEPTION 'charge_credits: amount % does not match reserved amount % for generation_id %', p_tokens, v_reserved_amount, p_generation_id;
  END IF;

  -- Fast path: already charged?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'charge'
  ) THEN
    RETURN FALSE;  -- idempotent no-op
  END IF;

  -- Variable-cost settlement is terminal. Do not add a fixed charge after it.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'trueup'
  ) THEN
    RETURN FALSE;
  END IF;

  -- Check if this generation was already refunded (out-of-order webhooks).
  -- If so, we must re-deduct the balance since refund returned the credits.
  v_already_refunded := EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'refund'
  );

  IF v_already_refunded THEN
    -- Re-deduct: credits were returned by refund, but generation succeeded.
    UPDATE credits
    SET tokens = tokens - v_reserved_amount,
        updated_at = NOW()
    WHERE account_id = p_account_id
      AND tokens >= v_reserved_amount
    RETURNING tokens INTO v_balance;

    IF NOT FOUND THEN
      -- Insufficient balance to re-deduct after a prior refund. Do not mark
      -- the generation charged; the application can retry, pause the account,
      -- or settle via an explicit uncollectible flow.
      RETURN FALSE;
    END IF;
  ELSE
    SELECT tokens INTO v_balance FROM credits WHERE account_id = p_account_id;
  END IF;

  -- Insert with unique_violation safety net (race between two concurrent charges).
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model)
    VALUES (p_account_id, 'charge', v_reserved_amount, v_balance, p_generation_id, p_model);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent duplicate. If we re-deducted, undo it.
    IF v_already_refunded THEN
      UPDATE credits
      SET tokens = tokens + v_reserved_amount, updated_at = NOW()
      WHERE account_id = p_account_id;
    END IF;
    RETURN FALSE;  -- concurrent duplicate, idempotent no-op
  END;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION charge_credits IS 'Confirm a reservation (log-only). Idempotent via unique index.';

-- ============================================================================
-- FUNCTION: refund_credits(account_id, tokens, generation_id, model)
--
-- Returns reserved credits to the account after a failed or cancelled generation.
--
-- Three guards:
--   1. If already charged ➜ do NOT refund (prevents: reserve ➜ charge ➜ crash ➜ refund ➜ free output)
--   2. If already settled via true-up ➜ do NOT refund
--   3. If already refunded ➜ no-op
--
-- Idempotent: safe to call from webhooks, crash recovery, and cancel endpoints.
-- ============================================================================

CREATE OR REPLACE FUNCTION refund_credits(
  p_account_id    UUID,
  p_tokens        NUMERIC,
  p_generation_id TEXT,
  p_model         TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance NUMERIC;
  v_reserved_amount NUMERIC;
BEGIN
  IF p_generation_id IS NULL THEN
    RAISE EXCEPTION 'refund_credits: generation_id is required';
  END IF;
  p_tokens := lf_validate_credit_amount(p_tokens, 'refund_credits');

  -- Serialize concurrent operations on the same account.
  -- Prevents the charge+refund race under READ COMMITTED isolation.
  PERFORM 1 FROM credits WHERE account_id = p_account_id FOR UPDATE;

  -- A refund reverses an existing reservation. Never mint credits for a
  -- generation that was not reserved.
  SELECT amount INTO v_reserved_amount
  FROM credit_ledger
  WHERE account_id = p_account_id
    AND generation_id = p_generation_id
    AND type = 'reserve'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF p_tokens <> v_reserved_amount THEN
    RAISE EXCEPTION 'refund_credits: amount % does not match reserved amount % for generation_id %', p_tokens, v_reserved_amount, p_generation_id;
  END IF;

  -- Guard 1: If already charged, do NOT refund.
  -- This prevents the deadly sequence: reserve ➜ webhook charges ➜ crash ➜ refund ➜ free output.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'charge'
  ) THEN
    RETURN FALSE;
  END IF;

  -- Guard 2: If already settled via variable-cost true-up, do NOT refund.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'trueup'
  ) THEN
    RETURN FALSE;
  END IF;

  -- Guard 3: If already refunded, no-op.
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE generation_id = p_generation_id AND type = 'refund'
  ) THEN
    RETURN FALSE;
  END IF;

  -- Return credits to the balance.
  UPDATE credits
  SET tokens = tokens + v_reserved_amount,
      updated_at = NOW()
  WHERE account_id = p_account_id
  RETURNING tokens INTO v_new_balance;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Log the refund with unique_violation safety net.
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, generation_id, model)
    VALUES (p_account_id, 'refund', v_reserved_amount, v_new_balance, p_generation_id, p_model);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent refund won the race. Roll back the balance change.
    UPDATE credits
    SET tokens = tokens - v_reserved_amount,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    RETURN FALSE;
  END;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION refund_credits IS 'Return reserved credits. Guards against charge-then-refund and double-refund.';

-- ============================================================================
-- FUNCTION: add_credits(account_id, tokens, description, idempotency_key)
--
-- Grant credits from a Stripe invoice, credit pack purchase, or manual grant.
-- Additive (rollover): always adds to existing balance, never resets.
--
-- The description serves as the idempotency key via the unique partial index.
-- Convention: "invoice:{stripe_invoice_id}" or "order:{stripe_order_id}".
--
-- Idempotent: safe to call from Stripe webhook retries.
-- ============================================================================

CREATE OR REPLACE FUNCTION add_credits(
  p_account_id      UUID,
  p_tokens          NUMERIC,
  p_description     TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance NUMERIC;
  v_desc        TEXT;
BEGIN
  p_tokens := lf_validate_credit_amount(p_tokens, 'add_credits');

  -- Use idempotency_key as description if provided, else use p_description.
  v_desc := NULLIF(TRIM(COALESCE(p_idempotency_key, p_description)), '');

  IF v_desc IS NULL THEN
    RAISE EXCEPTION 'add_credits: description or idempotency_key is required';
  END IF;

  -- Fast path: already added?
  IF EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE account_id = p_account_id AND description = v_desc AND type = 'add'
  ) THEN
    RETURN FALSE;  -- idempotent no-op
  END IF;

  -- Add credits to balance.
  INSERT INTO credits (account_id, tokens, updated_at)
  VALUES (p_account_id, p_tokens, NOW())
  ON CONFLICT (account_id)
  DO UPDATE SET tokens = credits.tokens + p_tokens,
                updated_at = NOW()
  RETURNING tokens INTO v_new_balance;

  -- Log the addition.
  BEGIN
    INSERT INTO credit_ledger (account_id, type, amount, balance_after, description)
    VALUES (p_account_id, 'add', p_tokens, v_new_balance, v_desc);
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent add won the race. Roll back the balance change.
    UPDATE credits
    SET tokens = tokens - p_tokens,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    RETURN FALSE;
  END;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION add_credits IS 'Grant credits (additive/rollover). Idempotent via description key.';

-- ============================================================================
-- FUNCTION: list_credit_ledger(account_id, type, lim, off)
--
-- Paginated ledger history for UI display or API response.
-- ============================================================================

CREATE OR REPLACE FUNCTION list_credit_ledger(
  p_account_id UUID,
  p_type       TEXT DEFAULT NULL,
  p_limit      INT DEFAULT 50,
  p_offset     INT DEFAULT 0
)
RETURNS TABLE (
  id            UUID,
  type          TEXT,
  amount        NUMERIC,
  balance_after NUMERIC,
  generation_id TEXT,
  model         TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.id,
    cl.type,
    cl.amount,
    cl.balance_after,
    cl.generation_id,
    cl.model,
    cl.description,
    cl.created_at
  FROM credit_ledger cl
  WHERE cl.account_id = p_account_id
    AND (p_type IS NULL OR cl.type = p_type)
  ORDER BY cl.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION list_credit_ledger IS 'Paginated ledger history for a given account.';

-- ============================================================================
-- FUNCTION: get_balance(account_id)
-- Returns the current credit balance for an account.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_balance(
  p_account_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  SELECT tokens INTO v_balance
  FROM credits
  WHERE account_id = p_account_id;

  RETURN COALESCE(v_balance, 0);
END;
$$;

COMMENT ON FUNCTION get_balance IS 'Returns the current credit balance for an account.';

-- ============================================================================
-- FUNCTION: get_plan_credits(variant_id)
-- Returns the configured credit allocation for a Stripe Price ID.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_plan_credits(
  p_variant_id TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tokens NUMERIC;
BEGIN
  IF p_variant_id IS NULL OR TRIM(p_variant_id) = '' THEN
    RETURN NULL;
  END IF;

  SELECT tokens INTO v_tokens
  FROM plans
  WHERE variant_id = p_variant_id;

  RETURN v_tokens;
END;
$$;

COMMENT ON FUNCTION get_plan_credits IS 'Returns credits configured for a Stripe Price ID, or NULL when not configured.';

-- ============================================================================
-- FUNCTION: find_orphaned_reservations(window_minutes, lim)
--
-- Used by crash recovery. Finds reservations older than `window_minutes`
-- that have no matching charge, refund, or true-up settlement.
-- ============================================================================

CREATE OR REPLACE FUNCTION find_orphaned_reservations(
  p_window_minutes INT DEFAULT 5,
  p_limit          INT DEFAULT 100
)
RETURNS TABLE (
  ledger_id     UUID,
  account_id    UUID,
  generation_id TEXT,
  amount        NUMERIC,
  model         TEXT,
  reserved_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.id         AS ledger_id,
    cl.account_id,
    cl.generation_id,
    cl.amount,
    cl.model,
    cl.created_at AS reserved_at
  FROM credit_ledger cl
  WHERE cl.type = 'reserve'
    AND cl.generation_id IS NOT NULL
    AND cl.created_at < NOW() - (p_window_minutes || ' minutes')::INTERVAL
    AND NOT EXISTS (
      SELECT 1 FROM credit_ledger cl2
      WHERE cl2.generation_id = cl.generation_id
        AND cl2.type IN ('charge', 'refund', 'trueup')
    )
  ORDER BY cl.created_at ASC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION find_orphaned_reservations IS 'Finds reservations with no settlement, older than the given window.';
