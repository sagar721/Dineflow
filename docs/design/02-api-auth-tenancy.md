# DineFlow — Technical Design, Part 2: API, Authentication, Authorization and Tenant Isolation

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for approval) |
| **Base URL** | `https://api.<domain>/api/v1` |
| **Related** | [Architecture](00-architecture-and-decisions.md) · [Database](01-database.md) · [Threat model](03-threat-model.md) |

---

## 1. API conventions

| Topic | Rule |
|---|---|
| Style | REST, JSON only (`Content-Type: application/json`), versioned under `/api/v1`. |
| Documentation | OpenAPI 3.1 generated from the same Zod schemas that validate requests, so docs cannot drift from code. Served only in dev/staging and published as a static file in `docs/api/`. |
| Validation | Every route declares Zod schemas for params, query, body and response. Unknown fields are **rejected** (`.strict()`), strings are trimmed and length-bounded, numbers are integers within bounds. A route without a schema fails a CI check. |
| Authorization | Every route declares its permission key(s) from the central permission matrix (§4). A route without a declaration fails CI. |
| IDs | UUIDs in paths; object lookups always include the tenant scope (and RLS backs it up). Wrong-tenant IDs return **404**, not 403, to avoid confirming existence. |
| Errors | One format: `{ "error": { "code": "ORDER_ITEM_UNAVAILABLE", "message": "Paneer Tikka is no longer available.", "details": [...], "requestId": "…" } }`. HTTP codes: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict (stale version, idempotency clash, illegal transition), 413/415 upload issues, 422 business-rule violation, 429 rate limited, 5xx never carries internals. |
| Pagination | Cursor-based (`?limit=50&cursor=…`), max limit 100. |
| Concurrency | Mutating order/bill endpoints require the current `version`; stale → 409 `STALE_VERSION`. |
| Idempotency | Public order creation requires `Idempotency-Key` (UUID). Bill finalize and payment endpoints are naturally idempotent via state checks and return the existing result on repeat. |
| Time | ISO-8601 UTC strings; the API never accepts client-supplied "now". |
| Money | Integers in minor units plus a `currency` code. Never floats. |
| Caching | Public menu: `Cache-Control: public, max-age=15`, `ETag`. Everything authenticated: `Cache-Control: no-store`. |
| Request size | JSON body limit 100 KB; upload limit 5 MB (image endpoints only). |

## 2. Middleware pipeline (order matters)

1. **Request ID** (generate; echoed in responses and logs).
2. **Security headers** (Helmet: HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, minimal CSP for JSON).
3. **CORS**: single allow-listed origin (`https://app.<domain>`; staging/dev origins from config), `credentials: true` for staff routes only, no wildcard, explicit methods/headers.
4. **Body parsing with size limits** (JSON; multipart only on upload routes).
5. **Rate limiting** by route class (§7).
6. **Origin/CSRF check** for state-changing cookie-authenticated requests (§3.4).
7. **Authentication** (staff routes): read cookie → verify JWT signature/expiry against the provider's signing keys → refresh flow if needed.
8. **Tenant context**: look up the user's active membership *in the database, on every request* via `app.lookup_membership()` (`restaurant_users` join `restaurants.status`); deny if none, deactivated, or restaurant suspended. Role comes from here, never from the token or the client.
9. **Authorization**: `can(role, permissionKey)` from the shared matrix; for object-level actions, the handler additionally checks ownership through RLS-scoped queries.
10. **Validation** (Zod).
11. **Handler inside `withTenantTx`** (opens transaction, `SET LOCAL ROLE`, sets identity for RLS, runs, commits/rolls back).
12. **Audit writer** (for sensitive actions, inside the same transaction so an action and its audit row commit or fail together).
13. **Central error handler**: maps known errors to the error format; logs internals server-side only; unknown errors become a generic 500 with the request ID.

## 3. Authentication design

### 3.1 Staff sign-in (decision D-04)

