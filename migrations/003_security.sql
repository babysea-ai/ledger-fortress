-- ledger-fortress: 003_security.sql
--
-- Production hardening: Row Level Security and function security.
--
-- This migration enforces a strict security boundary: ledger-fortress tables
-- are NEVER exposed to client-side code (anon/authenticated roles in Supabase).
-- All access goes through:
--   1. Direct Postgres connection (your backend with the service-role key), OR
--   2. The provided RPC functions, which run with SECURITY DEFINER.
--
-- Apply with: psql "$DATABASE_URL" < migrations/003_security.sql
--
-- Copyright 2026 BabySea, Inc.
-- Licensed under the Apache License, Version 2.0.

-- ============================================================================
-- ENABLE ROW LEVEL SECURITY
--
-- All tables are RLS-enabled with NO policies = deny-all to anon/authenticated.
-- Only the service role (and direct Postgres connections) can read/write.
--
-- Why no per-account RLS policies?
--   ledger-fortress is a backend library. Your application enforces
--   authorization at the API layer before calling fortress methods.
--   The credit ledger must be tamper-proof - it must NEVER be writable
--   from a client even with a JWT.
-- ============================================================================

ALTER TABLE plans                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits                ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_alert_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_alert_log       ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owners too. By default, table owners bypass RLS.
-- This ensures even a leaked owner role cannot bypass policies.
ALTER TABLE plans                  FORCE ROW LEVEL SECURITY;
ALTER TABLE credits                FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger          FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_alert_settings  FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_alert_log       FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE plans IS 'RLS deny-all. Access only via service-role or direct connection.';
COMMENT ON TABLE credits IS 'RLS deny-all. Tamper-proof balance, write only via fortress functions.';
COMMENT ON TABLE credit_ledger IS 'RLS deny-all. Immutable audit trail, write only via fortress functions.';
COMMENT ON TABLE credit_alert_settings IS 'RLS deny-all. Manage via fortress.setAlertSettings().';
COMMENT ON TABLE credit_alert_log IS 'RLS deny-all. Internal state machine.';

-- ============================================================================
-- REVOKE PRIVILEGES from anon and authenticated roles
--
-- Belt-and-suspenders: even if RLS is later weakened, these roles cannot
-- access the tables.
-- ============================================================================

DO $$
BEGIN
  -- Only revoke if these roles exist (they do on Supabase, may not on plain Postgres).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON plans                  FROM anon;
    REVOKE ALL ON credits                FROM anon;
    REVOKE ALL ON credit_ledger          FROM anon;
    REVOKE ALL ON credit_alert_settings  FROM anon;
    REVOKE ALL ON credit_alert_log       FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON plans                  FROM authenticated;
    REVOKE ALL ON credits                FROM authenticated;
    REVOKE ALL ON credit_ledger          FROM authenticated;
    REVOKE ALL ON credit_alert_settings  FROM authenticated;
    REVOKE ALL ON credit_alert_log       FROM authenticated;
  END IF;
END $$;

-- ============================================================================
-- HARDEN FUNCTIONS: SECURITY DEFINER + locked search_path
--
-- All fortress mutating functions run as the function owner (postgres) with a
-- locked search_path. This:
--   1. Lets your backend call functions even with a low-privilege role.
--   2. Prevents search_path injection attacks (CVE-2018-1058 class).
--
-- We use SET search_path = pg_catalog, public to ensure the function always
-- resolves built-ins from pg_catalog and our own tables from public.
-- ============================================================================

-- Mutating functions: SECURITY DEFINER (run as owner)
ALTER FUNCTION reserve_credits(UUID, NUMERIC, TEXT, TEXT)        SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)         SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION refund_credits(UUID, NUMERIC, TEXT, TEXT)         SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION add_credits(UUID, NUMERIC, TEXT, TEXT)            SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION check_credit_alerts(UUID)                         SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION reset_credit_alerts(UUID)                         SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION upsert_credit_alert_settings(UUID, BOOLEAN, NUMERIC[], BOOLEAN, BOOLEAN, BOOLEAN)
                                                                 SECURITY DEFINER SET search_path = pg_catalog, public;

-- Read-only functions: SECURITY INVOKER (default) is fine, but lock search_path.
ALTER FUNCTION has_credits(UUID, NUMERIC)                        SET search_path = pg_catalog, public;
ALTER FUNCTION get_balance(UUID)                                 SET search_path = pg_catalog, public;
ALTER FUNCTION list_credit_ledger(UUID, TEXT, INT, INT)          SET search_path = pg_catalog, public;
ALTER FUNCTION find_orphaned_reservations(INT, INT)              SET search_path = pg_catalog, public;
ALTER FUNCTION get_credit_alert_settings(UUID)                   SET search_path = pg_catalog, public;
ALTER FUNCTION trg_validate_thresholds()                         SET search_path = pg_catalog, public;

-- ============================================================================
-- REVOKE function execute from anon
--
-- If you want to expose any read-only function to anon (for status pages, etc.),
-- explicitly GRANT it after this migration. Default is deny.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION has_credits(UUID, NUMERIC)                         FROM anon;
    REVOKE EXECUTE ON FUNCTION get_balance(UUID)                                  FROM anon;
    REVOKE EXECUTE ON FUNCTION reserve_credits(UUID, NUMERIC, TEXT, TEXT)         FROM anon;
    REVOKE EXECUTE ON FUNCTION charge_credits(UUID, NUMERIC, TEXT, TEXT)          FROM anon;
    REVOKE EXECUTE ON FUNCTION refund_credits(UUID, NUMERIC, TEXT, TEXT)          FROM anon;
    REVOKE EXECUTE ON FUNCTION add_credits(UUID, NUMERIC, TEXT, TEXT)             FROM anon;
    REVOKE EXECUTE ON FUNCTION list_credit_ledger(UUID, TEXT, INT, INT)           FROM anon;
    REVOKE EXECUTE ON FUNCTION find_orphaned_reservations(INT, INT)               FROM anon;
    REVOKE EXECUTE ON FUNCTION check_credit_alerts(UUID)                          FROM anon;
    REVOKE EXECUTE ON FUNCTION reset_credit_alerts(UUID)                          FROM anon;
    REVOKE EXECUTE ON FUNCTION get_credit_alert_settings(UUID)                    FROM anon;
    REVOKE EXECUTE ON FUNCTION upsert_credit_alert_settings(UUID, BOOLEAN, NUMERIC[], BOOLEAN, BOOLEAN, BOOLEAN) FROM anon;
  END IF;
END $$;
