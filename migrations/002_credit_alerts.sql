-- ledger-fortress: 002_credit_alerts.sql
--
-- State-machine based low-balance notifications.
-- Each threshold fires exactly once per descent; resets when balance recovers.
--
-- Apply with: psql "$DATABASE_URL" < migrations/002_credit_alerts.sql
--
-- Copyright 2026 BabySea, Inc.
-- Licensed under the Apache License, Version 2.0.

-- ============================================================================
-- TABLE: credit_alert_settings
-- Per-account configuration for low-balance alerts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_alert_settings (
  account_id       UUID PRIMARY KEY,           -- FK to your accounts table
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  thresholds       NUMERIC[] NOT NULL DEFAULT '{0.500}',
  channel_in_app   BOOLEAN NOT NULL DEFAULT TRUE,
  channel_email    BOOLEAN NOT NULL DEFAULT TRUE,
  channel_webhook  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Safety: max 10 thresholds, all positive (validated by trigger)
  CONSTRAINT chk_thresholds_length CHECK (array_length(thresholds, 1) <= 10)
);

COMMENT ON TABLE credit_alert_settings IS 'Per-account threshold + channel config for low-balance alerts.';

-- Trigger: validate all thresholds are positive (cannot use subquery in CHECK)
CREATE OR REPLACE FUNCTION trg_validate_thresholds()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.thresholds) AS t WHERE t <= 0) THEN
    RAISE EXCEPTION 'All thresholds must be positive';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_thresholds ON credit_alert_settings;
CREATE TRIGGER validate_thresholds
  BEFORE INSERT OR UPDATE ON credit_alert_settings
  FOR EACH ROW EXECUTE FUNCTION trg_validate_thresholds();

-- ============================================================================
-- TABLE: credit_alert_log
-- Deduplication state machine.
-- No row = threshold is armed.
-- Row exists = threshold has fired (waiting for balance to recover).
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_alert_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  threshold   NUMERIC NOT NULL,
  balance     NUMERIC NOT NULL,              -- balance at time of firing
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One fire per (account, threshold) - the core of the state machine.
  UNIQUE (account_id, threshold)
);

COMMENT ON TABLE credit_alert_log IS 'Dedup state machine: armed (no row) ➜ fired (row exists) ➜ armed (row deleted on reset).';

-- ============================================================================
-- FUNCTION: check_credit_alerts(account_id)
--
-- Called after every reserve_credits. Returns newly-crossed thresholds.
-- Uses INSERT ... ON CONFLICT to atomically mark thresholds as fired.
-- Fire-and-forget: callers should never let this block the response.
-- ============================================================================

CREATE OR REPLACE FUNCTION check_credit_alerts(
  p_account_id UUID
)
RETURNS TABLE (
  threshold NUMERIC,
  balance   NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance    NUMERIC;
  v_enabled    BOOLEAN;
  v_thresholds NUMERIC[];
  v_threshold  NUMERIC;
BEGIN
  -- Get current balance
  SELECT tokens INTO v_balance
  FROM credits
  WHERE account_id = p_account_id;

  IF v_balance IS NULL THEN
    RETURN;
  END IF;

  -- Get alert settings (with defaults if no row exists)
  SELECT cas.enabled, cas.thresholds
  INTO v_enabled, v_thresholds
  FROM credit_alert_settings cas
  WHERE cas.account_id = p_account_id;

  -- Default: enabled with $0.50 threshold
  IF NOT FOUND THEN
    v_enabled := TRUE;
    v_thresholds := ARRAY[0.500];
  END IF;

  IF NOT v_enabled THEN
    RETURN;
  END IF;

  -- Check each threshold
  FOREACH v_threshold IN ARRAY v_thresholds LOOP
    IF v_balance < v_threshold THEN
      -- Try to mark as fired (INSERT). If already fired, unique_violation ➜ skip.
      BEGIN
        INSERT INTO credit_alert_log (account_id, threshold, balance)
        VALUES (p_account_id, v_threshold, v_balance);

        -- Successfully inserted = newly crossed threshold
        threshold := v_threshold;
        balance := v_balance;
        RETURN NEXT;
      EXCEPTION WHEN unique_violation THEN
        -- Already fired, skip
        NULL;
      END;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION check_credit_alerts IS 'Returns newly-crossed thresholds. Idempotent via unique constraint.';

-- ============================================================================
-- FUNCTION: reset_credit_alerts(account_id)
--
-- Called after add_credits or refund_credits. Deletes fired records
-- where balance has recovered above the threshold, re-arming them.
-- ============================================================================

CREATE OR REPLACE FUNCTION reset_credit_alerts(
  p_account_id UUID
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
  v_deleted INT;
BEGIN
  SELECT tokens INTO v_balance
  FROM credits
  WHERE account_id = p_account_id;

  IF v_balance IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM credit_alert_log
  WHERE account_id = p_account_id
    AND threshold <= v_balance;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION reset_credit_alerts IS 'Re-arms thresholds where balance has recovered above the threshold.';

-- ============================================================================
-- FUNCTION: get_credit_alert_settings(account_id)
-- Returns settings with defaults if no row exists.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_credit_alert_settings(
  p_account_id UUID
)
RETURNS TABLE (
  enabled         BOOLEAN,
  thresholds      NUMERIC[],
  channel_in_app  BOOLEAN,
  channel_email   BOOLEAN,
  channel_webhook BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(cas.enabled, TRUE),
    COALESCE(cas.thresholds, ARRAY[0.500]::NUMERIC[]),
    COALESCE(cas.channel_in_app, TRUE),
    COALESCE(cas.channel_email, TRUE),
    COALESCE(cas.channel_webhook, FALSE)
  FROM (SELECT 1) AS dummy
  LEFT JOIN credit_alert_settings cas ON cas.account_id = p_account_id;
END;
$$;

COMMENT ON FUNCTION get_credit_alert_settings IS 'Returns alert settings with defaults.';

-- ============================================================================
-- FUNCTION: upsert_credit_alert_settings(...)
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_credit_alert_settings(
  p_account_id      UUID,
  p_enabled         BOOLEAN DEFAULT TRUE,
  p_thresholds      NUMERIC[] DEFAULT '{0.500}',
  p_channel_in_app  BOOLEAN DEFAULT TRUE,
  p_channel_email   BOOLEAN DEFAULT TRUE,
  p_channel_webhook BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Validate thresholds
  IF array_length(p_thresholds, 1) > 10 THEN
    RAISE EXCEPTION 'Maximum 10 thresholds allowed';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_thresholds) AS t WHERE t <= 0) THEN
    RAISE EXCEPTION 'All thresholds must be positive';
  END IF;

  INSERT INTO credit_alert_settings (
    account_id, enabled, thresholds,
    channel_in_app, channel_email, channel_webhook, updated_at
  ) VALUES (
    p_account_id, p_enabled, p_thresholds,
    p_channel_in_app, p_channel_email, p_channel_webhook, NOW()
  )
  ON CONFLICT (account_id)
  DO UPDATE SET
    enabled = p_enabled,
    thresholds = p_thresholds,
    channel_in_app = p_channel_in_app,
    channel_email = p_channel_email,
    channel_webhook = p_channel_webhook,
    updated_at = NOW();
END;
$$;

COMMENT ON FUNCTION upsert_credit_alert_settings IS 'Create or update alert settings for an account.';
