# DineFlow — Technical Design, Part 0: Architecture and Decision Log

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for approval) |
| **Depends on** | [PRD v0.1](../PRD.md) (approved) |
| **Companion documents** | [01 Database](01-database.md) · [02 API, Auth, Tenant Isolation](02-api-auth-tenancy.md) · [03 Threat Model](03-threat-model.md) · [04 Test Strategy](04-test-strategy.md) · [05 Project Structure and Delivery](05-project-structure.md) · [06 Licensing Framework](06-licensing-framework.md) |

> **Vendor prices and plan terms** in this document were checked on 2026-09-20 where marked ✔ and otherwise come from general knowledge. Re-verify every price on the vendor's page before you commit money or quote a customer.

---

## 1. How to read this document

Decisions are labelled **D-xx** and each is listed in §10 for one-shot approval. Anything that changes or clarifies the approved PRD is listed in §11 as **PRD-CHG-xx**. Open PRD questions (Q-xx) that you did not answer are handled by explicit design assumptions in §12, so you can accept or override them.

## 2. Architecture options considered

The PRD asked me to evaluate Supabase Edge Functions, a separate Express server, and other options before deciding.

| | **A. Supabase-only** | **B. React SPA + Express API + Supabase (recommended)** | **C. Edge Functions as the API** |
|---|---|---|---|
| Shape | Browser talks directly to Supabase (PostgREST + RLS). Edge Functions for the few things RLS can't do (public ordering, PDF). | Browser talks **only** to our Express API. API talks to Postgres/Auth/Storage. | Browser talks to a Hono/Express-style app running as Supabase Edge Functions (Deno). |
| Hosts to run | 2 (static site, Supabase) | 3 (static site, API host, Supabase) | 2 |
| Monthly cost | Lowest | +~$7 for the API host | Lowest |
| Business logic | In SQL/RLS and scattered Edge Functions | In TypeScript, unit-testable, portable | TypeScript on Deno |
| Security layers | RLS is the **only** enforcement layer for direct access; every table needs perfect policies. Anon key and JWT live in the browser. | API authorization **plus** RLS (API queries also run under RLS). Browser holds no Supabase key. | Similar to B, but Deno runtime and function limits |
| Public ordering | Needs Edge Function anyway | Normal endpoint with rate limiting | Normal endpoint |
| PDF and image processing | Awkward in Deno (native `sharp` unavailable; memory and time limits) | `sharp` and a pure-JS PDF library on a normal Node host | Same limits as A |
| Testing | Harder (SQL-heavy logic; needs Supabase runtime) | Straightforward (Vitest + Supertest + local Postgres) | Harder (Deno test runner and edge runtime) |
| Rate limiting, headers, cookies | Limited control | Full control | Limited control |
| Vendor lock-in | High | Moderate: Postgres is standard; Supabase Auth is the main coupling | High |
| Cold starts | Yes for functions | None on an always-on host | Yes |
| Fit with your stack preference | Partial | **Exact** (Node, Express, TypeScript) | Partial |

**Recommendation: B.** It costs about $7/month more than A or C and buys defence in depth, much easier testing, no browser-side database credentials, full control of cookies, headers, rate limiting and uploads, and business logic that is not tied to one vendor's runtime. For a product that handles other businesses' financial records, A's "RLS is the only wall" is the wrong trade.

**Rejected outright:** one deployment per restaurant (10× operations burden for a solo operator; conflicts with BO-05), and a microservice split (unnecessary at this size).

## 3. Target architecture

