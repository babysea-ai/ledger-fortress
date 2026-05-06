# Security Policy

## Supported versions

`ledger-fortress` is a working v0.x OSS primitive. Security fixes target the latest public release and the `main` branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** flow on the public `babysea-ai/ledger-fortress` repository. If that flow is unavailable, contact the maintainers at `dev@babysea.ai`.

Do not open a public issue for suspected vulnerabilities. We will acknowledge valid reports as quickly as possible, investigate impact, and publish a fix or mitigation before public disclosure.

## Sentry code guard

The public OSS repository is connected to the `babysea-hq` Sentry organization for repository ownership and issue routing. Sentry ownership maps the repository to the `#babysea-ai` team. No Sentry SDK, DSN, tracing, or runtime telemetry is included in this package.

## Runtime posture

`ledger-fortress` is a backend-only credit ledger. Do not call it directly from
browser or mobile clients. Runtime writes must go through a trusted backend or
service role that has already authenticated the account and authorized the
credit operation.

## Secret handling

- Keep Supabase service-role keys, direct Postgres URLs, database passwords, and Stripe secret/webhook keys server-side only.
- Use Stripe test-mode restricted keys for smoke validation. The real-stack smoke harness refuses live Stripe keys.
- Do not commit `.env`, smoke-test result files, database URLs, or webhook payloads containing customer metadata.
- Scope CI secrets to the repository/environment that actually runs the smoke test.

## Database boundary

- Apply `migrations/003_security.sql` after schema migrations to enable RLS, revoke client grants, set `SECURITY DEFINER` on mutating functions, and lock `search_path`.
- Run `scripts/verify-rls.sh`, `scripts/verify-functions.sh`, and `scripts/verify-anon-denied.sh` against a Supabase project before exposing the ledger through an API.
- Never grant `anon` or `authenticated` table writes to `credits` or `credit_ledger`.
- Do not add refund/dispute clawback behavior unless it is implemented and tested as an explicit extension; current Stripe refunds/disputes are deliberately outside this package.
