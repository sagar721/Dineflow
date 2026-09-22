# Environment variables

Every variable is validated at boot by [`apps/api/src/config.ts`](../apps/api/src/config.ts). The API **refuses to start** when one is missing or malformed, so a misconfigured deployment fails immediately instead of on the first request that needs it.

No value in this file is ever logged, returned in a response, or committed. Secrets live in the host's secret store, one set per environment.

## API (`apps/api`)

| Variable | Required | Example | Purpose and notes |
|---|---|---|---|
| `NODE_ENV` | no | `production` | `development` \| `test` \| `production`. Defaults to `development`. |
| `PORT` | no | `4000` | Listening port. Defaults to 4000. |
| `DATABASE_URL` | **yes** | `postgres://dineflow_api:…@host:5432/postgres` | Must use the **`dineflow_api`** role. The API refuses to start if the role is a superuser, has `BYPASSRLS`, or owns tables — any of those would silently disable row-level security. |
| `WEB_ORIGIN` | **yes** | `https://app.example.com` | The single browser origin allowed to call the API with credentials. No wildcards. |
| `SUPABASE_URL` | **yes** | `https://abcd.supabase.co` | Project URL. Also the expected JWT issuer. |
| `SUPABASE_ANON_KEY` | **yes** | `sb_publishable_…` | Used for password grant and refresh. Accepts either the new publishable key or a legacy anon JWT; verified working with both. Never sent to the browser — DineFlow's browser never talks to Supabase at all (D-02). |
| `SUPABASE_SERVICE_KEY` | **yes** | `sb_secret_…` | Admin operations (creating a user when an invitation is accepted). **Full access to the project — the most sensitive value in the system.** Accepts the new secret key or a legacy service_role JWT. Never in the SPA, never in logs. |
| `SUPABASE_JWT_SECRET` | no | `super-secret` | Only for legacy HS256 projects. When absent, tokens are verified against the project's JWKS, which is the current and preferred path. **The connected project uses asymmetric ES256 with a JWKS, so leave this unset.** |
| `COOKIE_SECURE` | no | `true` | `true` in every deployed environment; the API rejects `false` in production. `false` locally drops the `__Host-` cookie prefix, which requires HTTPS. |
| `TRUST_PROXY_HOPS` | no | `1` | How many trusted proxies sit in front of the API. The client IP is taken from exactly that position in `X-Forwarded-For`; reading the whole chain would let a caller forge an address and evade rate limits. |
| `APP_BASE_URL` | **yes** | `https://app.example.com` | Base for invitation and password-reset links **and every table QR code**. In production it must be a public `https` origin; the API refuses to start with `http` or `localhost`. Printed QR codes encode it permanently. |
| `QR_SIGNING_KEYS` | **yes** | `1:<SECRET_1>` | Keys that sign table QR tokens: comma-separated `kid:secret`, each secret at least 32 random bytes as strict base64url without padding. **API service only.** The API refuses to start on a missing, empty, short, non-base64url, whitespace-containing, duplicated or non-random key; there is no fallback; errors never echo key material. One key per environment. Procedure, Render setup, rotation and compromise: [runbooks/qr-signing-key.md](runbooks/qr-signing-key.md). |
| `QR_SIGNING_KEY_ID` | no | `2` | Which key signs new codes. Defaults to the highest key id; an empty value counts as unset. |
| `QR_DOMAIN_FINAL` | no | `false` | Until `true`, QR cards are marked provisional and download and print are disabled, because a laminated card cannot be changed if the domain does. |
| `MENU_IMAGE_BUCKET` | no | *(unset)* | Supabase Storage bucket for menu photos: **public-read**, written only by the API with the service key. Unset switches photo upload off (it answers 503); the rest of the menu works. **API service only.** See [modules/04-menu.md](modules/04-menu.md). |
| `LOG_LEVEL` | no | `info` | `silent` \| `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. |

## Web (`apps/web`)

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `VITE_API_URL` | no | `https://api.example.com` | API origin. Defaults to `http://localhost:4000`. |
| `VITE_ALLOW_DEMO_DATA` | no | `1` | Lets the placeholder dashboard data load in a production build. **Remove this when the orders module lands**; the guard then keeps demo data away from customers automatically. |

Anything prefixed `VITE_` is **compiled into the browser bundle and is public**. No secret may ever carry that prefix.

## Local development and tests

The test suites need Postgres on `localhost:55432` (`npm run db:up`). They set their own configuration and use a stub identity provider, so **no Supabase account is needed to run them**.

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | migrations, isolation harness, API tests | `postgres://postgres:dineflow_local_only@localhost:55432/dineflow` |
| `DINEFLOW_PG_PORT`, `DINEFLOW_PG_CONTAINER`, `DINEFLOW_PG_IMAGE` | `scripts/db-docker.mjs` | `55432`, `dineflow-pg`, `postgres:17-alpine` |

## Running against the Supabase database

The API can point at either database. Locally it uses the disposable Postgres with a
minimal `auth.users` stand-in; deployed, it points at the Supabase database where
`auth.users` is the provider's own table and our foreign keys reference it directly.

