"""
ledger-fortress Python SDK demo.

Demonstrates the full credit lifecycle:
reserve ➜ async generation ➜ charge (success) or refund (failure).

Prerequisites:
    psql "$DATABASE_URL" < ../../migrations/001_credits.sql
    psql "$DATABASE_URL" < ../../migrations/002_credit_alerts.sql

Run:
    DATABASE_URL=postgresql://... python demo.py
"""

import os
import random
import time

from ledger_fortress import LedgerFortress

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("Set DATABASE_URL environment variable.")
    raise SystemExit(1)


def main() -> None:
    fortress = LedgerFortress(database_url=DATABASE_URL)

    account_id = "00000000-0000-0000-0000-000000000001"
    model = "flux-schnell"
    cost = 0.062

    # -------------------------------------------------------------------------
    # 1. Grant credits (idempotent)
    # -------------------------------------------------------------------------
    print("\n--- Step 1: Add $10 credits ---")
    added = fortress.add_credits(
        account_id=account_id,
        amount=10.0,
        description="Demo grant",
        idempotency_key="demo:initial-grant",
    )
    print(f"  add_credits: {'granted' if added else 'already granted (idempotent)'}")

    balance = fortress.get_balance(account_id)
    print(f"  balance: ${balance:.3f}")

    # -------------------------------------------------------------------------
    # 2. Reserve credits
    # -------------------------------------------------------------------------
    print("\n--- Step 2: Reserve credits ---")
    generation_id = f"gen_{int(time.time() * 1000)}"
    can_afford = fortress.can_generate(account_id, cost)
    print(f"  can_generate(${cost}): {can_afford}")

    reserved = fortress.reserve(
        account_id=account_id,
        generation_id=generation_id,
        amount=cost,
        model=model,
    )
    print(f"  reserve: {'success' if reserved else 'insufficient balance'}")

    balance_after = fortress.get_balance(account_id)
    print(f"  balance after reserve: ${balance_after:.3f}")

    # -------------------------------------------------------------------------
    # 3. Simulate async generation
    # -------------------------------------------------------------------------
    print("\n--- Step 3: Generating... ---")
    success = random.random() > 0.3  # 70% success rate
    time.sleep(2)
    print(f"  generation result: {'SUCCESS' if success else 'FAILED'}")

    # -------------------------------------------------------------------------
    # 4. Settle
    # -------------------------------------------------------------------------
    print("\n--- Step 4: Settle ---")
    if success:
        charged = fortress.charge(
            account_id=account_id,
            generation_id=generation_id,
            amount=cost,
            model=model,
        )
        print(f"  charge: {'confirmed' if charged else 'already charged (idempotent)'}")
    else:
        refunded = fortress.refund(
            account_id=account_id,
            generation_id=generation_id,
            amount=cost,
            model=model,
        )
        print(f"  refund: {'returned' if refunded else 'already refunded (idempotent)'}")

    final_balance = fortress.get_balance(account_id)
    print(f"  final balance: ${final_balance:.3f}")

    # -------------------------------------------------------------------------
    # 5. Ledger history
    # -------------------------------------------------------------------------
    print("\n--- Step 5: Ledger history ---")
    ledger = fortress.list_ledger(account_id, limit=10)
    for entry in ledger:
        sign = "-" if entry.type == "reserve" else "+"
        desc = entry.model or entry.description or ""
        print(
            f"  {entry.type:<8} {sign}${entry.amount:>7.3f} ➜ ${entry.balance_after:>7.3f}  {desc}"
        )

    # -------------------------------------------------------------------------
    # 6. Crash recovery
    # -------------------------------------------------------------------------
    print("\n--- Step 6: Crash recovery ---")
    result = fortress.recover_orphans(
        window_minutes=5,
        on_recovered=lambda gen_id, acct_id: print(
            f"  recovered orphan: {gen_id} for account {acct_id}"
        ),
    )
    print(f"  inspected: {result.inspected}, refunded: {result.refunded}, errors: {result.errors}")

    print("\n✓ Demo complete.\n")
    fortress.close()


if __name__ == "__main__":
    main()