```
                           Customers (phones)          Staff (phones/tablets/PCs)
                                   │                              │
                     scan QR → https://app.<domain>/t/<token>     │  https://app.<domain>
                                   ▼                              ▼
                     ┌─────────────────────────────────────────────────┐
                     │  Cloudflare (DNS, TLS, CDN, WAF, basic DDoS)    │
                     └───────────────┬─────────────────────┬───────────┘
                                     │ static assets       │ /api (JSON)
                                     ▼                     ▼
                       ┌───────────────────┐   ┌──────────────────────────────┐
                       │ Cloudflare Pages  │   │ Express API (Node, TS)       │
                       │ React SPA (Vite)  │   │  always-on container         │
                       └───────────────────┘   │  • authn/authz, validation   │
                                               │  • rate limits, audit        │
                                               │  • pricing, billing, PDF     │
                                               │  • image validation          │
                                               └──────┬───────────────┬───────┘
                                                      │ SQL (pooled)  │ Admin/Auth API, Storage API
                                                      ▼               ▼
                                          ┌──────────────────┐  ┌────────────────────┐
                                          │ Supabase Postgres│  │ Supabase Auth      │
                                          │ RLS on all tables│  │ Supabase Storage   │
                                          └──────────────────┘  └────────────────────┘

   Side services: Turnstile (bot check) · Transactional email · Sentry (errors) · Uptime monitor
   Backups:       Supabase daily backups + our own encrypted off-site dumps every 6 h
```

### 3.1 Key properties

1. **The browser talks only to our API.** No Supabase URL, anon key or JWT ever reaches JavaScript. This removes a whole class of "direct database access from the client" mistakes and matches the requirement of no keys in frontend source.
2. **RLS is enforced for API queries too.** The API connects with a restricted login role (not the table owner, no `BYPASSRLS`). For every request it opens a transaction, switches to a low-privilege role, and sets the identity that the RLS policies read (details in Part 2 §4). A forgotten `WHERE restaurant_id = …` in application code therefore returns nothing instead of leaking data.
3. **Three database access modes**, each with its own role:
   - *Staff*: RLS scoped by the caller's active membership.
   - *Public customer*: RLS scoped to the single restaurant resolved from a valid QR token; column-level grants expose only public-safe columns.
   - *Platform admin*: access to `restaurants` and platform metadata only; tenant business data needs an audited, time-limited support grant.
4. **Business rules live in one place per concern:** money/tax/pricing and the order state machine in a shared TypeScript package (unit-tested); the invariants that must never break (immutability of finalized bills, gap-free numbering, tenant-matching foreign keys, valid status transitions, totals consistency) are **also** enforced by the database via constraints and triggers.
5. **Single always-on API instance** for v1. Stateless except for an in-memory rate-limit counter and a 15 s menu cache; both are safe to lose and both have a documented path to a shared store when a second instance is added.

### 3.2 Live updates (FR-050)

**Decision D-05:** v1 uses **cursor-based polling every 3 seconds** (only while the tab is visible), with `If-None-Match`/`since` cursors so an idle poll is one cheap indexed query. Worst-case notification latency is about 3 s plus network time, inside the 5 s target (NFR-P04).

Why not WebSockets/Supabase Realtime now: it would put a Supabase JWT back into the browser (undoing key isolation) or require a custom WebSocket/SSE layer with a shared pub/sub once the API has more than one instance. Load is trivial (≈10 restaurants × 3 devices × 20 requests/min ≈ 600 lightweight requests/min).

The UI hides the transport behind one hook (`useLiveOrders`), so a Server-Sent Events upgrade later is a contained change. The kitchen screen shows a "Live / Reconnecting" indicator (FR-050) and plays the alert sound on new orders (needs one initial tap to enable audio on iOS/Safari; the screen prompts for it).

### 3.3 Customer flow (public)

1. Customer scans QR → opens `https://app.<domain>/t/<token>` (SPA route, static, CDN-cached).
2. SPA calls `GET /api/v1/public/tables/:token/menu`. The API resolves the token in the database (revoked or unknown tokens return an identical generic 404), then returns restaurant branding, table label and the visible menu. Responses are cached in memory for 15 s per restaurant (FR-027 allows 30 s).
3. Customer builds a cart locally (persisted in `localStorage`, versioned, validated on load).
4. `POST /api/v1/public/tables/:token/orders` with an `Idempotency-Key` header (random UUID generated when the checkout screen opens, kept until success) and a Turnstile token. The API validates everything against database state, computes prices, and creates the order in one transaction.
5. Confirmation page uses `GET /api/v1/public/orders/:publicToken` (unguessable 128-bit token, returns only non-sensitive fields) and polls every 5 s for status.

### 3.4 Billing and PDF