| | Local | Supabase |
|---|---|---|
| `auth.users` | stand-in created by migration 001 | the real table, owned by `supabase_auth_admin` |
| Migration role | `postgres` (superuser) | `postgres` (not superuser, but has `BYPASSRLS`) |
| Direct host | `localhost:55432` | `db.<ref>.supabase.co:5432`, **IPv6 only** — unreachable from networks without IPv6 routing |
| IPv4 route | — | Session pooler: `aws-0-<region>.pooler.supabase.com:5432`, username `<role>.<project-ref>`. Copy the exact string from the dashboard's **Connect → Session pooler**; the region is not guessable (this project is `ap-northeast-2`, Seoul) |
| TLS | none | required; `sslmode=no-verify` works for ad-hoc runs, production should pin Supabase's CA |

Two consequences worth knowing:

1. **A staff member cannot be deleted in Supabase while a membership row references them.** The foreign key rejects it and the admin API reports a 500. This is intended — FR-110 keeps users that appear in history, and they are deactivated rather than deleted — but any offboarding must delete in dependency order.
2. **The Supabase Data API cannot see DineFlow tables.** Migration 001 revokes everything from `anon`, `authenticated` and `service_role`, which is the point of D-19. Use the SQL editor, not the Table Editor, for these tables.

## Running the API locally

```bash
npm run dev:api   # loads the git-ignored .env, validates it, and refuses to start if anything is wrong
npm run dev:web   # http://localhost:5180
```

If the web app says **"Can't reach the DineFlow server"**, the API is not running.

The web app always runs on **5180** (`strictPort`), deliberately not Vite's default 5173. Other Vite projects on the same machine take the defaults, and Vite would otherwise move to the next free port without warning. Password-reset links (`APP_BASE_URL`) and the API's CORS allow-list (`WEB_ORIGIN`) would then point at a different app — which is exactly how a reset link once opened someone else's project. If 5180 is taken, `npm run dev:web` stops with an error instead.

## Supabase Auth settings DineFlow depends on

| Setting (Supabase dashboard) | Required value | Why |
|---|---|---|
| Authentication → Sign In / Providers → **Allow new users to sign up** | **Off** | DineFlow is invite-only (FR-002). Staff accounts are created through invitations, which use the admin API and keep working with sign-ups off. With it on, anyone can create an account in your project. It cannot reach DineFlow data, but it uses your email quota and clutters Auth. |
| Authentication → URL Configuration → **Redirect URLs** | Include `APP_BASE_URL/reset-password` for each environment. In production, list the **exact** production URL — no wildcards. | Password-reset links redirect there. Verified: the current project refuses external domains (they fall back to the Site URL) and accepts any `localhost` port, which is fine for development only. |
| Authentication → Multi-Factor → **TOTP** | Enabled | Required for platform admins (FR-105). |

Two provider behaviours, verified live and relied on by the code:

- A reset link's session is marked with authentication method **`otp`**. The API accepts it only if it is less than 15 minutes old.
- For an account with an authenticator, Supabase **refuses to change the password without the second factor** (`insufficient_aal`). The reset page therefore asks for the code as well: inbox access alone cannot take over a protected account.

## Live verification

`apps/api/test/live-supabase.mjs` runs the flows a stub cannot prove, against a real project. It creates accounts prefixed `dineflow-live-test-` and deletes them afterwards.

```bash
# Real Supabase Auth, local database
set -a && . ./.env && set +a && node apps/api/test/live-supabase.mjs

# Real Supabase Auth and the Supabase database — the deployed shape
set -a && . ./.env && set +a && \
  LIVE_OWNER_URL="$SUPABASE_OWNER_URL" LIVE_API_URL="$SUPABASE_API_URL" \
  node apps/api/test/live-supabase.mjs
```

The tenant-isolation harness can also be pointed at Supabase. Skip the canaries
there: they deliberately break protections to prove detection, which is safe on a
disposable local database but not on a shared project. Pass the API role's full
connection string: when `DINEFLOW_API_URL` is set, the harness uses it as-is and
never touches that role's password.

```bash
DATABASE_URL="$SUPABASE_OWNER_URL" DINEFLOW_API_URL="$SUPABASE_API_URL" SKIP_CANARIES=1 \
  node packages/db/test/run.ts
```

It is deliberately not part of `npm test`: it needs credentials and touches a real project.

## Rotation

| Secret | When to rotate | How |
|---|---|---|
| `QR_SIGNING_KEYS` | Routinely by appending; on compromise by replacing | Appending a new `kid:secret` keeps printed cards working. Replacing the list kills every card signed with the removed key. See [runbooks/qr-signing-key.md](runbooks/qr-signing-key.md) §5–6. |
| `SUPABASE_SERVICE_KEY` | On any suspected exposure, and when anyone with access leaves | Create a new secret key in the dashboard, update the API host's secret, redeploy, then delete the old one. Sessions are unaffected. **Creating new-format keys does not disable the legacy anon/service_role JWTs** — those must be disabled separately under Legacy API keys, or the old values keep working. |
| `SUPABASE_JWT_SECRET` / signing keys | On suspected exposure | Rotating invalidates every issued token, so all staff are signed out. Plan it outside service hours. |
| `DATABASE_URL` password | Quarterly, and on staff change | `ALTER ROLE dineflow_api WITH PASSWORD …`, update the secret, redeploy. |
| Backup encryption key | On custodian change | Part 7 §4.4: two custodians, key held offline. |

## Not configured yet

Email delivery has no provider. Invitations are created and audited, but the link is not sent: the API logs a warning saying so. Wiring a provider is part of module 18, and the seam is the `sendInvitationEmail` dependency in [`apps/api/src/app.ts`](../apps/api/src/app.ts).
