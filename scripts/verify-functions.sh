#!/usr/bin/env bash
# Copyright 2026 BabySea, Inc.
# Licensed under the Apache License, Version 2.0.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  missing_security_definer text[];
  missing_search_path text[];
BEGIN
  SELECT array_agg(p.proname ORDER BY p.proname)
  INTO missing_security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'reserve_credits',
      'charge_credits',
      'refund_credits',
      'add_credits',
      'check_credit_alerts',
      'reset_credit_alerts',
      'upsert_credit_alert_settings',
      'get_plan_credits'
    )
    AND NOT p.prosecdef;

  IF missing_security_definer IS NOT NULL THEN
    RAISE EXCEPTION 'functions are not SECURITY DEFINER: %', missing_security_definer;
  END IF;

  SELECT array_agg(p.proname ORDER BY p.proname)
  INTO missing_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'reserve_credits',
      'charge_credits',
      'refund_credits',
      'add_credits',
      'check_credit_alerts',
      'reset_credit_alerts',
      'upsert_credit_alert_settings',
      'has_credits',
      'get_balance',
      'get_plan_credits',
      'list_credit_ledger',
      'find_orphaned_reservations',
      'get_credit_alert_settings',
      'trg_validate_thresholds',
      'lf_validate_credit_amount'
    )
    AND NOT COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, public'];

  IF missing_search_path IS NOT NULL THEN
    RAISE EXCEPTION 'functions are missing locked search_path: %', missing_search_path;
  END IF;
END $$;
SQL

echo "ledger-fortress: mutating functions and search_path settings are hardened"