- Bills are **snapshots**: the bill stores item names, quantities, unit prices, tax components, restaurant identity lines and totals at generation time, so later menu or tax edits cannot change a bill.
- PDFs are generated server-side from the finalized snapshot with **pdfmake** (pure JavaScript; no headless browser, so it fits a small 512 MB container). An embedded Unicode font (Noto Sans subset) ensures the ₹ symbol and Indic text render correctly. The printable HTML bill uses the same snapshot and a print stylesheet (80 mm thermal and A4).
- Tests assert that on-screen, print and PDF totals equal the stored totals (part of NFR/Success metric "0 mismatches").

### 3.5 Images

Uploads go through the API (never directly to storage). The API checks size (≤ 5 MB), sniffs the real file type from content (JPEG/PNG/WebP only), decodes and **re-encodes with `sharp`** (max 1600 px, WebP, all metadata stripped, decompression-bomb limits), and writes to a public Supabase Storage bucket under `restaurants/<restaurant_id>/…/<random-uuid>.webp`. Menu images are public content by nature; paths are unguessable and never user-supplied. Deleting a tenant purges its prefix.

## 4. Environments

| | **Development** | **Staging** | **Production** |
|---|---|---|---|
| Purpose | Local building and tests | Pre-release verification, UAT, load and security tests | Live customers |
| Database | Local Supabase stack (Docker) | Separate Supabase project (Free tier acceptable, no real data) | Supabase **Pro** project |
| API | `pnpm dev` | Render service (can use a smaller/sleeping plan; not customer-facing) | Render Starter or higher, always-on |
| Frontend | Vite dev server | Cloudflare Pages preview/branch | Cloudflare Pages production |
| Data | Seed script; **all demo data labelled `[DEMO]`** (PRD §8) | Synthetic data only; never a production copy | Real |
| Secrets | `.env.local` (git-ignored) | Platform secret store | Platform secret store; separate keys from staging |
| Deploy trigger | — | Every merge to `main` | Manual approval of a tagged release |
| Backups | none | none | Yes (see §6) |
| Email | Local inbox (Inbucket) | Sandbox domain | Verified sender domain (SPF/DKIM/DMARC) |

Rules: no production data in staging; no shared secrets between environments; CI is the only path to staging/production; database migrations are applied by CI, never by hand.

## 5. Hosting, capacity and cost (≈10 restaurants)

### 5.1 Recommended stack and rough monthly cost

| Component | Choice | Approx. cost / month | Notes |
|---|---|---|---|
| Database, Auth, Storage | **Supabase Pro** ✔ | **$25** | Free tier has **no automatic backups** and **pauses after 1 week of inactivity** ✔ → unsuitable for customers. Pro: 8 GB DB, 100 GB storage, 250 GB egress, daily backups kept 7 days, never paused ✔. Point-in-time recovery is a $100/month add-on ✔ (not recommended at this scale; see §6). |
| API host | **Render Starter** (always-on) | **~$7** | Free instances spin down after 15 min idle (≈1 min cold start) ✔ → unacceptable for order intake. Verify current Starter price/specs and the available regions. |
| Frontend hosting | **Cloudflare Pages** (free) | $0 | **Not Vercel Hobby:** its terms restrict Hobby to non-commercial use, and "receiving payment to … host the site" counts as commercial ✔. Vercel Pro is ~$20/month if you prefer it. Confirm Cloudflare's current terms for commercial use on the free plan before launch (the limits page did not state it). |
| DNS, CDN, WAF, TLS | Cloudflare (free) | $0 | |
| Bot protection | Cloudflare Turnstile | $0 | |
| Transactional email | Resend / Brevo / SES free or low tier | $0–5 | Invites and password resets only; low volume. |
| Error tracking | Sentry (free developer tier) | $0 | With PII scrubbing. |
| Uptime monitoring | UptimeRobot/Better Stack free | $0 | 1–5 min checks + alert to phone/email. |
| Off-site backup storage | Cloudflare R2 or Backblaze B2 | ~$0–1 | Encrypted dumps. |
| Domain | `.com`/`.in` | ~$1 (≈$12/yr) | Must be permanent (QR codes are printed). |
| **Total** | | **≈ $33–38** | Budget **≈ $45** with headroom. |