- Identity provider: **Supabase Auth**, called **only by the API server-side** (service credentials live only in the API's environment).
- Flow: `POST /auth/login {email, password}` → API calls the provider → on success sets two cookies and returns the profile:
  - `__Host-df_at` (access token, short-lived ~15 min) and `__Host-df_rt` (refresh token; rotated on every use). Both `HttpOnly; Secure; SameSite=Lax; Path=/` and host-only (no `Domain`), so they are never sent to the SPA host or other subdomains, and never readable by JavaScript.
  - Frontend and API share the same registrable domain (`app.` and `api.`), so the browser treats requests as same-site; CORS + credentials handle the cross-origin fetch.
- **MFA (TOTP):** if the account has a verified factor, login returns `mfa_required` plus a challenge, and only `POST /auth/mfa/verify` completes the session (aal2). **Platform Super Admin requires aal2 for every request**; Owners are prompted to enrol (setting can make it mandatory).
- **Refresh:** on access-token expiry the API transparently uses the refresh cookie, rotates it, and re-sets cookies. Reuse of an old refresh token invalidates the session family (provider feature).
- **Logout:** `POST /auth/logout` revokes the session at the provider and clears cookies; "Sign out everywhere" revokes all sessions.
- **Deactivation:** because the membership check runs on every request, a deactivated user is locked out at the next request even with a valid token; the provider session is also revoked.
- **Session limits:** idle timeout and absolute lifetime (e.g., 12 h for kitchen/billing devices "keep me signed in", 8 h default) configured at the provider; verify plan support at implementation time and fall back to an API-side check if absent.

### 3.2 Passwords and account recovery

- Passwords are **never seen by our code except to relay to the provider**, never logged, never stored. Hashing and breach handling are the provider's responsibility.
- Policy: minimum 12 characters, checked against a breached-password list where the provider supports it; otherwise a bundled common-password check.
- `POST /auth/password/forgot` always returns 202 with the same body and comparable timing, whether or not the email exists. Reset links are one-time, 1-hour expiry, handled by `POST /auth/password/reset`. Resetting revokes existing sessions.
- Login and reset endpoints: per-IP and per-account rate limits with progressive back-off (§7), generic failure messages (`Invalid email or password`).

### 3.3 Invitations and onboarding (D-15)

1. Owner/Manager (within their allowed roles) or Super Admin (for the first Owner) calls `POST /staff/invitations`. The API stores `token_hash` (SHA-256 of a 256-bit random token), role, expiry (72 h) and emails the link `https://app.<domain>/accept-invite#token=…` (token in the URL fragment so it never reaches server logs or `Referer`).
2. The SPA calls `POST /auth/invitations/accept {token, password, displayName}`. The API verifies hash, expiry, unused, creates the auth user with the provider's admin API (email marked confirmed because the emailed link proves possession), inserts `restaurant_users`, marks the invitation used, audits it, and signs the user in.
3. Re-use, expiry, or revocation return one generic error.

### 3.4 CSRF and browser-side protections

- Cookies are `SameSite=Lax` and host-only. State-changing routes accept only `application/json` (or `multipart/form-data` on uploads), require a custom header `X-DineFlow-Client: web`, and verify `Origin`/`Sec-Fetch-Site` against the allow-list. A cross-site form or fetch cannot set the custom header without a CORS preflight, which is denied.
- No state changes on `GET`.
- The SPA is served with a strict CSP (no inline scripts; `script-src 'self'` plus Turnstile; `connect-src` limited to the API host; `img-src` limited to self and the storage host), `frame-ancestors 'none'`, and does not use `dangerouslySetInnerHTML` (lint-enforced). All customer- and staff-entered text renders as text.

### 3.5 Public (customer) authentication

Customers have no account. Capability tokens serve as access control:

| Capability | Token | Properties |
|---|---|---|
| Order at table T | **HMAC-signed QR token** `kid ‖ qr_id ‖ MAC` (Part 7 §5) | MAC verified in memory **before** any database access, so forged tokens cost one hash. Grants only "read this restaurant's public menu" and "place an order for table T". Revocable; rotated by Owner/Manager; the database never stores a usable token. |
| View order O | Order-status token (128-bit), stored **hashed** (`public_token_hash`) | Grants read-only, non-sensitive view of that single order (no contact details shown back). |

Tokens are compared in constant time where compared in application code; lookups are indexed equality queries; unknown/revoked/expired all return the same 404 shape.

## 4. Authorization design

### 4.1 One matrix, three consumers

The role/permission matrix from PRD §8 lives once, as data, in `packages/shared/src/permissions.ts`:

```ts
// illustrative
export const PERMISSIONS = {
  'menu.item.create':        ['owner', 'manager'],
  'menu.item.toggleAvailability': ['owner', 'manager', 'kitchen'],
  'order.status.accept':     ['owner', 'manager', 'kitchen'],
  'bill.discount.apply':     ['owner', 'manager'],      // manager subject to cap
  'bill.void':               ['owner', 'manager'],
  'payment.record':          ['owner', 'manager', 'billing'],
  'staff.manage.any':        ['owner'],
  'staff.manage.limited':    ['owner', 'manager'],      // kitchen/billing only
  // …
} as const;
```

Consumers: (1) API middleware, (2) the UI (to hide controls — **cosmetic only**), (3) the test generator that produces an allow/deny test for every route × role. The database independently enforces the most sensitive parts (RLS policies and triggers, Part 1 §6). A contract test compares the shared matrix with the database's role-transition table and RLS behaviour.

### 4.2 Rules that go beyond the role name

- Managers can manage Kitchen/Billing staff only; nobody can grant a role above their own; the last Owner cannot be removed.
- Manager discounts are capped by `manager_discount_cap_bps`; above that requires an Owner.
- Kitchen sees orders but **not** customer contact details (`order_customers` is unreadable for Kitchen, so the API cannot leak it even by accident).
- Super Admin can manage restaurants and see platform metadata; business data requires a time-limited, reason-recorded, audited support grant, read-only.

## 5. Tenant isolation design

Five independent layers, so no single defect exposes another restaurant:

| Layer | Control |
|---|---|
| 0. Database roles | Requests run as `dineflow_staff` / `dineflow_public`, never Supabase's `authenticated`/`service_role`, and the Supabase Data API is disabled, so a staff member cannot use their own token against a generated REST API to bypass our rules (Part 7 §3, F-1). |
| 1. Identity | Tenant is derived server-side from the authenticated user's membership row. A `restaurantId` in a URL/body is never trusted; where it appears at all (Super Admin routes) it is checked against the caller's authority. |
| 2. Application queries | All data access goes through `withTenantTx`; repository functions take the context object, not a raw ID, and always filter on `restaurant_id`. |
| 3. Database RLS | Every tenant table has RLS forced; staff role sees only `restaurant_id = app.restaurant_id()`; public role sees only its resolved restaurant. Applies to API queries as well. |
| 4. Structural integrity | Composite `(id, restaurant_id)` foreign keys make cross-tenant references unrepresentable. |
| 5. Storage | Object paths namespaced by `restaurant_id`; the API generates all paths; no client-supplied paths. |

**Verification:** an automated **isolation matrix** creates two restaurants with data in every table, then for **every route × every role × every foreign object type** asserts the response is 404/403 and no foreign data appears; pgTAP tests do the same at SQL level for every table (including `INSERT`/`UPDATE` attempts that try to switch `restaurant_id`). This runs on every pull request and is a release blocker.

## 6. Endpoint catalogue (v1)

`Public` = no login. Roles: **SA** super admin, **O** owner, **M** manager, **K** kitchen, **B** billing. Paths are relative to `/api/v1`. (Final request/response schemas are produced with each module and published as OpenAPI.)

### 6.1 Auth and session

| Method & path | Access | Notes |
|---|---|---|
| `POST /auth/login` | Public, rate-limited | Sets cookies, or returns `mfa_required`. |
| `POST /auth/mfa/verify` | Partial session | Completes MFA. |
| `POST /auth/mfa/enroll`, `POST /auth/mfa/enroll/verify` | Any staff | TOTP setup. |
| `POST /auth/logout`, `POST /auth/logout-all` | Any staff | |
| `POST /auth/password/forgot`, `POST /auth/password/reset` | Public, rate-limited | Constant response. |
| `POST /auth/password/change` | Any staff | Requires current password. |
| `GET /auth/invitations/check`, `POST /auth/invitations/accept` | Public, rate-limited | Token in body, not URL path. |
| `GET /me` | Any staff | Profile, role (server-derived), restaurant summary, permission keys for UI. |

### 6.2 Platform (Super Admin)

| Method & path | Access | Notes |
|---|---|---|
| `GET /platform/restaurants`, `POST /platform/restaurants` | SA (aal2) | Create restaurant + first-owner invite. |
| `PATCH /platform/restaurants/:id/status` | SA | Suspend/reactivate/close; audited. |
| `POST /platform/restaurants/:id/support-grants`, `DELETE …/:grantId` | SA | Time-limited read access; Owner sees it. |
| `POST /platform/restaurants/:id/exports` | SA | Trigger export on request. |
| `GET /platform/health` | SA | Counts/quota metadata only. |

### 6.3 Restaurant, settings, staff

| Method & path | Access | Notes |
|---|---|---|
| `GET/PATCH /restaurant` | O,M (patch: profile + `accepting_orders`) | Manager cannot change status/tax. |
| `POST /restaurant/logo` | O,M | Image pipeline. |
| `GET/PATCH /restaurant/settings` | O (write), M,B (read) | Currency lock after first bill. |
| `GET/POST/PATCH/DELETE /restaurant/tax-components` | O (write), M,B (read) | |
| `POST /restaurant/onboarding/complete` | O | Activates restaurant. |
| `GET /staff`, `POST /staff/invitations`, `DELETE /staff/invitations/:id` | O; M (limited roles) | |
| `PATCH /staff/:id` (role/status) | O; M (limited) | Last-owner and escalation guards. |
| `GET /audit-log` | O (all), M (limited types) | Filter by date/action/entity. |
| `POST /exports`, `GET /exports/:id` | O | Signed short-lived download URL. |

### 6.4 Tables and QR

| Method & path | Access |
|---|---|
| `GET /tables`, `POST /tables`, `POST /tables/bulk` | R: O,M,K,B · W: O,M |
| `GET/PATCH /tables/:id`, `DELETE /tables/:id` (archive or delete) | O,M |
| `GET /tables/:id/qr` (token + URL), `POST /tables/:id/qr/rotate` | O,M |
| `GET /tables/status` (vacant/occupied/awaiting bill) | O,M,K,B |

### 6.5 Menu

| Method & path | Access |
|---|---|
| `GET /menu` (full admin view incl. hidden/unavailable) | O,M,K,B |
| `POST/PATCH/DELETE(archive) /menu/categories[/:id]`, `POST /menu/categories/reorder` | O,M |
| `POST/PATCH/DELETE(archive) /menu/items[/:id]`, `POST /menu/items/:id/image` | O,M |
| `PATCH /menu/items/:id/availability` | O,M,K |

### 6.6 Public customer endpoints

| Method & path | Notes |
|---|---|
| `GET /public/tables/:token/menu` | Restaurant branding, table label, visible menu, ordering-enabled flag, contact policy, tax preview config. Cached 15 s. |
| `POST /public/tables/:token/orders` | Headers: `Idempotency-Key`, Turnstile token. Body: items `[{menuItemId, quantity, note?}]`, instructions, contact fields. Returns order ref, public token, server-computed subtotal and estimated total. |
| `GET /public/orders/:publicToken` | Status, items, totals; no contact details. |
| `POST /public/orders/:publicToken/cancel` | Only if setting enabled and status is `pending`. |

### 6.7 Orders and kitchen

| Method & path | Access | Notes |
|---|---|---|
| `GET /orders?status=&table=&from=&to=&q=&cursor=` | O,M,K,B | Kitchen response omits contact info. |
| `GET /orders/live?since=<cursor>` | O,M,K,B | Polling endpoint: orders changed since cursor + new cursor; 304 when unchanged. |
| `GET /orders/:id` | O,M,K,B | |
| `POST /orders/:id/status {to, version, reason?}` | Per transition rules | 409 on stale version or illegal transition. |
| `POST /orders/:id/revert {version, reason}` | O,M | One step back; audited. |
| `PATCH /orders/:id/staff-note` | O,M,K,B | Should-have. |

### 6.8 Billing

| Method & path | Access | Notes |
|---|---|---|
| `POST /bills {orderIds[]}` | O,M,B | Creates a draft snapshot. |
| `GET /bills`, `GET /bills/:id` | O,M,B | |
| `PATCH /bills/:id/discount {type, value, reason, version}` | O,M | Cap check. |
| `POST /bills/:id/finalize {version}` | O,M,B | Allocates number; idempotent. |
| `POST /bills/:id/void {reason, version}` | O,M | No live payment allowed. |
| `DELETE /bills/:id` | O,M,B | Drafts only. |
| `GET /bills/:id/pdf` | O,M,B | Generated from the finalized snapshot. |
| `GET /bills/:id/print` | O,M,B | Print-optimised data for the printable view. |
| `POST /bills/:id/payments {method, amount, reference?}` | O,M,B | Amount must equal total. |
| `POST /payments/:id/reverse {reason}` | O,M | Audited. |
| `GET /reports/sales?from&to&groupBy` | O,M (B: own billed sales) | Should-have; CSV export. |

### 6.9 Dashboard

| Method & path | Access |
|---|---|
| `GET /dashboard/summary` | O,M (K: order counts only; B: billed sales only) |

### 6.10 Operational

`GET /healthz/live`, `GET /healthz/ready` (unauthenticated, no sensitive detail).

## 7. Rate limiting and abuse controls

| Route class | Limit (initial values, tuned in load/abuse tests) | Key |
|---|---|---|
| Login / MFA verify | 5 failures per 15 min per account+IP, exponential back-off, then temporary lock (auto-expiring) | email + IP |
| Password forgot / invitation accept | 5 per hour | IP and email |
| Public menu | 120 per minute | IP |
| Public order create | 5 per 10 min per table token, 10 per 10 min per IP, plus a per-restaurant ceiling; Turnstile token required | token, IP, restaurant |
| Authenticated API | 300 per minute per user | user |
| Uploads | 20 per hour per restaurant | restaurant |
| PDF generation | 30 per minute per restaurant | restaurant |

In v1 counters are in-memory (single instance) with Cloudflare rate rules as the outer layer. The limiter sits behind an interface so a shared store can replace it when the API scales horizontally. Client IP is taken from the trusted proxy header only (configured proxy hop count; never blindly from `X-Forwarded-For`).

## 8. Order placement algorithm (the critical public write)

Inside a single transaction, as role `dineflow_public` with the restaurant resolved from the token:

1. Validate schema, Turnstile, rate limits; hash the request body.
2. Look up an existing order for `(restaurant_id, idempotency_key)`: same hash → return it (idempotent replay); different hash → 409.
3. Load the restaurant (must be `active` and `accepting_orders`), settings and table (must be active).
4. Load **all requested menu items in one query** by ID, scoped to the restaurant; require each to exist, be `visible`, `available`, not archived. Reject unknown IDs as if invalid, never revealing whether they exist elsewhere.
5. Enforce line and total limits from settings; enforce contact policy and format.
6. Compute unit prices, line totals, subtotal and estimated total **from database values only** using the shared money module.
7. Allocate the order number (counter row lock), insert `orders`, `order_items`, `order_customers` (if provided). Deferred trigger verifies totals; status-history trigger writes the first history row.
8. Commit; return the response. Any failure rolls back everything, including the number allocation.

## 9. Files, exports and PDFs

- **Uploads:** multipart to `POST …/image` routes only, streamed with a hard limit; magic-byte type check; decode → re-encode (`sharp`, pixel-count limit, metadata stripped); random UUID filename; stored in the tenant prefix; old image deleted after the new one is saved. Upload tests include polyglot files, SVG-as-image, oversized dimensions, and mismatched extensions.
- **CSV exports** neutralise spreadsheet-formula injection (values beginning with `= + - @ \t \r` are prefixed with `'`).
- **PDF** generation is text-only from snapshot data (no HTML rendering of user input).
- **Export downloads** use short-lived signed URLs to a private bucket; each download is audited.

## 10. Audit logging rules

Written inside the same transaction as the action. Recorded: actor, role, restaurant, action key, entity type/ID, small before/after summary (never passwords, tokens, or full contact details), IP, user-agent, request ID. Events: those in FR-121. Failed logins and lockouts are logged with the account identifier hashed if the account does not exist. The log is append-only (privileges revoked + trigger) and visible to Owners (all) and Managers (limited types).

## 11. Configuration and secrets

| Item | Where | Rule |
|---|---|---|
| Database connection string (`dineflow_api` role) | API host secret store | Per environment; rotated on staff change or suspected exposure. |
| Auth provider service key | API host secret store | **Never** in the SPA, logs or git; the SPA has no provider keys at all. |
| Turnstile secret | API host secret store | Site key (public) in SPA build. |
| Email provider key | API host secret store | |
| Backup encryption public key | CI secret | Private key offline. |
| Config validation | API refuses to boot if any required variable is missing or malformed (Zod-validated environment). | |
| Reference | `docs/ENVIRONMENT.md` lists every variable, purpose, environment and rotation procedure (written in the foundation module). | |
