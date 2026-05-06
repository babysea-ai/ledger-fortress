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
  missing text[];
BEGIN
  SELECT array_agg(table_name ORDER BY table_name)
  INTO missing
  FROM (
    VALUES
      ('plans'),
      ('credits'),
      ('credit_ledger'),
      ('credit_alert_settings'),
      ('credit_alert_log')
  ) AS expected(table_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = expected.table_name
      AND c.relrowsecurity
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is not enabled for tables: %', missing;
  END IF;
END $$;
SQL

echo "ledger-fortress: RLS is enabled on all fortress tables"
