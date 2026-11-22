# Pilot operations

## Deployment and release gates

1. Create a private Railway PostgreSQL service and an API service from the tested GHCR image emitted by CI. Configure registry access if the package is private. Deploy by immutable digest, not a mutable `latest` tag.
2. Configure `DATABASE_URL`, `WEB_ORIGIN=https://YOUR_DOMAIN`, `NODE_ENV=production`, `PORT` as provided by the platform, Google credentials, and optional `SENTRY_DSN`. Never put backend secrets in Vite environment variables.
3. Before starting a new release, run the migration as a platform pre-deploy command against the correct database:

   ```text
   node apps/api/node_modules/prisma/build/index.js migrate deploy --schema apps/api/prisma/schema.prisma
   ```

4. The container serves the built PWA and API from one origin. Configure TLS and WebSocket support; use `/api/health` for readiness. Start with one replica and no trusted forwarded-IP configuration.
5. Deploy to staging with an isolated database and provider configuration. Run `SMOKE_ORIGIN=https://STAGING_DOMAIN node scripts/smoke.mjs`, then verify real Google login, invite sharing, and a two-device shopping run.
6. Configure protected deployment approvals. Only after staging passes, point production at the same image digest without rebuilding. Cloud deployment is intentionally not automated with invented account/service IDs.
7. Archive the image digest, migration revision, test evidence, operator approval, and restore-drill result with the release.

The local environment did not provide Docker. The container/hosted pipeline must be validated on the configured Linux CI/hosting account before claiming a deployed production release.

Local validation uses a PGlite development fallback because native PostgreSQL rejects the current administrative Windows process. PGlite uses PostgreSQL WASM and connection multiplexing, not independent native database sessions; the Linux CI PostgreSQL service remains an outstanding native-concurrency acceptance gate.

## Monitoring, cost, and abuse

- Railway's subscription includes usage credits, not unlimited hosting. Confirm current pricing and plan terms. Add billing alerts and resource limits; choose a concrete budget before public exposure.
- Watch health-check failures, memory/CPU, storage growth, HTTP 5xx/409/429 rates, and reconnect rates. Structured request logs intentionally omit paths, payloads, cookies, user IDs, and invite codes.
- Rate limiting keys use the direct peer IP, not spoofable forwarded headers. Behind a platform proxy this can group users together. Before public launch, configure only the platform's verified proxy hops/ranges and validate spoofing resistance; do not blindly set `trust proxy=true`.
- The shipped caps are deliberately conservative pilot controls, not sufficient protection against determined distributed abuse. Public launch needs bot/edge controls and expiry/cleanup policies.
- Expired sessions are rejected immediately but are not automatically purged. Schedule a maintenance process to delete expired sessions and abandoned guest accounts according to a published retention policy. Do not delete shared memberships or guest lists without that policy and advance user communication.
- Idempotency records are retained for the list lifetime. Review growth and define a published retry-key retention period before changing this behavior.
- Keep Sentry PII/replay disabled. PostHog and advertising are deferred; consent and retention must be reviewed before enabling them.

## Backups and recovery

- Enable encrypted automated PostgreSQL backups on the selected plan, isolated from the application credentials. Suggested pilot policy: daily backups retained seven days, subject to provider capabilities and the final privacy notice.
- Store backup access credentials outside application code and restrict operator access. Do not download production shopping data into CI.
- Before pilot launch, create a synthetic staging list and membership, take a backup, restore to a separate database, and verify records, constraints, quantities, sessions/access, and migrations.
- Record achieved recovery point/time and restore evidence rather than promising an untested SLA.
- For rollback, retain the previous image digest. Roll back application code only when compatible with the applied schema. Prefer additive migrations and forward fixes; destructive schema rollback needs a tested restore and an explicit data-loss decision.

## Privacy and deletion

The app stores guest/Google identifiers, display names, session digests, list contents, memberships, and hashed invite codes. Member names are returned only to the list owner. Sharing-code holders can join as viewers; communicate that the code is a secret.

Account deletion requires typing `DELETE`. It removes the account, sessions, memberships, owned lists, and their items/invites. Lists owned by other people remain; item authorship uses opaque internal IDs rather than copying the deleted person's name. Existing backup copies follow the published backup-retention period. Decide whether additional anonymization is required for your jurisdiction before launch.

Publish a real support address, privacy policy, terms, retention periods, and deletion process before public Google publishing. A generic development notice is not legal advice or a finished production privacy policy.

## Incident checklist

- Restrict incoming traffic when necessary; preserve only redacted operational evidence.
- Revoke affected application sessions; rotate compromised provider/platform/database secrets through secret management.
- Revoke sharing invitations and memberships independently when access is exposed.
- Restore only from a verified clean backup into a separate database; validate before switching.
- Document scope, corrective action, and user communication required by applicable obligations.

## Deferred dependencies

Redis is unnecessary for one process and is not durable message storage. S3 has no role without uploads. React Native needs its own secure token storage and offline decisions. Monthly templates and copying need explicit new-list semantics. Blinkit/Instamart cart loading must be based on official API/deep-link or partnership support, never undocumented private endpoint automation.