**Per-restaurant view:** ≈ $45 ÷ 10 ≈ **$4.50/restaurant/month → ≈ $110 per restaurant over a 2-year hosting bundle**, falling as you add restaurants. Price your one-time fee so that this, plus support time, is covered with margin. Foreign-exchange and price changes are your risk; keep a buffer.

### 5.2 Capacity

Sizing from PRD NFR-P: ~1,000 concurrent menu viewers platform-wide worst case; ~10 orders/min per restaurant at peak. Menu reads are cached (Cloudflare edge for static SPA, 15 s in-process cache for menu JSON). Orders are a handful of small inserts. The 512 MB / shared-CPU API tier and Supabase Pro's default small compute instance should handle this comfortably; **this is verified by load tests in Stage 5, not assumed.** The first scaling steps, in order: bigger Supabase compute → bigger API instance → second API instance with a shared rate-limit store.

### 5.3 Region and data residency

Recommended: Supabase in **Singapore** (or Mumbai, if available on your plan) with the API in the nearest available region, so API↔database round trips stay short. Whether Indian customer data must stay in India is a **legal-review item** (NFR-C03); the design does not depend on the region, but moving it later is a migration.

### 5.4 Cost guard rails (answers "hosting costs exceed the budget")

- Keep Supabase's **spend cap on** (Pro default) so overage cannot silently accrue; alert at 70 % and 90 % of database size, egress and storage.
- Per-restaurant limits: image size and count, request rate limits, order-history retention rules.
- Monthly cost review checklist in the operations guide; a documented order of cost levers (image compression → egress caching → archiving old order details → plan change).
- If costs exceed the bundle budget: quote renewal per license terms (Part 6), or hand over the export and migration package.

## 6. Backup, recovery and operations

### 6.1 Backup strategy

| Layer | What | Frequency / retention | RPO |
|---|---|---|---|
| L1 | Supabase managed daily backup | Daily, 7 days ✔ | ≤ 24 h |
| L2 | **Our own `pg_dump`** (public schema + `auth` users, includes password hashes → **encrypted with `age` before leaving the runner**) pushed by a scheduled GitHub Action to R2/B2 | Every 6 h; keep 14 daily + 8 weekly + 6 monthly | ≤ 6 h |
| L3 | Storage bucket sync (menu images) | Daily | ≤ 24 h |
| L4 | Per-restaurant export (CSV/JSON + PDFs) | On demand + before offboarding | n/a |

L2 gives a vendor-independent restore path and a cheaper RPO than PITR ($100/month). If a customer contract demands RPO ≤ 1 h, buy PITR then. Targets: **RPO ≤ 6 h, RTO ≤ 4 h** (better than NFR-R02).

**Restore drill:** before go-live and quarterly, restore the newest L2 dump into a scratch project, run the smoke and integrity checks (row counts, bill totals, foreign keys, login works), record time taken and results in `docs/runbooks/restore-drills.md`. **A backup that has not been restored is not counted as a backup.**

### 6.2 Failure scenarios (required by the PRD)

| Scenario | What customers/staff see | What happens / what to do |
|---|---|---|
| **API down** | Customers: friendly "Ordering temporarily unavailable, please call the waiter". Staff: red "Offline" indicator; last-loaded screens stay readable. | Uptime alert → check Render status/logs → redeploy or roll back → verify. Restaurants continue with paper as before; no data is lost because nothing was accepted. Runbook gives restaurants a one-page manual fallback. |
| **Database unavailable** | Same as above; API health check `/healthz/ready` fails and the API returns 503 (never partial success). | Check Supabase status; if regional outage, wait or restore L2 into a new project (RTO ≤ 4 h) and switch the API's connection string; QR codes keep working because they point at our domain, not the database. |
| **Failed deployment** | Migrations run first, in CI, against staging; production deploy has a health-gated rollout. | Frontend: promote the previous Pages deployment (instant). API: redeploy the previous image. Database: migrations are written **expand/contract** (backward-compatible), so rolling the app back does not require reversing schema; destructive changes ship in a later release. |
| **Backup cannot be restored** | None. | The restore drill exists to catch this early. If it fails: fix immediately, take a fresh dump, retry; use the next-older backup tier; incident recorded. No launch until a drill succeeds. |
| **Restaurant wants its data** | Owner clicks *Export* (or you trigger it). | Export job produces a ZIP (CSV/JSON + bill PDFs) containing only that tenant's data; audited. Offboarding runbook follows Part 6. |
| **Hosting costs exceed budget** | None. | See §5.4. |

