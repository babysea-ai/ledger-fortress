#!/usr/bin/env bash
# Copyright 2026 BabySea, Inc.
# Licensed under the Apache License, Version 2.0.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

check_role_denied() {
  local role="$1"
  local exists
  local output
  exists=$(psql "$DATABASE_URL" -At -c "select exists(select 1 from pg_roles where rolname = '$role')")

  if [[ "$exists" != "t" ]]; then
    echo "ledger-fortress: role '$role' does not exist; skipping direct denial check"
    return 0
  fi

  output=$(mktemp)
  for table in plans credits credit_ledger credit_alert_settings credit_alert_log; do
    expect_denied "$role" "read public.$table" "select count(*) from public.$table" "$output"
  done

  expect_denied "$role" "insert public.plans" "insert into public.plans (name, variant_id, tokens) values ('denied', 'price_denied', 1.000)" "$output"
  expect_denied "$role" "insert public.credits" "insert into public.credits (account_id, tokens) values ('00000000-0000-0000-0000-000000000001'::uuid, 1.000)" "$output"
  expect_denied "$role" "insert public.credit_ledger" "insert into public.credit_ledger (account_id, type, amount, balance_after) values ('00000000-0000-0000-0000-000000000001'::uuid, 'add', 1.000, 1.000)" "$output"
  expect_denied "$role" "insert public.credit_alert_settings" "insert into public.credit_alert_settings (account_id) values ('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "insert public.credit_alert_log" "insert into public.credit_alert_log (account_id, threshold, balance) values ('00000000-0000-0000-0000-000000000001'::uuid, 1.000, 0.500)" "$output"

  expect_denied "$role" "update public.credits" "update public.credits set tokens = tokens + 1 where account_id = '00000000-0000-0000-0000-000000000001'::uuid" "$output"
  expect_denied "$role" "delete public.credit_ledger" "delete from public.credit_ledger where account_id = '00000000-0000-0000-0000-000000000001'::uuid" "$output"

  expect_denied "$role" "execute has_credits" "select public.has_credits('00000000-0000-0000-0000-000000000001'::uuid, 1.000)" "$output"
  expect_denied "$role" "execute get_balance" "select public.get_balance('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "execute get_plan_credits" "select public.get_plan_credits('price_probe')" "$output"
  expect_denied "$role" "execute reserve_credits" "select public.reserve_credits('00000000-0000-0000-0000-000000000001'::uuid, 1.000, 'denied_probe', 'probe')" "$output"
  expect_denied "$role" "execute charge_credits" "select public.charge_credits('00000000-0000-0000-0000-000000000001'::uuid, 1.000, 'denied_probe', 'probe')" "$output"
  expect_denied "$role" "execute refund_credits" "select public.refund_credits('00000000-0000-0000-0000-000000000001'::uuid, 1.000, 'denied_probe', 'probe')" "$output"
  expect_denied "$role" "execute add_credits" "select public.add_credits('00000000-0000-0000-0000-000000000001'::uuid, 1.000, 'denied probe', 'denied:probe')" "$output"
  expect_denied "$role" "execute list_credit_ledger" "select * from public.list_credit_ledger('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "execute find_orphaned_reservations" "select * from public.find_orphaned_reservations(5, 10)" "$output"
  expect_denied "$role" "execute check_credit_alerts" "select * from public.check_credit_alerts('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "execute reset_credit_alerts" "select public.reset_credit_alerts('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "execute get_credit_alert_settings" "select public.get_credit_alert_settings('00000000-0000-0000-0000-000000000001'::uuid)" "$output"
  expect_denied "$role" "execute upsert_credit_alert_settings" "select public.upsert_credit_alert_settings('00000000-0000-0000-0000-000000000001'::uuid, true, array[1.000], true, false, false)" "$output"
  rm -f "$output"
  echo "ledger-fortress: role '$role' is denied table reads and fortress RPC execution"
}

expect_denied() {
  local role="$1"
  local label="$2"
  local sql="$3"
  local output="$4"

  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "begin; set local role $role; $sql; rollback" >"$output" 2>&1; then
    echo "ledger-fortress: role '$role' unexpectedly succeeded: $label" >&2
    cat "$output" >&2
    exit 1
  fi
}

check_role_denied anon
check_role_denied authenticated
