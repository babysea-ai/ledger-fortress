# Copyright 2026 BabySea, Inc.
# Licensed under the Apache License, Version 2.0.

"""
ledger-fortress Python SDK.

Atomic credit settlement for async AI workloads.
Wraps the PostgreSQL functions with a type-safe interface.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Sequence
import psycopg2
import psycopg2.pool

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LedgerEntry:
    id: str
    type: str
    amount: float
    balance_after: float
    generation_id: str | None
    model: str | None
    description: str | None
    created_at: datetime


@dataclass(frozen=True)
class OrphanedReservation:
    ledger_id: str
    account_id: str
    generation_id: str
    amount: float
    model: str | None
    reserved_at: datetime


@dataclass(frozen=True)
class RecoverResult:
    inspected: int
    refunded: int
    errors: int


@dataclass(frozen=True)
class AlertThreshold:
    threshold: float
    balance: float


class LedgerFortress:
    """Atomic credit settlement for async AI workloads."""

    def __init__(
        self,
        database_url: str | None = None,
        *,
        min_connections: int = 1,
        max_connections: int = 10,
    ) -> None:
        url = database_url or os.environ.get("DATABASE_URL")
        if not url:
            raise ValueError("database_url is required (or set DATABASE_URL env var)")

        self._pool = psycopg2.pool.ThreadedConnectionPool(
            min_connections,
            max_connections,
            url,
        )

    def _query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if cur.description:
                    columns = [desc[0] for desc in cur.description]
                    return [dict(zip(columns, row)) for row in cur.fetchall()]
                return []
        finally:
            conn.commit()
            self._pool.putconn(conn)

    def _query_scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                return row[0] if row else None
        finally:
            conn.commit()
            self._pool.putconn(conn)

    # -------------------------------------------------------------------------
    # Core lifecycle
    # -------------------------------------------------------------------------

    def can_generate(self, account_id: str, amount: float) -> bool:
        """Check if an account can afford a generation. Pure read, no side effects."""
        result = self._query_scalar(
            "SELECT has_credits(%s, %s)", (account_id, amount)
        )
        return bool(result)

    def get_balance(self, account_id: str) -> float:
        """Get the current credit balance for an account."""
        result = self._query_scalar("SELECT get_balance(%s)", (account_id,))
        return float(result) if result is not None else 0.0

    def reserve(
        self,
        *,
        account_id: str,
        amount: float,
        generation_id: str | None = None,
        model: str | None = None,
    ) -> bool:
        """
        Atomically reserve credits for a generation.

        Returns True if the reservation succeeded, False if insufficient balance.
        This is a single UPDATE ... WHERE tokens >= cost - no TOCTOU race.
        """
        if amount <= 0:
            raise ValueError("amount must be positive")
        result = self._query_scalar(
            "SELECT reserve_credits(%s, %s, %s, %s)",
            (account_id, amount, generation_id, model),
        )
        return bool(result)

    def charge(
        self,
        *,
        account_id: str,
        generation_id: str,
        amount: float,
        model: str | None = None,
    ) -> bool:
        """
        Confirm a reservation after successful generation.
        Log-only: no balance change (unless out-of-order with refund).

        Idempotent: second call for the same generation_id is a no-op.
        """
        if amount <= 0:
            raise ValueError("amount must be positive")
        result = self._query_scalar(
            "SELECT charge_credits(%s, %s, %s, %s)",
            (account_id, amount, generation_id, model),
        )
        return bool(result)

    def refund(
        self,
        *,
        account_id: str,
        generation_id: str,
        amount: float,
        model: str | None = None,
    ) -> bool:
        """
        Return reserved credits after a failed or cancelled generation.

        Guards:
        - If already charged ➜ no-op (prevents free output)
        - If already refunded ➜ no-op (prevents double-refund)

        Idempotent: safe to call from webhooks, crash recovery, and cancel endpoints.
        """
        if amount <= 0:
            raise ValueError("amount must be positive")
        result = self._query_scalar(
            "SELECT refund_credits(%s, %s, %s, %s)",
            (account_id, amount, generation_id, model),
        )
        return bool(result)

    def add_credits(
        self,
        *,
        account_id: str,
        amount: float,
        description: str,
        idempotency_key: str | None = None,
    ) -> bool:
        """
        Grant credits from a Stripe invoice, credit pack, or manual grant.
        Additive (rollover): always adds to existing balance, never resets.

        Idempotent: safe to call from Stripe webhook retries.
        """
        if amount <= 0:
            raise ValueError("amount must be positive")
        result = self._query_scalar(
            "SELECT add_credits(%s, %s, %s, %s)",
            (account_id, amount, description, idempotency_key),
        )
        return bool(result)

    def list_ledger(
        self,
        account_id: str,
        *,
        entry_type: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[LedgerEntry]:
        """List ledger entries for an account."""
        rows = self._query(
            "SELECT * FROM list_credit_ledger(%s, %s, %s, %s)",
            (account_id, entry_type, limit, offset),
        )
        return [
            LedgerEntry(
                id=str(row["id"]),
                type=row["type"],
                amount=float(row["amount"]),
                balance_after=float(row["balance_after"]),
                generation_id=row.get("generation_id"),
                model=row.get("model"),
                description=row.get("description"),
                created_at=row["created_at"],
            )
            for row in rows
        ]

    # -------------------------------------------------------------------------
    # Crash recovery
    # -------------------------------------------------------------------------

    def recover_orphans(
        self,
        *,
        window_minutes: int = 5,
        limit: int = 100,
        on_recovered: Callable[[str, str], None] | None = None,
    ) -> RecoverResult:
        """
        Find and refund orphaned reservations.
        Call this from a cron job every ~5 minutes.
        """
        rows = self._query(
            "SELECT * FROM find_orphaned_reservations(%s, %s)",
            (window_minutes, limit),
        )

        refunded = 0
        errors = 0

        for row in rows:
            try:
                success = self.refund(
                    account_id=str(row["account_id"]),
                    generation_id=str(row["generation_id"]),
                    amount=float(row["amount"]),
                    model=row.get("model"),
                )
                if success:
                    refunded += 1
                    if on_recovered:
                        on_recovered(str(row["generation_id"]), str(row["account_id"]))
            except Exception:
                logger.exception("Failed to recover orphan %s", row["generation_id"])
                errors += 1

        return RecoverResult(inspected=len(rows), refunded=refunded, errors=errors)

    # -------------------------------------------------------------------------
    # Credit alerts
    # -------------------------------------------------------------------------

    def check_alerts(self, account_id: str) -> list[AlertThreshold]:
        """Check if any alert thresholds have been crossed. Fire-and-forget."""
        try:
            rows = self._query("SELECT * FROM check_credit_alerts(%s)", (account_id,))
            return [
                AlertThreshold(
                    threshold=float(row["threshold"]),
                    balance=float(row["balance"]),
                )
                for row in rows
            ]
        except Exception:
            logger.exception("check_alerts failed for %s", account_id)
            return []

    def reset_alerts(self, account_id: str) -> int:
        """Reset alert thresholds where balance has recovered."""
        try:
            result = self._query_scalar(
                "SELECT reset_credit_alerts(%s)", (account_id,)
            )
            return int(result) if result else 0
        except Exception:
            logger.exception("reset_alerts failed for %s", account_id)
            return 0

    def set_alert_settings(
        self,
        account_id: str,
        *,
        enabled: bool = True,
        thresholds: Sequence[float] | None = None,
        channel_in_app: bool = True,
        channel_email: bool = True,
        channel_webhook: bool = False,
    ) -> None:
        """Configure alert settings for an account."""
        self._query_scalar(
            "SELECT upsert_credit_alert_settings(%s, %s, %s, %s, %s, %s)",
            (
                account_id,
                enabled,
                list(thresholds or [0.5]),
                channel_in_app,
                channel_email,
                channel_webhook,
            ),
        )

    def get_alert_settings(self, account_id: str) -> dict[str, Any]:
        """Get alert settings for an account (with defaults)."""
        rows = self._query(
            "SELECT * FROM get_credit_alert_settings(%s)", (account_id,)
        )
        if not rows:
            return {
                "enabled": True,
                "thresholds": [0.5],
                "channels": {"in_app": True, "email": True, "webhook": False},
            }
        row = rows[0]
        return {
            "enabled": row.get("enabled", True),
            "thresholds": [float(t) for t in (row.get("thresholds") or [0.5])],
            "channels": {
                "in_app": row.get("channel_in_app", True),
                "email": row.get("channel_email", True),
                "webhook": row.get("channel_webhook", False),
            },
        }

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------

    def build_event(self, entry: LedgerEntry, account_id: str) -> dict[str, Any]:
        """Build a credit-event.v1 payload conforming to the JSON schema."""
        return {
            "schema_version": "credit-event.v1",
            "event_id": entry.id,
            "account_id": account_id,
            "type": entry.type,
            "amount": entry.amount,
            "balance_after": entry.balance_after,
            "generation_id": entry.generation_id,
            "model": entry.model,
            "description": entry.description,
            "occurred_at": entry.created_at.isoformat(),
        }

    def close(self) -> None:
        """Close all connections in the pool."""
        self._pool.closeall()