### 6.3 Monitoring and logging

- **Uptime:** external monitor on `/healthz/live` (process) and `/healthz/ready` (database reachable), 1-minute interval, alerts to phone.
- **Errors:** Sentry in API and SPA, PII scrubbed (no contact fields, no tokens, no cookies).
- **Logs:** structured JSON (pino) with a per-request ID; redaction of `authorization`, cookies, contact fields, tokens. Log retention = the host's default (short); the **audit log in the database** is the long-term record for sensitive actions.
- **Alerts:** health-check failure, error-rate spike, Supabase quota ≥ 70 %, failed backup workflow, dependency-vulnerability finding.

## 7. Scaling path (beyond 10 restaurants)

| Trigger | Change |
|---|---|
| Latency or CPU high on the database | Increase Supabase compute; add indexes found by `pg_stat_statements`. |
| API CPU/memory pressure | Vertical scale, then horizontal with a shared rate-limit store (Postgres or Redis) and Server-Sent Events via a pub/sub. |
| Order-history tables become large | Monthly partitioning of `orders`/`audit_log` by `placed_at`/`created_at`; archive detail rows after the retention period. |
| Need self-signup / subscriptions | Add a billing service and public signup flow (v2 roadmap) — the tenant model already supports it. |
| Enterprise customer wants isolation | Dedicated Supabase project + API instance from the same codebase (config-only change). |

The tenant model (a `restaurant_id` on every business row, composite tenant-matching foreign keys, RLS) is what makes 10 → 100+ restaurants a capacity exercise rather than a redesign.

## 8. Technology choices

| Area | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict), one repo (pnpm workspaces), Node LTS pinned via `.nvmrc` | One language, shared types/validation between web and API. |
| Frontend | React + Vite + React Router + Tailwind CSS; component layer built on Radix UI primitives (shadcn/ui pattern: components live in our repo, accessible by default); TanStack Query for server state; React Hook Form + Zod for forms | Accessible, maintainable, no heavy UI framework lock-in. |
| Backend | Express + Zod validation + Helmet + pino + express-rate-limit; OpenAPI spec generated from the Zod schemas | Matches your preference; the spec doubles as the API documentation. |
| DB access | **Kysely** (type-safe SQL builder; parameterised by construction) on `pg`; plain-SQL migrations applied by our own runner (Supabase CLI optional locally); **TypeScript database tests** (Part 7 §2, D-22) | Real SQL where correctness matters (transactions, locks), no ORM magic, migrations reviewable as SQL. |
| Auth | Supabase Auth (email + password, TOTP MFA), driven **server-side** by the API | Trusted provider handles password hashing, MFA and reset tokens. |
| Money | **Integer minor units (`bigint`)** in DB, API and UI (e.g., paise). Display formatting via `Intl.NumberFormat`. | No floating point anywhere; simplest to test. (PRD-CHG-03) |
| QR | `qrcode` library, SVG/PNG generated client-side from the token URL | The token is a low-value capability; no server round trip. |
| PDF / images | pdfmake / sharp | See §3.4–3.5. |
| Testing | Vitest (incl. database tests), Supertest, Playwright (+ axe), k6, OWASP ZAP baseline, Semgrep, gitleaks, `pnpm audit` | See Part 4 and Part 7 §2. |
| CI/CD | GitHub Actions | Free tier adequate; environments with protected production deploys. |

