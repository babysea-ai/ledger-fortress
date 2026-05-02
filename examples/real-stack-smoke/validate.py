#!/usr/bin/env python3
# Copyright 2026 BabySea, Inc.
# Licensed under the Apache License, Version 2.0.

"""Safe real-service smoke validation for Stripe + Supabase/Postgres.

The harness applies ledger-fortress migrations inside a disposable Supabase
schema, creates a disposable Stripe test customer, exercises the credit ledger
state machine, and cleans everything up by default.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

try:
    import psycopg
    from psycopg import sql
except ImportError as exc:  # pragma: no cover - exercised by operator setup
    raise SystemExit(
        'Missing dependency: install with `pip install "psycopg[binary]>=3.2"`.',
    ) from exc


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = [
    ROOT / 'migrations' / '001_credits.sql',
    ROOT / 'migrations' / '002_credit_alerts.sql',
    ROOT / 'migrations' / '003_security.sql',
    ROOT / 'migrations' / '004_clawback_and_trueup.sql',
]


@dataclass
class SmokeResult:
    run_id: str
    schema: str
    ok: bool = False
    error: str | None = None
    stripe_customer_created: bool = False
    stripe_customer_deleted: bool = False
    supabase_schema_dropped: bool = False
    assertions: list[str] = field(default_factory=list)

    def sanitized(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'status': 'ok' if self.ok else 'failed',
            'run_id': self.run_id,
            'schema': self.schema,
            'stripe': {
                'mode': 'test',
                'customer_created': self.stripe_customer_created,
                'customer_deleted': self.stripe_customer_deleted,
            },
            'supabase': {
                'migrations_applied': len(MIGRATIONS),
                'schema_dropped': self.supabase_schema_dropped,
            },
            'assertions': self.assertions,
        }
        if self.error:
            payload['error'] = self.error
        return payload


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, '') else default


def require_env(*names: str) -> str:
    for name in names:
        value = env(name)
        if value:
            return value
    joined = ' or '.join(names)
    raise SystemExit(f'Missing required environment variable: {joined}')


def build_database_url() -> str:
    direct = env('SUPABASE_DATABASE_URL') or env('DATABASE_URL')
    if direct:
        return direct

    project_id = require_env('SUPABASE_PROJECT_ID')
    password = require_env('SUPABASE_DB_PASSWORD')
    user = env('SUPABASE_DB_USER', f'postgres.{project_id}')
    host = env('SUPABASE_DB_HOST') or env(
        'SUPABASE_POOLER_HOST',
        'aws-1-us-east-1.pooler.supabase.com',
    )
    port = env('SUPABASE_DB_PORT') or env('SUPABASE_POOLER_PORT', '5432')
    database = env('SUPABASE_DB_NAME', 'postgres')
    query = urllib.parse.urlencode({'sslmode': env('SUPABASE_SSLMODE', 'require')})
    return (
        'postgresql://'
        f'{urllib.parse.quote(user or "", safe="")}:'
        f'{urllib.parse.quote(password, safe="")}@{host}:{port}/{database}?{query}'
    )


def stripe_key() -> str:
    key = require_env('STRIPE_SECRET_KEY', 'STRIPE_SECRET')
    if not (key.startswith('sk_test_') or key.startswith('rk_test_')):
        raise SystemExit('Refusing to run with a non-test Stripe key.')
    return key


def stripe_request(
    secret_key: str,
    method: str,
    path: str,
    data: dict[str, str] | None = None,
) -> dict[str, Any]:
    encoded = urllib.parse.urlencode(data or {}).encode()
    request = urllib.request.Request(
        f'https://api.stripe.com{path}',
        data=encoded if method != 'GET' else None,
        method=method,
    )
    token = base64.b64encode(f'{secret_key}:'.encode()).decode()
    request.add_header('Authorization', f'Basic {token}')
    request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    request.add_header('Stripe-Version', '2025-04-30.basil')

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors='replace')
        try:
            payload = json.loads(body)
            message = payload.get('error', {}).get('message', body)
        except json.JSONDecodeError:
            message = body
        raise RuntimeError(f'Stripe API {method} {path} failed: HTTP {exc.code}: {message}') from exc


def create_stripe_customer(secret_key: str, run_id: str, account_id: str) -> str:
    payload = stripe_request(
        secret_key,
        'POST',
        '/v1/customers',
        {
            'email': f'ledger-fortress-smoke+{run_id}@example.invalid',
            'name': f'ledger-fortress smoke {run_id}',
            'metadata[ledger_fortress_smoke]': 'true',
            'metadata[run_id]': run_id,
            'metadata[account_id]': account_id,
        },
    )
    customer_id = payload.get('id')
    if not isinstance(customer_id, str) or not customer_id.startswith('cus_'):
        raise RuntimeError('Stripe customer creation did not return a customer id')
    return customer_id


def delete_stripe_customer(secret_key: str, customer_id: str) -> bool:
    payload = stripe_request(secret_key, 'DELETE', f'/v1/customers/{customer_id}')
    return bool(payload.get('deleted'))


def transformed_migration(path: Path, schema_name: str) -> str:
    text = path.read_text()
    locked_path = f'SET search_path = pg_catalog, {schema_name}, public, extensions'
    return text.replace('SET search_path = pg_catalog, public', locked_path)


def set_search_path(cur: psycopg.Cursor[Any], schema_name: str) -> None:
    cur.execute(
        sql.SQL('SET search_path TO {}, public, extensions, pg_catalog').format(
            sql.Identifier(schema_name),
        ),
    )


def expect(result: SmokeResult, condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    result.assertions.append(label)


def scalar(cur: psycopg.Cursor[Any], query: Any, params: tuple[Any, ...] = ()) -> Any:
    cur.execute(query, params)
    row = cur.fetchone()
    return row[0] if row else None


def decimal_eq(value: Any, expected: str) -> bool:
    return Decimal(str(value)).quantize(Decimal('0.001')) == Decimal(expected)


def apply_migrations(conn: psycopg.Connection[Any], schema_name: str) -> None:
    with conn.cursor() as cur:
        cur.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema_name)))
        set_search_path(cur, schema_name)
        for path in MIGRATIONS:
            cur.execute(sql.SQL(cast(Any, transformed_migration(path, schema_name))))
    conn.commit()


def validate_rls(cur: psycopg.Cursor[Any], result: SmokeResult, schema_name: str) -> None:
    cur.execute(
        """
        SELECT relname, relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = %s
          AND relname IN ('plans', 'credits', 'credit_ledger', 'credit_alert_settings', 'credit_alert_log')
        ORDER BY relname
        """,
        (schema_name,),
    )
    rows = cur.fetchall()
    expect(result, len(rows) == 5, 'all five ledger tables exist')
    expect(result, all(row[1] for row in rows), 'RLS enabled on all ledger tables')

    cur.execute("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")
    for (role,) in cur.fetchall():
        for table in ['plans', 'credits', 'credit_ledger', 'credit_alert_settings', 'credit_alert_log']:
            qualified = f'{schema_name}.{table}'
            for privilege in ['SELECT', 'INSERT', 'UPDATE', 'DELETE']:
                allowed = scalar(cur, 'SELECT has_table_privilege(%s, %s, %s)', (role, qualified, privilege))
                expect(result, allowed is False, f'{role} cannot {privilege} {table}')


def exercise_ledger(
    conn: psycopg.Connection[Any],
    result: SmokeResult,
    schema_name: str,
    run_id: str,
    stripe_customer_id: str,
) -> None:
    account_a = str(uuid.uuid4())
    account_b = str(uuid.uuid4())
    account_c = str(uuid.uuid4())

    with conn.cursor() as cur:
        set_search_path(cur, schema_name)

        invoice_key = f'invoice:smoke:{run_id}'
        added = scalar(
            cur,
            'SELECT add_credits(%s, %s, %s, %s)',
            (account_a, Decimal('29.000'), 'subscription invoice smoke', invoice_key),
        )
        expect(result, added is True, 'Stripe invoice-style credit grant succeeds')

        duplicate = scalar(
            cur,
            'SELECT add_credits(%s, %s, %s, %s)',
            (account_a, Decimal('29.000'), 'subscription invoice smoke', invoice_key),
        )
        expect(result, duplicate is False, 'duplicate invoice idempotency key no-ops')

        order_key = f'order:{stripe_customer_id}:{run_id}'
        checkout_added = scalar(
            cur,
            'SELECT add_credits(%s, %s, %s, %s)',
            (account_a, Decimal('10.000'), 'checkout credit pack smoke', order_key),
        )
        expect(result, checkout_added is True, 'Stripe checkout-style credit pack grant succeeds')

        balance = scalar(cur, 'SELECT get_balance(%s)', (account_a,))
        expect(result, decimal_eq(balance, '39.000'), 'additive grants preserve rollover balance')

        gen_charge = f'gen_smoke_charge_{run_id}'
        reserved = scalar(
            cur,
            'SELECT reserve_credits(%s, %s, %s, %s)',
            (account_a, Decimal('1.250'), gen_charge, 'smoke/model'),
        )
        expect(result, reserved is True, 'reserve_credits succeeds atomically')
        cur.execute(
            'SELECT status, uncollectible FROM charge_credits_detailed(%s, %s, %s, %s)',
            (account_a, Decimal('1.250'), gen_charge, 'smoke/model'),
        )
        row = cur.fetchone()
        if row is None:
            raise AssertionError('charge_credits_detailed returned no row')
        status, uncollectible = row
        expect(result, status == 'charged' and decimal_eq(uncollectible, '0.000'), 'charge_credits_detailed records charged terminal state')

        # Late success after a refund, with no balance left, records a durable shortfall.
        scalar(cur, 'SELECT add_credits(%s, %s, %s, %s)', (account_b, Decimal('5.000'), 'late grant', f'invoice:late:{run_id}'))
        late_gen = f'gen_smoke_late_{run_id}'
        scalar(cur, 'SELECT reserve_credits(%s, %s, %s, %s)', (account_b, Decimal('5.000'), late_gen, 'smoke/late'))
        refunded = scalar(cur, 'SELECT refund_credits(%s, %s, %s, %s)', (account_b, Decimal('5.000'), late_gen, 'smoke/late'))
        expect(result, refunded is True, 'refund_credits returns reserved credits')
        clawed = scalar(cur, 'SELECT applied FROM clawback_credits(%s, %s, %s, %s)', (account_b, Decimal('5.000'), f'refund:drain:{run_id}', 'stripe_refund'))
        expect(result, clawed is True, 'clawback_credits can drain refunded balance')
        cur.execute(
            'SELECT status, uncollectible FROM charge_credits_detailed(%s, %s, %s, %s)',
            (account_b, Decimal('5.000'), late_gen, 'smoke/late'),
        )
        row = cur.fetchone()
        if row is None:
            raise AssertionError('late charge_credits_detailed returned no row')
        status, uncollectible = row
        expect(result, status == 'shortfall' and decimal_eq(uncollectible, '5.000'), 'late charge after refund records uncollectible shortfall')

        # Variable-cost settlement: true-down and true-up shortfall.
        scalar(cur, 'SELECT add_credits(%s, %s, %s, %s)', (account_c, Decimal('2.000'), 'settle grant', f'invoice:settle:{run_id}'))
        settle_down_gen = f'gen_smoke_settle_down_{run_id}'
        scalar(cur, 'SELECT reserve_credits(%s, %s, %s, %s)', (account_c, Decimal('1.000'), settle_down_gen, 'smoke/settle'))
        settled = scalar(cur, 'SELECT settle_credits(%s, %s, %s, %s, %s)', (account_c, settle_down_gen, Decimal('1.000'), Decimal('0.400'), 'smoke/settle'))
        expect(result, settled is True, 'settle_credits true-down succeeds')
        settle_balance = scalar(cur, 'SELECT get_balance(%s)', (account_c,))
        expect(result, decimal_eq(settle_balance, '1.600'), 'true-down refunds unused reservation')

        settle_up_gen = f'gen_smoke_settle_up_{run_id}'
        scalar(cur, 'SELECT reserve_credits(%s, %s, %s, %s)', (account_c, Decimal('1.600'), settle_up_gen, 'smoke/settle'))
        settled_shortfall = scalar(cur, 'SELECT settle_credits(%s, %s, %s, %s, %s)', (account_c, settle_up_gen, Decimal('1.600'), Decimal('2.000'), 'smoke/settle'))
        expect(result, settled_shortfall is True, 'settle_credits true-up shortfall succeeds')
        uncollectible_total = scalar(cur, 'SELECT get_uncollectible_total(%s)', (account_c,))
        expect(result, decimal_eq(uncollectible_total, '0.400'), 'true-up shortfall is recorded as uncollectible')

        scalar(cur, 'SELECT upsert_credit_alert_settings(%s, %s, %s, %s, %s, %s)', (account_a, True, [Decimal('38.000')], True, False, False))
        alerts = scalar(cur, 'SELECT COUNT(*) FROM check_credit_alerts(%s)', (account_a,))
        expect(result, alerts == 1, 'credit alert threshold fires once after balance drop')
        alerts_again = scalar(cur, 'SELECT COUNT(*) FROM check_credit_alerts(%s)', (account_a,))
        expect(result, alerts_again == 0, 'credit alert threshold deduplicates repeated checks')

        validate_rls(cur, result, schema_name)

    conn.commit()


def write_result(result: SmokeResult) -> None:
    path = env('LEDGER_FORTRESS_SMOKE_RESULT')
    if not path:
        return
    Path(path).write_text(json.dumps(result.sanitized(), indent=2, sort_keys=True))


def drop_schema_if_needed(
    conn: psycopg.Connection[Any],
    schema_name: str,
    result: SmokeResult,
    keep_schema: bool,
) -> None:
    if keep_schema or result.supabase_schema_dropped:
        return
    try:
        conn.rollback()
    except Exception:
        pass
    with conn.cursor() as cur:
        cur.execute(sql.SQL('DROP SCHEMA IF EXISTS {} CASCADE').format(sql.Identifier(schema_name)))
    conn.commit()
    result.supabase_schema_dropped = True
    print('supabase_schema=dropped')


def main() -> int:
    run_id = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S') + '_' + uuid.uuid4().hex[:8]
    schema_name = f'ledger_fortress_smoke_{run_id}'.lower()
    if not re.fullmatch(r'[a-z][a-z0-9_]{1,62}', schema_name):
        raise SystemExit(f'Unsafe generated schema name: {schema_name}')

    result = SmokeResult(run_id=run_id, schema=schema_name)
    secret_key = stripe_key()
    database_url = build_database_url()
    stripe_customer_id: str | None = None
    keep_schema = env('LEDGER_FORTRESS_SMOKE_KEEP_SCHEMA') == '1'
    conn: psycopg.Connection[Any] | None = None

    print('ledger-fortress real-stack smoke: starting')
    print(f'run_id={run_id}')
    print(f'schema={schema_name}')

    account_for_stripe = str(uuid.uuid4())

    try:
        stripe_customer_id = create_stripe_customer(secret_key, run_id, account_for_stripe)
        result.stripe_customer_created = True
        print(f'stripe_customer={stripe_customer_id}')

        conn = psycopg.connect(database_url, connect_timeout=20)
        apply_migrations(conn, schema_name)
        print('supabase_schema=migrations_applied')
        exercise_ledger(conn, result, schema_name, run_id, stripe_customer_id)
        print(f'assertions={len(result.assertions)}')

        if keep_schema:
            print('supabase_schema=kept')
        else:
            drop_schema_if_needed(conn, schema_name, result, keep_schema)

        result.ok = True

    except Exception as exc:
        result.error = str(exc)
        raise

    finally:
        if conn is not None:
            try:
                drop_schema_if_needed(conn, schema_name, result, keep_schema)
            except Exception as exc:  # pragma: no cover - cleanup best effort
                print(f'supabase_schema_cleanup=failed:{exc}', file=sys.stderr)
            conn.close()
        if stripe_customer_id:
            try:
                result.stripe_customer_deleted = delete_stripe_customer(secret_key, stripe_customer_id)
                print('stripe_customer=deleted')
            except Exception as exc:  # pragma: no cover - cleanup best effort
                print(f'stripe_customer_cleanup=failed:{exc}', file=sys.stderr)
        write_result(result)

    print(json.dumps(result.sanitized(), indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
