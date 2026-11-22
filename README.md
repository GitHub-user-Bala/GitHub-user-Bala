# Kart

A web-first, live family shopping list. React/TypeScript PWA, NestJS, PostgreSQL/Prisma, and Socket.IO.

## What works locally

- Guest sessions; Google OIDC login/guest upgrade when configured.
- Private lists, pack quantities with optional per-pack amounts, item editing/deletion and purchased/unavailable states.
- Manual alternatives and retry-safe linked replacements.
- Expiring viewer invitations through code, URL, or QR; owners grant editor access and revoke memberships.
- Authorized live invalidations, optimistic concurrency, reconnect snapshots, and missed-notification reconciliation.
- Mobile-friendly UI, installable web manifest, explicit offline/error states. Offline editing is intentionally unsupported.

Google credentials and an HTTPS public origin are required for real Google login. Production deployment, live provider verification, and a production backup restore drill require your cloud accounts. The project is not a claim of bulletproof security.

## Development

Requires Node 22 and pnpm 10.11.0 (`corepack enable`, or prefix pnpm commands with `npx --yes pnpm@10.11.0`). Commands below run from the project root.

1. `pnpm install --frozen-lockfile`
2. Start PostgreSQL: `docker compose up -d db`. Without Docker, `pnpm db:local` runs PGlite (PostgreSQL WASM) on loopback port 54329; keep that terminal open. This fallback is for development, not proof of native PostgreSQL concurrency behavior.
3. Configure the API environment:

   ```powershell
   $env:DATABASE_URL='postgresql://kart:kart_local@localhost:54329/kart'
   $env:WEB_ORIGIN='http://localhost:5173'
   ```

   On other shells use their equivalent environment syntax. These are local-only example credentials, not production secrets. The app does not automatically load `.env` files.

   For the PGlite fallback only, use `postgresql://kart:kart_local@localhost:54329/kart?connection_limit=1&pgbouncer=true` so Prisma resets prepared statements between pooled clients. Do not copy this setting blindly to a native production database.

4. `pnpm db:generate`
5. `pnpm db:migrate`
6. `pnpm dev` then open `http://localhost:5173`.

The development proxy serves API and sockets from the browser's web origin. Do not mix `127.0.0.1` and `localhost` in browser URLs: Origin/CSRF checks deliberately require an exact match.

The optional PGlite helper has no network authentication: it binds only to loopback and must never be exposed or used with production data. Docker or a normally installed PostgreSQL server is required for native database and concurrency acceptance. The current administrative Windows environment cannot start native PostgreSQL, and Docker is unavailable.

## Google login

Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` together. Register the exact redirect URI `http://localhost:5173/api/auth/google/callback` for local development and `https://YOUR_DOMAIN/api/auth/google/callback` for production. Request only `openid email profile`. Configure authorized domains, consent branding, test users/public publishing as applicable, privacy policy, and terms in Google Cloud.

Sessions use hashed opaque tokens in HttpOnly cookies and expire after seven days. Guest data is not recoverable after session loss unless upgraded to Google. A guest upgrade merges ownership into an existing Google account; existing roles are preserved, and newly merged shared memberships default to viewer rather than escalating permissions.

OAuth callback tests mock only the external identity-verification boundary; they check state, nonce/PKCE binding, flow expiry, and session rotation without sending test credentials to Google. Real provider login still needs a staging check.

## Validation

With the test database running and `DATABASE_URL` set:

```text
pnpm --filter @kart/contracts build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:api
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

Tests create uniquely identified records and delete their own users/lists. Use an isolated test database, never production. Browser tests promote their own fixture user to a Google identity directly in that test database; there is no production authentication bypass endpoint. Playwright starts/stops its own web/API servers. Do not run API and browser tests concurrently against the same ports.

The CI release job depends on all sanity checks, including real two-browser Playwright flows. A small contracts compilation and a dev server are needed before browser tests; the release build/image occurs only after sanity passes. Browser traces may contain test-only credentials and invite codes: restrict artifact access, keep short retention, and never run these fixtures with real user data.

## Design and operational limits

- REST is authoritative. Socket.IO notifies authorized list rooms with revision numbers; clients refetch consistent snapshots. Online revision polling every 30 seconds repairs missed emits.
- Writes lock the list row, check current permissions inside the transaction, and increment list revisions. Item versions reject stale edits with 409. Creation/replacement retry keys reject different payload reuse.
- Units: `g`, `kg`, `ml`, `l`, `piece`. Pack counts are integers from 1 to 999; optional positive per-pack amounts have up to three decimals. The UI displays per-pack quantities, not misleading cross-unit totals.
- Pilot caps: 20 owned lists, 500 items/list, 30 members/list, 10 alternatives/item. Per-IP request limits are process-local: 30/min for auth/join and 240/min for other API traffic.
- One API replica only. Before scaling, add shared rate/session coordination and a Socket.IO Redis adapter, and configure transport/load-balancer behavior.
- Codes are bearer invitations to view one list. They expire after seven days. Rotation stops new joins but does not evict existing members; remove memberships separately.
- Sentry is optional (`SENTRY_DSN`); payload/user/request metadata is stripped. PostHog, ad SDKs, replay, S3, and Redis are deliberately not initialized.

See [operations](docs/operations.md) for deployment, backup/restore, privacy, and remaining production gates.