## 9. Major decisions (rationale)

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| D-01 | Architecture B: SPA + Express API + Supabase | A (Supabase-only), C (Edge Functions) | §2. |
| D-02 | Browser never talks to Supabase | supabase-js in browser | Removes browser-side credentials; single enforcement point plus RLS. |
| D-03 | API queries run under RLS via per-request `SET LOCAL ROLE` and identity settings | API as superuser with app-level filters only | A missing filter must fail closed. |
| D-04 | Staff sessions in **HttpOnly, Secure, SameSite cookies** issued by the API | Tokens in `localStorage` | XSS cannot read cookies. Costs a small custom auth layer (login, refresh, logout, MFA, reset) that wraps Supabase Auth and is covered by tests. |
| D-05 | Polling (3 s) for live orders in v1 | Supabase Realtime, SSE | §3.2. |
| D-06 | Kysely + SQL migrations + pgTAP | Prisma/Drizzle | SQL-first for triggers/RLS; ORM migration tools handle RLS and triggers poorly. |
| D-07 | Money as integer minor units; 2-decimal currencies only in v1 | `numeric(12,2)` | One representation end to end. JPY/KWD-style currencies are unsupported until needed. |
| D-08 | Tax computed at **bill level** per component on the post-discount taxable amount, round-half-up on minor units; inclusive mode extracts tax from the gross | Per-line tax | Simple and testable. If a restaurant's jurisdiction requires per-line tax display, that is a paid customisation and an accountant decision (BR-BILL-08). |
| D-09 | Cloudflare Pages + Render + Supabase Pro | Vercel Hobby (commercial use prohibited ✔), Vercel Pro, Fly.io | §5. |
| ~~D-10~~ | **Superseded by Part 7 §5.** (Was: random QR tokens stored recoverably.) | | Storing usable tokens made a database leak sufficient to order at every table. |
| D-10a | QR tokens are **HMAC-signed**: `kid ‖ qr_id ‖ MAC`; the database stores only `qr_id`, never the token or MAC; tokens are recomputed for reprinting from the server key | Random stored tokens; hash-only storage | Two independent secrets (database + server key); reprinting still works; forged tokens are rejected before any database access. Part 7 §5. |
| D-11 | Order placement and billing in TypeScript inside single DB transactions, guarded by database triggers/constraints for invariants | Logic entirely in SQL functions | Testable code plus DB-level safety net. |
| D-12 | pdfmake for PDFs | Puppeteer/Playwright | Memory footprint; no browser on a 512 MB host. |
| D-13 | Cloudflare in front of app and API (DNS, WAF, basic rate rules) + in-app rate limits + Turnstile on order placement | App-only limits | Cheap layered abuse control. Turnstile outage → degrade to stricter per-table limits rather than block all ordering. |
| D-14 | Own encrypted `pg_dump` every 6 h to off-site storage | Paid PITR | Vendor-independent, ~$1/month, RPO ≤ 6 h. |
| D-15 | Invitations via our own table and token (72 h expiry, single use); user created via Auth admin API at acceptance | Supabase invite emails | Full control of expiry and role binding. |
| D-16 | Table code/PIN (Q-15) **not built in v1**; schema and settings leave a hook | Build now | Staff acceptance + rotating QR + rate limits + Turnstile are the v1 defences; revisit after pilot data. |
| D-17 | Customers see an **estimated total** (subtotal plus taxes/service charge computed by the same shared function the bill uses); the bill is authoritative | Show subtotal only | Avoids surprise; labelled "estimate — final amount on your bill". |
| D-18 | One order counter per restaurant; bill number series per restaurant (`series` column, default single series) | Global counters | Gap-free per restaurant via row lock in the same transaction. Series reset per financial year is a config option (Q-13). |
| D-19 | **DineFlow uses its own database roles** (`dineflow_staff`, `dineflow_public`); Supabase's `anon`/`authenticated`/`service_role` get no privileges, and the Data API/GraphQL/Realtime are disabled | Reusing `authenticated` with RLS | A staff member can read their own token from dev tools; with `authenticated` privileges they could write through Supabase's auto-generated API, skipping our rules and audit log. Part 7 §3 (F-1). |
| D-20 | **Hash-chained `bill_ledger`** with externally anchored chain heads and bill `content_hash` printed on documents | Audit log only | Makes direct-database tampering *detectable*, not just blocked. Part 7 §6. |
| D-21 | **Restore verification is automated** (schema, security posture, checksums, integrity, ledger, isolation re-run) and runs in CI, not only as a quarterly manual drill | Quarterly manual drill | A backup nobody restores is a guess. Part 7 §4. |
| D-22 | Database tests in **TypeScript (Vitest + `pg`)** rather than pgTAP | pgTAP | Catalog introspection, generated matrices and rolled-back sabotage tests; runs on plain Postgres and exercises the API's real transaction wrapper. Part 7 §2. |

