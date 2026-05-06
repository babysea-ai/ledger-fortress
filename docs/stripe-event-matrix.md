# Stripe event matrix

`ledger-fortress` handles the Stripe events needed to grant credits from paid subscriptions and paid credit-pack checkouts. It intentionally does not implement payment refund, dispute, clawback, or debt workflows.

## Handled events

| Stripe event | Result | Idempotency key | Notes |
|---|---|---|---|
| `invoice.paid` | Grants credits with `add_credits()`. | `invoice:{invoice.id}` | Processes subscription create/cycle/update invoices. Manual invoices are ignored by default. |
| `checkout.session.completed` | Grants credit-pack credits when the session is a paid one-time payment. | `order:{payment_intent || session.id}` | Optional `hasActiveSubscription` guard can deny stale pack redemption. |
| `checkout.session.async_payment_succeeded` | Same as a paid checkout completion. | `order:{payment_intent || session.id}` | Subscribe only if you support asynchronous payment methods. |

## Expected edge cases

| Case | Expected behavior |
|---|---|
| Duplicate invoice webhook | Second delivery no-ops because the add idempotency key already exists. |
| Duplicate checkout webhook | Second delivery no-ops because the order idempotency key already exists. |
| Zero-dollar invoice | Custom `resolveInvoiceCredits` can still grant fixed plan credits; otherwise no positive amount is granted. |
| Discounted invoice | Default amount-based grants use Stripe's paid amount; plan-based grants should use `resolveInvoiceCredits`. |
| Trial invoice | Treat as zero-dollar unless your resolver maps the plan to fixed credits. |
| Unknown Stripe customer | Handler should skip/return a non-mutating result because `resolveAccountId` returns `null`. |
| Inactive subscription credit-pack attempt | If `hasActiveSubscription` is provided and returns `false`, the checkout is denied. |
| Malformed signature | Reject before constructing or handling the Stripe event. |
| Replay attempt | Stripe signature timestamp validation is handled by Stripe's verifier; SQL idempotency still protects credit grants. |

## Not handled by this package

| Stripe event or workflow | Boundary |
|---|---|
| `charge.refunded` | No automatic credit clawback. Handle refunds in support/billing workflows. |
| `charge.dispute.created` | No automatic credit clawback or evidence workflow. |
| `invoice.payment_failed` | No credit mutation; your product can restrict future usage separately. |
| `invoice.voided` | No credit mutation. |
| Uncollectible invoices | No debt tracking or negative balances. |
| Manual support adjustments | Use a deliberately audited admin workflow around `add_credits()` or your own extension. |

## Production checklist

- Verify the raw Stripe payload with `verifyStripeSignature()` before calling the handler.
- Store only webhook secrets in deployment secrets; do not hard-code them in source.
- Use restricted Stripe keys for application-owned Stripe API calls.
- Map Stripe Price IDs into `plans` before relying on fixed-credit grants.
- Keep refund/dispute handling visibly outside `ledger-fortress` unless you implement and test an extension.
