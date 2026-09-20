# DineFlow — Technical Design, Part 7: Resolution of Stage 2 Conditions

| | |
|---|---|
| **Version** | 0.1 |
| **Purpose** | Addresses the six conditions attached to the conditional Stage 2 approval: tenant-isolation testing, RLS enforcement, backup-restore testing, QR security, billing auditability, licensing. |
| **Supersedes** | Where this document conflicts with Parts 0–6, **this document wins**. Parts 0–6 have been patched to match where the change was small; larger changes are described here in full. |

> **About the "temporary assumptions".** The instruction referred to temporary assumptions "provided" for Q-03, Q-04, Q-06, Q-10 and Q-14. No separate text was attached to the message, so I used the assumptions I proposed in Part 0 §12 and restate them in §1 below. **If yours differ, tell me and I will change them; nothing built so far depends on them.**

---

## 1. Temporary assumptions register

| Q | Temporary assumption (in force until you replace it) | Where it bites | What changes if it is wrong |
|---|---|---|---|
| **Q-03** Budget | ≈ **$45 / month** total infrastructure, **Supabase Pro accepted**. | Part 0 §5 cost model; backups (own dumps instead of PITR). | Lower budget → cannot ship to customers (Free tier has no backups and pauses). Higher budget → add PITR and a second API instance. |
| **Q-04** Domain | **Provisional domain**. Every URL is built from one configuration value (`APP_BASE_URL`). **No QR code may be printed for a real restaurant until the domain is declared final** (`QR_DOMAIN_FINAL=true`); until then the print sheet carries a "PROVISIONAL — DO NOT PRINT" watermark and printing is disabled in production. | QR generation (module 8), emails, CORS. | A domain change after printing invalidates every printed QR. |
| **Q-06** Billing unit | A bill may cover **one or more orders of the same table** (`bill_orders` join). One-order-per-bill is the special case of a single-element list. | Billing schema and UI (module 14). | If you prefer strictly one order per bill, the join table stays but the API restricts to one element; no schema change. |
| **Q-10** Roles | Permission matrix exactly as PRD §8; Managers manage Kitchen/Billing staff only; Billing cannot apply discounts; **no separate Waiter role** (Manager/Billing mark orders Served). Permissions are data-driven so a Waiter role is a small change. | Permission matrix, RLS policies, tests. | Adding a role = one enum value + matrix rows + RLS/test cells (the isolation harness fails until every cell is specified). |
| **Q-14** Licensing model | **Single shared hosted deployment; no source-code delivery.** Restaurants get a perpetual right to use the service *while hosted*, with hosting and support included for a fixed term, then renewable. | Part 6; DPA; offboarding; QR continuity. | Source delivery or self-hosting changes pricing, support scope and security responsibilities substantially (Part 6 §1, Model B). |

---

## 2. Tenant-isolation testing (Condition 1)

**Weakness found in the Stage 2 plan:** an isolation suite that is written by hand can silently stop covering a new table, and a suite that has never been seen to fail proves nothing. The plan now requires the harness to test itself.

### 2.1 Requirements