## 10. Approval checklist for Stage 2

Approving this stage means approving: D-01 to D-18, the database design (Part 1), the API/auth/tenancy design (Part 2), the threat model (Part 3), the test strategy (Part 4), the project structure and module plan (Part 5), and the licensing *framework* (Part 6, subject to legal review). If you object to a single decision, name its ID and I will revise only that.

## 11. Changes and clarifications to the approved PRD

| ID | Change | Reason |
|---|---|---|
| PRD-CHG-01 | **BR-ORD-04 is extended:** an order cannot be cancelled while attached to *any* non-void bill, including a Draft. | Prevents a draft bill silently referring to a cancelled order. |
| PRD-CHG-02 | **NFR-S13 revised (see Part 7 §5):** QR tokens are HMAC-signed capability tokens; the database stores only the random `qr_id`, never a usable token. Customer order-status tokens are stored **hashed**. | Satisfies NFR-S13's intent better than the original: a database leak alone cannot produce a working token, and reprinting still works. |
| PRD-CHG-03 | **Money is stored as integer minor units**, not `numeric`. Only 2-decimal currencies in v1. | Simplicity; still exact. |
| PRD-CHG-04 | **"Realtime" is implemented as 3-second polling** in v1 (still satisfying FR-050 and NFR-P04). | §3.2. |
| PRD-CHG-05 | **Hosting recommendation excludes Vercel Hobby** (non-commercial use only ✔). | Licensing conflict with a commercial product. |
| PRD-CHG-06 | Customer order screen shows an **estimated** total including tax/service charge (D-17); the bill remains authoritative. | Clarifies FR-036 for exclusive-tax restaurants. |

## 12. Assumptions I will build on for unanswered PRD questions

You approved the PRD without answering §17, so unless you say otherwise:

| Q | Design assumption |
|---|---|
| Q-01 | Invite-only onboarding by Super Admin. |
| Q-02 | India-first defaults (INR, Asia/Kolkata, generic tax components; GSTIN shown as "Tax registration no."). No e-invoicing, HSN/SAC in v1. |
| Q-03 | Budget ≈ $45/month total, Supabase Pro accepted. **Please confirm.** |
| Q-04 | You will register one permanent domain; QR URLs are `https://app.<domain>/t/<token>`. **Needed before printing any real QR code.** |
| Q-05 | Contact-collection policy per restaurant; default retention: keep until Owner deletes or the configurable auto-anonymise period (default off, recommended 365 days) elapses. |
| Q-06 | One bill may cover multiple orders of the same table (`bill_orders` join). One-order-per-bill remains possible. |
| Q-07 | No variants/add-ons in v1 (schema extensible via `order_item_options` later). |
| Q-08 | No partial payments/tips; one payment equal to the bill total. |
| Q-09 | Owner/Manager may revert status one step (audited); no item edits after placement. |
| Q-10 | Matrix from PRD §8 as written; Managers can manage Kitchen/Billing staff only; Billing cannot discount; no Waiter role (permissions are data-driven so it can be added cheaply). |
| Q-11 | English only; UI strings kept in a translation-ready structure. |
| Q-12 | Manager discount cap default 20 % (configurable by Owner); above requires Owner. |
| Q-13 | Continuous order numbers per restaurant; single bill series. |
| Q-14 | **Single shared hosted deployment; no source-code delivery.** Affects licensing (Part 6). |
| Q-15 | See D-16. |
| Q-16 | Manual "accepting orders" toggle only; optional hours are roadmap. |
| Q-17 | Audible browser alert with a one-tap enable. |
| Q-18 | Veg/non-veg/egg indicator yes; allergens no. |
| Q-19–21 | Support/renewal terms proposed in Part 6; a pilot restaurant is strongly recommended before rollout. |