| ID | Requirement |
|---|---|
| ISO-01 | **Automatic discovery.** The harness introspects the catalog (`pg_class`, `pg_policies`, `information_schema`). Any table in `public` that has a `restaurant_id` column — or that is not on an explicit, reviewed **non-tenant allow-list** (`platform_admins`, and similar) — is treated as tenant data. A new table therefore cannot escape the tests by being forgotten. |
| ISO-02 | **Structural guard per tenant table:** RLS enabled **and forced**; `restaurant_id` is `NOT NULL` with a foreign key to `restaurants`; policies exist for every command the table is granted; no `PUBLIC`/`anon`/Supabase `authenticated` grants; write policies have `WITH CHECK`. Violations fail CI with the table name. |
| ISO-03 | **Behavioural matrix, declared as data.** `isolation-matrix.ts` declares, for every (table × principal × command), the *expected* outcome: `own-only`, `denied`, `insert-own-only`, `read-only-with-grant`, etc. A table/principal/command cell that is not declared **fails the run** ("unspecified cell"), so adding a table or a role forces a conscious decision. |
| ISO-04 | **Two-tenant fixtures with markers.** Restaurants A and B (plus C for platform-level checks) each have data in every table with unique marker strings. Assertions check both row counts and that B's markers never appear in any result visible to A's principals. |
| ISO-05 | **Principals under test:** Owner-A, Manager-A, Kitchen-A, Billing-A, deactivated staff of A, staff of a suspended restaurant, Owner-B, unauthenticated/public (with and without a resolved restaurant), platform admin without MFA, platform admin (aal2) without grant, platform admin with live grant, platform admin with expired/revoked grant, and the API login role with no context. |
| ISO-06 | **Cross-tenant write attempts:** `INSERT` with B's `restaurant_id` as A, `UPDATE … SET restaurant_id = B`, `UPDATE`/`DELETE` of B's rows by primary key, and reference-stuffing (child row of A pointing at B's parent, once such tables exist). |
| ISO-07 | **Context-leak test.** With a pool of size 1, run request A then request B on the *same physical connection*: B must not see A's identity; after commit and after rollback the role and settings must be reset. |
| ISO-08 | **Test-principal hygiene.** Tests run through the same `withStaffTx` / `withPublicTx` functions the API uses, connected as the real non-owner `dineflow_api` login. A guard test asserts the connection is not a superuser, not `BYPASSRLS`, and not a table owner. (A superuser silently bypasses RLS, which is the classic way an isolation suite passes while proving nothing.) |
| ISO-09 | **Mutation proof ("canaries").** A separate suite applies each of the following *sabotages* inside a transaction that is rolled back, re-runs the guard and matrix checks, and **requires that they fail**: disable RLS on a table; drop a policy; replace a policy with `USING (true)`; grant a table privilege to `PUBLIC`; give `dineflow_api` `BYPASSRLS`; create a tenant table without RLS; remove `FORCE`. If a sabotage is *not* detected, the harness itself is broken and CI fails. |
| ISO-10 | **API-layer matrix (from module 3 on).** The endpoint registry is introspected; every route × role × foreign-object combination is generated (Part 4 §3.2). Routes missing from the registry or the permission matrix fail CI. |
| ISO-11 | **Report.** Each run prints the covered cell count (tables × principals × commands) and fails on any unspecified cell, so coverage is visible and cannot decay quietly. |

**Deviation from Part 4:** database tests are written in TypeScript (Vitest + `pg`) instead of pgTAP. Reasons: catalog introspection, matrix generation and rolled-back sabotage tests are much easier in TypeScript; the tests exercise the API's real transaction wrapper; and they need no database extension, so they run identically on plain Postgres (CI, local Docker) and on the Supabase local stack. pgTAP remains an option for pure-SQL unit tests of individual triggers.

---

## 3. RLS enforcement (Condition 2)

Reviewing Part 1 §6 against the ISO requirements exposed gaps. Changes:

### 3.1 Findings and fixes

| ID | Finding | Fix |
|---|---|---|
| **F-1** | **Supabase's own `authenticated` role would still be a door.** A staff user can read their own access token from browser dev tools (HttpOnly protects against scripts, not against the user). If the token is used against Supabase's auto-generated REST/GraphQL API under the `authenticated` role, a permissive RLS policy would let that user write rows directly, **skipping API rules and audit logging**. | DineFlow uses its **own roles**, never `authenticated`: `dineflow_staff` (staff/platform-admin requests) and `dineflow_public` (customers). `anon`, `authenticated` and `service_role` receive **no privileges** on any DineFlow table, and default privileges are revoked so future tables are safe by default. A token issued by Supabase Auth therefore reaches nothing through the Data API. Additionally, the Data API, GraphQL and Realtime are **disabled** in every environment (config in the repo; verified by a staging/production check that a valid user token gets no data from `/rest/v1`). |
| **F-2** | API might run as a role that bypasses RLS by mistake (owner, superuser, `service_role`). | `dineflow_api` login role is `NOSUPERUSER NOBYPASSRLS`, owns nothing, has **no table privileges** of its own, and can only `SET ROLE` to the two DineFlow roles. The API **refuses to start** (`assertSafeDbRole`) if its role is superuser/bypass/owner of any table, or if it can read a tenant table without context. Tested by ISO-08 and a startup test. |
| **F-3** | Before a request has a tenant context the API must look up the user's membership, but `dineflow_api` has no table access. | One narrow `SECURITY DEFINER` function `app.lookup_membership(user_id)` returns only (restaurant, role, status, platform-admin flag). `EXECUTE` is granted to `dineflow_api` only. |
| **F-4** | `SECURITY DEFINER` functions are a classic RLS bypass (mutable `search_path`, over-broad returns, `PUBLIC` execute). | Every definer function: pinned `search_path` (`pg_catalog, public`, schema-qualified references), `REVOKE EXECUTE … FROM PUBLIC`, explicit grants, no dynamic SQL, return narrow columns only. A catalog guard lists all definer functions and compares against an allow-list, checking `proconfig` for `search_path` and the ACL. New definer functions require the allow-list to change in a reviewed PR. |
| **F-5** | Views can bypass RLS (they run with the owner's rights unless `security_invoker`). | No tenant views in v1; the catalog guard fails on any view in `public` that lacks `security_invoker = true`. |
| **F-6** | Policies with `USING (true)`, missing `WITH CHECK`, or new tables created without RLS. | ISO-02 structural guard plus a static lint of `pg_policies`. |
| **F-7** | Default privileges in Supabase grant table access to `anon`/`authenticated`/`service_role` on new tables. | Migration 001 revokes default privileges; every migration ends with explicit `GRANT`s; ISO-02 checks the effective privileges of these roles on every table (a **grant snapshot** test fails on any unexpected privilege). |
| **F-8** | Identity comes from a session setting (`request.jwt.claims`) that SQL can change. | Documented limit (Part 1 §6.4). Compensating controls: parameterised queries only, ESLint/Semgrep ban on raw SQL strings, `dineflow_api` cannot `SET ROLE` to anything other than the two DineFlow roles, `RESET ROLE` returns to a role with no privileges (tested). |
| **F-9** | Platform admin access relies on the MFA level claim. | `app.is_platform_admin()` requires `aal2` in the claims; the API only fills that claim from a verified token whose `aal` is `aal2`. Test: SA without aal2 sees nothing. |

### 3.2 Operational checks (staging and production)

A script `scripts/check-rls-live.ts` (run by the release checklist and nightly against staging) connects with the API credentials and verifies: role attributes, RLS enabled and forced on all tenant tables, policy inventory hash equals the reviewed baseline, no privileges for `anon`/`authenticated`/`service_role`, Data API and GraphQL disabled. **Any drift alerts the operator.**

---

## 4. Backup and restore testing (Condition 3)

**Weakness found:** Part 0 promised a quarterly manual drill. A backup process that is exercised four times a year fails silently for months. Restore verification is now automated at three levels.

### 4.1 Levels

| Level | What | When | Where |
|---|---|---|---|
| **R1: automated round trip** | `scripts/restore-drill/run.sh`: create seeded database → `pg_dump` (custom format) → encrypt with `age` → transfer → decrypt → restore into a **fresh** database → run verification (below). Includes negative tests. | Every PR touching migrations or scripts, plus weekly | Local Docker / CI |
| **R2: production-shaped drill** | Same script pointed at the *actual latest off-site dump* restored into a scratch Supabase project or Postgres container. Time recorded against RTO (4 h). | **Before go-live**, then monthly (scripted), report stored in `docs/runbooks/restore-drills.md` | Your machine/CI with the offline key |
| **R3: dead-man switch and key custody** | Backup workflow writes a signed heartbeat; an external monitor alerts if none is newer than 8 h. Twice a year the second key custodian proves they can decrypt a recent sample. | Continuous / 6-monthly | Monitoring + calendar |

### 4.2 Verification performed on every restored database (R1 and R2)

1. **Schema fingerprint** identical to the source (tables, columns, constraints, indexes, triggers, functions, roles, grants).
2. **Security posture preserved:** RLS enabled and forced on the same tables; policy inventory hash equal; role attributes and grants equal (a restore that loses policies would otherwise *silently expose everything*).
3. **Data fidelity:** per-table row counts and content checksums equal to the source.
4. **Integrity:** all foreign keys validate; sequences/counters ≥ max used numbers (order and bill counters, no duplicate numbers after restore).
5. **Billing ledger verification** (§6): hash chain verifies end to end and the chain head equals the externally anchored value.
6. **Isolation harness re-run against the restored database** (guard + matrix). A restore that passes data checks but breaks tenant isolation fails the drill.
7. **Auth continuity:** auth users restored; a test login path works (R2).
8. **Storage:** menu-image bucket sync verified by object count and hash sample (R2).
9. **Timing:** total restore time and time-to-verified recorded.

### 4.3 Negative tests (must fail loudly)

Wrong decryption key; corrupted/truncated dump; dump encrypted to the wrong recipient; restore into a database missing the DineFlow roles (must fail, not silently create weaker defaults); restore with a modified row (checksum mismatch detected); modified billing ledger row (chain verification fails).

### 4.4 Policies that make backups trustworthy

- Backup files are **never** considered valid until the restore check passes; the workflow only rotates old dumps out after the newest one has been verified by the automated R1-style check (decrypt + `pg_restore --list` + checksum), and R2 verifies the real thing.
- The `age` private key is stored offline with **two custodians**; the public key lives in CI. The custody test (R3) is on the calendar.
- Backups contain password hashes and PII, so the restore drill environment is deleted after use and never left running.

**Scope built now:** R1 (local, runnable today) is implemented and executed in this stage's harness work. R2 and R3 need your accounts and are delivered as scripts and runbooks in module 18; they will be reported as *not run* until you run them.

---

## 5. QR security (Condition 4)

### 5.1 Weakness found

D-10 stored QR tokens in the database in recoverable form. Anyone reading the table (a leaked backup, a support-grant misuse, a SQL bug) could place orders at every table of a restaurant. It also let arbitrary garbage tokens reach the database.

### 5.2 Revised design (replaces D-10 and NFR-S13 clarification PRD-CHG-02)

**Signed, revocable tokens with two independent secrets.**

```
token   = base64url( kid (1 byte) || qr_id (16 random bytes) || mac (16 bytes) )        → 44 characters
mac     = first 16 bytes of HMAC-SHA256( QR_KEY[kid], "dineflow-qr-v1" || qr_id )
QR URL  = {APP_BASE_URL}/t/{token}
```

- The database stores only **`qr_id`** (random UUID), `key_id`, `table_id`, `restaurant_id`, `created_at`, `revoked_at`. **It never stores the token or the MAC.** The token is *re-computed* from `qr_id` and the server key whenever an Owner/Manager views or prints the QR.
- **Verification order:** length/charset check → constant-time MAC check with the key for `kid` → **only then** a database lookup of `qr_id`. Forged, malformed or random tokens are rejected in memory and never reach the database (cheap protection against enumeration and load).
- **Two independent secrets:** stealing the database gives `qr_ids` but no valid MACs; stealing the server key gives the ability to compute MACs but no valid `qr_id`s. An attacker needs both.
- The token contains **no** restaurant ID, table number, or timestamp; it reveals nothing if photographed beyond "an opaque link".
- **Revocation:** rotating a table's QR sets `revoked_at` and creates a new `qr_id`; the old token stops working immediately. "Revoke all QR codes for this restaurant" is a single guarded action (incident response).
- **Key rotation:** `QR_TOKEN_KEYS` holds several `kid → secret` pairs. New tokens use the newest `kid`; old `kid`s remain valid until deliberately retired. Retiring a `kid` invalidates all tokens signed with it (used only for suspected key compromise; requires reprinting).
- **Resolver:** `app.resolve_table_qr(qr_id)` (`SECURITY DEFINER`, executable only by the API's public-tx path) returns `(restaurant_id, table_id)` if the token is live, the table is active and the restaurant is `active`. Unknown, revoked, inactive and suspended all yield the **same** generic 404 with equal timing characteristics.
- **Customer order-status links** (`orders.public_token`): random 128-bit token given to the customer once; the database stores only its **SHA-256 hash** (`public_token_hash`). No recovery is needed (the customer's device remembers the link).

### 5.3 Handling around the token

| Concern | Control |
|---|---|
| Token in URLs / logs | Server logs record the **route pattern** (`/public/tables/:token/…`), never the concrete path; log redaction tests. `Referrer-Policy: no-referrer` on the SPA; no third-party resource is requested with the token in its URL. |
| Photographed or shared QR | Rotation, rate limits, Turnstile, staff acceptance (Part 3 T-20). Optional table code remains the next lever (D-16). |
| Printing before the domain is final | `QR_DOMAIN_FINAL` gate and watermark (Q-04 assumption). |
| Print quality | QR generated with high error-correction level; printed sheet includes a human-readable short URL fallback that **cannot** be used to order (it lands on the restaurant page and requires scanning the table QR). |
| QR tampering on premises (sticker overlay) | Guidance in the user guide; each table's QR page shows the table label to the customer so a mismatched sticker is noticeable; rotation available. |

### 5.4 Tests (added to Part 4)

Forged MAC; valid MAC for a revoked `qr_id`; `qr_id` from another restaurant with a tampered MAC; wrong `kid`; truncated/oversized/non-base64 tokens (no DB access, asserted via query counter); replay after rotation; timing-equivalence between "invalid" and "revoked" (statistical tolerance test); log-redaction test; DB-dump-only test (a `qr_id` without the key cannot construct a working token); order-status token hash-only storage test.

---

## 6. Billing auditability (Condition 5)

### 6.1 Weakness found

Immutable finalized bills and an audit log protect against application bugs and ordinary misuse. They do **not** let you *prove* to an accountant, a customer or a tax officer that no one edited the database directly (for example with migration-owner credentials), and the plan did not cover reprints or reconciliation.

### 6.2 Additions

1. **`bill_ledger` — an append-only, hash-chained event log.** Every billing event is a row: `bill_created`, `discount_applied`, `bill_finalized`, `payment_recorded`, `payment_reversed`, `bill_voided`, `pdf_generated`, `bill_printed`. Fields: `restaurant_id`, `seq` (gap-free per restaurant), `bill_id`, `event_type`, `actor_user_id`, `actor_role`, `payload jsonb` (amounts, reasons, before/after), `occurred_at` (database clock), `prev_hash`, `row_hash = SHA-256(prev_hash || canonical(row))`. Rows are written by database triggers on the billing tables (so no code path can skip them), serialised per restaurant by the counter row lock.
2. **Bill content hash.** At finalization the bill stores `content_hash = SHA-256(canonical JSON of the full snapshot: issuer, lines, taxes, totals, orders, number)`. The hash and the bill reference are printed in the PDF/print footer (short form) so a paper or PDF copy can be checked against the system.
3. **Tamper-evidence, not just tamper-resistance.** A verifier (`scripts/verify-billing-ledger`) recomputes every chain and every `content_hash`. The **chain head** (`seq`, `row_hash`) per restaurant is **anchored externally** by the 6-hourly backup job (written to the off-site bucket log) and optionally emailed to the Owner in a weekly digest. Editing history in the database therefore breaks the chain *or* mismatches an anchor made earlier. The verifier runs nightly on staging/production, after every restore drill, and on demand for disputes.
4. **Reprints and copies.** Reprinting or re-downloading a finalized bill produces a document marked **"DUPLICATE COPY — reprinted <time> by <user>"** (the first issued copy is the original) and writes a ledger event. This limits "print a second bill and pocket the cash" patterns and makes them visible.
5. **Void semantics.** A voided bill is never hidden: it stays in lists with a VOID marker, keeps its number, and the void event records who, when and why (a reason is mandatory). Voiding a paid bill requires reversing the payment first, which is its own event.
6. **Reconciliation report.** Daily report per restaurant: bills issued (count, first/last number, **gap check**), voids, discounts (count/amount, by user), payments by method, reversals, and difference between "finalized totals" and "payments recorded". Numbers derive from the ledger, and each row links to its events.
7. **Exception views for the Owner:** voids, reversals, discounts above a threshold, reprints, bills finalized then voided within N minutes, users with unusually high discount rates.
8. **Failed-attempt visibility.** Blocked attempts to change finalized bills (trigger exceptions) are logged by the API layer into `audit_log` (a rolled-back transaction cannot log inside itself).
9. **Time source.** All billing timestamps use the database clock, never client input.
10. **Retention.** Ledger and bills follow the financial retention period (Part 6); they are exported with the tenant data and re-verifiable from the export (the export includes hashes and a verification script).

### 6.3 Honest limits

Hash chaining and external anchoring make undetected tampering hard, not impossible: an attacker with migration-owner credentials *and* access to the off-site anchors *and* the ability to rewrite them could forge history. Cash taken and never entered into the system cannot be detected by software. Neither claim is made in marketing material. The legal weight of these records in a given jurisdiction is a question for the restaurant's accountant/lawyer (⚖).

### 6.4 Tests (added to Part 4)

Chain verifies after normal operation; modifying any ledger row, payload or `bill_orders` link breaks verification; deleting a row breaks the sequence; reordering fails; anchor mismatch detected; concurrent finalizations keep the chain consistent (no forks); restore preserves the chain; duplicate-copy marking; reconciliation totals equal ledger totals under random operations (property test).

---

## 7. Licensing points (Condition 6)

Part 6 remains the framework. This section (a) fixes **provisional defaults** so the technical and commercial models agree, and (b) adds points the technical design exposed. **Every number below is a placeholder for you and your lawyer to change.** ⚖ = lawyer review required.

### 7.1 Provisional defaults

| Term | Provisional default |
|---|---|
| Model | A: perpetual right to use the hosted service; hosting included for a term; renewable (Q-14 assumption) |
| Hosting included | **24 months** from go-live |
| Support included | 24 months (email/WhatsApp, business hours, next-business-day target, best effort) |
| Uptime commitment | **None** promised (internal target 99.5 %) |
| Updates | Fixes, security patches and minor updates during the term; major versions optional and paid |
| Renewal | Annual hosting+support fee, price stated in the order form, cap on annual increases ⚖ |
| Data export | Anytime; free once per year |
| After termination | Export window 30 days; live data deleted after **90 days**; **backups expire within 180 days** (see 7.2) |
| Customisations | Paid, quoted; delivered inside the shared codebase behind flags |
| Source escrow | Not offered initially |
| Pilot | Written pilot agreement before wide rollout |

### 7.2 Points the technical design forces into the contract

1. **Deletion versus backups.** Our backup schedule keeps dumps for up to 6 months, so "we delete your data 90 days after termination" would be untrue unless the contract says live data is deleted at 90 days and **residual copies in encrypted backups expire within a stated maximum (180 days)** and are not restored except for disaster recovery. Alternative: crypto-shredding per tenant (more engineering). ⚖ (data-protection wording).
2. **QR continuity.** Printed QR codes depend on **your domain and your service**. The contract must state who owns the domain (you), how long you commit to keep it, and what happens if the service ends (codes stop working; a redirect/hand-over notice period). ⚖
3. **Financial records.** The platform is not the restaurant's system of record. The tamper-evident ledger helps them, but the restaurant must keep its own exports for statutory periods. Supply the verification tool with exports. ⚖
4. **Billing responsibility.** The restaurant is responsible for tax configuration and invoice content; the ledger, hashes and "duplicate copy" marks are evidence tools, not certification. No claim of legal compliance or fiscal approval. ⚖
5. **Support access.** Platform-admin access to tenant data is read-only, reasoned, time-limited, visible to the Owner (FR-123). The DPA should say so. ⚖
6. **Sub-processors and location.** Supabase, API host, Cloudflare, email, error tracking, backup storage; region disclosure. ⚖
7. **Security responsibilities.** Restaurant must protect staff credentials, use unique staff logins, and enable MFA where offered; shared logins void some audit guarantees. ⚖
8. **Fair use.** Defined limits (orders/day, image storage) so a single tenant cannot exceed the hosting budget (Q-03).
9. **Limitation of liability** for outages, lost orders and tax consequences; no uptime guarantee (see defaults). ⚖

### 7.3 Lawyer briefing pack (I will prepare on request)

Order form and terms; DPA; privacy-notice template; support/hosting policy; offboarding schedule (including backup expiry); acceptable-use and suspension; pilot agreement. Part 6 §4 lists these.

---

## 8. Effect on earlier documents

| Document | Change made |
|---|---|
| Part 0 | D-10 superseded by §5; new D-19 (own DB roles, Data API disabled), D-20 (billing ledger), D-21 (automated restore verification), D-22 (DB tests in TypeScript); PRD-CHG-02 replaced. |
| Part 1 | Roles renamed (`dineflow_staff`, `dineflow_public`); QR table columns changed; `orders.public_token_hash`; `bill_ledger` and `content_hash` added. |
| Part 2 | Roles and membership lookup (F-3); QR verification flow. |
| Part 3 | T-20/T-02 references; new threats T-58 (direct Data API use with own token), T-59 (history rewrite by privileged insider). |
| Part 4 | DB tests in TypeScript; new sections for ISO, restore drill and ledger tests. |
| Part 6 | Provisional defaults and points from §7. |
