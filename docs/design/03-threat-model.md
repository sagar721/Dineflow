# DineFlow — Technical Design, Part 3: Threat Model

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for approval) |
| **Method** | Asset and trust-boundary analysis, then a threat register that maps every PRD §6 category to risk → mitigation → test → remaining limitation. |
| **Important** | This model lists controls and how each will be verified. It does not claim DineFlow is "secure" or "bug-free". Verification results are reported only after tests actually run. |

---

## 1. Assets (what we protect), by value

| Asset | Why it matters |
|---|---|
| Tenant isolation | One leak between restaurants destroys trust and may create legal exposure. |
| Financial records (bills, payments, order history) | Legal/accounting evidence; tampering enables fraud. |
| Staff credentials and sessions | Gateway to everything else. |
| Customer contact details (phone, email) | Personal data with privacy obligations. |
| Availability of ordering during service hours | Revenue for the restaurant. |
| Platform admin access and service secrets | Compromise = access to every tenant. |
| Backups | Contain the entire dataset including the auth user table. |

## 2. Actors

| Actor | Assumed capability |
|---|---|
| Anonymous internet user / bot | Can call all public endpoints at will, scrape, flood, fuzz. |
| Malicious customer | Has a real QR; can tamper with requests (prices, IDs, quantities), replay, race. |
| Remote prankster | Has a photo of a QR; not at the table. |
| Malicious or careless staff | Valid session with a limited role; may try to exceed the role or hide misconduct. |
| Malicious restaurant (tenant) | Valid Owner; tries to reach another tenant's data. |
| Compromised staff device or stolen session | Attacker holds a valid cookie until revoked. |
| Supply-chain attacker | Malicious dependency or compromised CI secret. |
| Insider (you / future contractor) | Could misuse platform admin or database access. |

## 3. Trust boundaries

1. Internet ↔ Cloudflare/SPA host (untrusted input).
2. Browser ↔ API (**primary boundary**: everything from the browser is untrusted, including role claims, IDs, prices, totals).
3. API ↔ Database/Auth/Storage (API is trusted but constrained by RLS and limited roles).
4. CI/CD ↔ production (deploy secrets, migration role).
5. Backups ↔ off-site storage.

## 4. Threat register

Legend for **Test**: U = unit · DB = database tests (Vitest + `pg`, Part 7 §2) · I = API integration · E2E = Playwright · S = security tooling · L = load. Test IDs are assigned in Part 4 and tracked in the traceability matrix.

### 4.1 Access control and tenancy

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-01 | **Broken access control**: role checks missing or wrong on a route | Privilege misuse, data exposure | Central permission matrix; route without declaration fails CI; server-side role lookup per request; DB-level RLS/triggers for sensitive actions | Generated allow/deny test for every route × role (I); DB role tests (DB) | Matrix correctness depends on the PRD's role definitions; a wrong business decision would be enforced perfectly. |
| T-02 | **Cross-tenant access** (Owner of A reads/writes B) | Critical | 5-layer isolation (Part 2 §5): server-derived tenant, tenant-scoped repositories, forced RLS, composite FKs, namespaced storage | Isolation matrix over every route × role × object type (I); RLS tests per table incl. attempts to change `restaurant_id` (DB) | RLS does not stop arbitrary SQL execution (see T-05). Support grants are a deliberate, audited, read-only exception. |
| T-03 | **IDOR** via guessable/enumerable IDs | High | UUIDs; wrong-tenant lookups return 404; public tokens are 128-bit random; identical responses for unknown vs revoked tokens | I (foreign UUID probes), S (fuzz) | UUIDs are not secrets; protection comes from authorization, not obscurity. |
| T-04 | **Privilege escalation** (Manager creates Owner, edits own role, revives deactivated user) | High | Role changes only via guarded endpoint; rank rules; last-owner trigger; role read from DB not token | I + DB negative tests for each escalation path | A compromised Owner account has full tenant power by design. |
| T-05 | **SQL injection** | Critical | Kysely/parameterised queries only; lint rule bans raw SQL strings; least-privilege DB roles; RLS limits blast radius of a mistaken filter (not of arbitrary SQL) | S (sqlmap-style/fuzz cases on every string parameter in staging), Semgrep rules, I (payloads such as `' OR 1=1--`) | No layer fully contains arbitrary SQL execution; prevention is the control. |
| T-06 | **Platform admin compromise / insider misuse** | Critical | MFA (aal2) mandatory; no default tenant-data access; support grants time-limited, reason-recorded, visible to Owner; all admin actions audited; separate break-glass DB access held offline | I (SA without grant cannot read tenant rows; grant expires), DB | A determined insider with database credentials can bypass the application. Mitigate by limiting who holds credentials and reviewing access; residual risk accepted for a solo operator. |

### 4.2 Authentication and sessions

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-10 | **Credential stuffing / brute force** | High | Provider-hashed passwords; per-account + IP limits with back-off; generic errors; breached-password check; MFA available (mandatory for SA) | I (lockout, timing-equivalent responses), L (limit behaviour) | Distributed attacks can evade IP limits; per-account back-off and Cloudflare rules help; Owners without MFA remain exposed to phished passwords. |
| T-11 | **Session/token theft (XSS, malware)** | High | HttpOnly host-only cookies; short access-token life; refresh rotation with reuse detection; strict CSP; no browser-side provider keys | S (CSP scan), E2E (JS cannot read cookies), I (revoked/reused refresh rejected) | Malware on a staff device can act as the user until the session is revoked. |
| T-12 | **Session fixation / misuse after deactivation** | Medium | New session on login; membership checked every request; provider session revoked on deactivation | I | — |
| T-13 | **CSRF** | Medium | SameSite=Lax + custom header + Origin/Sec-Fetch-Site check + JSON-only | I (cross-origin and header-less requests rejected), E2E | Relies on modern browsers honouring SameSite and CORS. |
| T-14 | **Account enumeration** (login, reset, invite) | Medium | Uniform responses and comparable timing; rate limits | I | Sign-up-by-invite reveals nothing but timing side-channels are hard to eliminate fully. |
| T-15 | **Invite/reset link abuse** | Medium | Random 256-bit tokens, hashed at rest, single use, short expiry, token in URL fragment | I (expired, reused, tampered) | Anyone with access to the recipient's mailbox can accept. |

### 4.3 Customer-facing abuse

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-20 | **Malicious QR use / remote prank orders** | High | 128-bit revocable tokens; rate limits per token/IP/restaurant; Turnstile; staff acceptance before food is made; "accepting orders" switch; rotation | I (limits), L, manual abuse drill in pilot | A person physically at the venue can still place prank orders; a determined attacker with many IPs and solved challenges can pass. The optional table code (D-16) is the next lever. |
| T-21 | **Order tampering / price manipulation** | High | Server computes all prices from DB; client price fields are not accepted (`.strict()` rejects); availability revalidated; composite FKs | I (tampered price, negative/huge quantity, other tenant's item ID, unavailable item, extra fields) | — |
| T-22 | **Duplicate submissions / races** | High | Idempotency key + unique constraint; single transaction; request-hash mismatch → 409 | I (double-submit), concurrency test (50 parallel identical requests → exactly 1 order) | A customer deliberately submitting *different* identical-looking orders creates separate orders (acceptable). |
| T-23 | **Flooding / API abuse / scraping** | Medium | Rate limits by class; Cloudflare WAF; menu caching; request size limits | L, I | Public menu is public by definition; scraping cannot be fully prevented. |
| T-24 | **Malicious content in customer input** (XSS payloads in instructions/names) | High | Plain-text rendering, output encoding, length limits, CSP; PDF/CSV escaping | E2E and I with payload corpus; S (ZAP) | New rendering contexts (e.g., emails) must be reviewed when added. |

### 4.4 Injection, data exposure and files

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-30 | **XSS (stored/reflected/DOM)** | High | React escaping; no `dangerouslySetInnerHTML`; CSP; sanitise/encode restaurant-supplied fields | E2E payload suite; ESLint rule; ZAP | Third-party scripts (Turnstile) are trusted. |
| T-31 | **Sensitive data exposure** (PII, secrets, stack traces) | High | Contact data in isolated table with narrow RLS; Kitchen cannot read it; log redaction; generic 5xx bodies; Sentry scrubbing; private export bucket | I (Kitchen reads order → no contact fields), unit tests on log redaction, secret scanning (gitleaks) | PII shown to permitted staff can still be photographed or copied. |
| T-32 | **Insecure file upload** | Medium | Size limit, content sniffing, decode + re-encode, metadata strip, random names, tenant prefix, no user-controlled paths, images served from a separate storage origin | I (polyglot, SVG, oversize, zip bomb, renamed executable) | Novel image-library vulnerabilities; mitigated by dependency updates and pixel limits. |
| T-33 | **CSV/PDF injection** | Low–Med | Formula prefixing in CSV; PDF built from text primitives | Unit tests | — |
| T-34 | **Open redirect / URL injection** in emails and QR URLs | Low | Base URLs come from configuration only | I | — |

### 4.5 Integrity and financial fraud

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-40 | **Tampering with finalized bills / payments** | Critical | DB triggers + revoked privileges; void-and-reissue path; append-only payments; audit trail | DB (UPDATE/DELETE attempts as every role → rejected), I | Someone with migration-owner credentials can alter data; audit and backups detect but do not prevent this. |
| T-41 | **Staff fraud** (excess discounts, void-and-pocket) | Medium | Discount cap and mandatory reasons; voids visible on reports and audit log; payment reversal audited; Owner review screen | I, manual review checklist | Collusion and cash handling outside the system cannot be prevented by software. |
| T-42 | **Race conditions** (double finalize, double payment, concurrent status changes) | High | Row locks, `version` checks, unique partial indexes, idempotent endpoints | Concurrency tests in DB and API layers | — |
| T-43 | **Bill number gaps or duplicates** | High | Counter row lock in the finalizing transaction; unique index | Concurrent finalize test (100 parallel) asserts contiguous numbers | — |
| T-44 | **Audit log tampering** | High | Append-only via revoked privileges + trigger; audit row in the same transaction as the action | DB tests | Migration-owner access, as above. |

### 4.6 Platform, supply chain and operations

| ID | Threat | Risk | Mitigation | Test | Remaining limitation |
|---|---|---|---|---|---|
| T-50 | **Dependency vulnerabilities / malicious packages** | High | Lockfile; `pnpm audit` and Dependabot/Renovate; CI blocks on high/critical; minimal dependencies; `--ignore-scripts` for CI installs where feasible; review of new dependencies | S | Zero-day vulnerabilities in dependencies. |
| T-51 | **CI/CD or secret compromise** | Critical | Secrets only in platform stores; separate per-environment secrets; least-privilege deploy tokens; protected production environment with manual approval; gitleaks pre-commit and CI; 2FA on all provider accounts | S, config review checklist | GitHub/Render/Supabase/Cloudflare account takeover; all accounts need MFA and a recovery plan. |
| T-52 | **Server misconfiguration** (CORS, headers, debug, open buckets) | Medium–High | Startup config validation; Helmet; strict CORS; production checks in a security checklist; ZAP baseline on staging | S, I (header assertions), checklist | Provider-side misconfiguration in dashboards is human-error prone → checklist and periodic review. |
| T-53 | **Database backup exposure** | High | Dumps encrypted with `age` before upload; private bucket; key held offline; restore drill uses scratch project and deletes afterwards | Restore drill; verify the artifact is unreadable without the key | Loss of the private key = unrecoverable backups (hence two custodians). |
| T-54 | **Denial of service** (volumetric, expensive endpoints) | Medium | Cloudflare edge, rate limits, request size caps, PDF/upload quotas, timeouts, DB statement timeout, connection-pool limits | L (burst tests), I | A large volumetric attack on a small always-on instance can still cause downtime; Cloudflare's free tier limits impact, not eliminates it. |
| T-55 | **Malicious tenant staff uploading illegal/abusive content** | Low–Med | Contractual acceptable-use terms (Part 6); audit trail; suspension capability | — | Content moderation is out of scope for v1. |
| T-58 | **Staff uses their own access token directly against Supabase's Data API**, bypassing our validation, permission matrix and audit log | High | DineFlow tables grant nothing to `anon`/`authenticated`/`service_role`; requests run as our own roles; Data API, GraphQL and Realtime disabled; grant-snapshot test; live drift check on staging/production | DB (grant snapshot), operational check (`scripts/check-rls-live.ts`) | If Supabase changes defaults for new tables, the snapshot test is what catches it — hence it runs on every PR. |
| T-59 | **History rewrite by a privileged insider or a stolen migration credential** (edit finalized bills or the audit trail directly in SQL) | High | Hash-chained `bill_ledger` with externally anchored heads, bill `content_hash` on printed/PDF copies, nightly verification, restore-drill verification (Part 7 §6) | Ledger tamper tests, anchor-mismatch test | **Detective, not preventive.** An attacker controlling both the database and the off-site anchors over time could still forge history; cash never entered into the system is invisible to any of this. |
| T-56 | **Outage of a third-party service** (Turnstile, email, Supabase) | Medium | Degrade gracefully (D-13); health checks; runbooks | Failure-injection tests on staging | Supabase outage stops the product; export/restore path reduces recovery time. |
| T-57 | **Timezone/clock manipulation** (client time used for "today" or ordering) | Low | Server time only; restaurant timezone for boundaries | Unit tests around midnight and DST-free IST offset | — |

## 5. Security decisions in the required four-part form

**Decision: tokens in HttpOnly cookies via the API (D-04)**
1. *Risk:* XSS or a malicious extension steals tokens from `localStorage` and impersonates staff.
2. *Mitigation:* tokens never reach JavaScript; strict CSP; short access-token lifetime; refresh rotation with reuse detection.
3. *Test:* E2E asserts `document.cookie` lacks tokens and `localStorage` contains none; integration tests for rotation and revocation; CSP scan.
4. *Limits:* CSRF becomes relevant (handled by T-13 controls); a compromised device still allows misuse until revocation.

**Decision: RLS applied to API queries (D-03)**
1. *Risk:* an application bug omits a tenant filter or trusts an ID and leaks data.
2. *Mitigation:* the API runs each request under a restricted role with forced RLS; composite FKs.
3. *Test:* pgTAP per table and role; API isolation matrix.
4. *Limits:* not a defence against arbitrary SQL execution; policies themselves need review.

**Decision: capability tokens for customers instead of accounts**
1. *Risk:* leaked or photographed QR tokens allow order placement.
2. *Mitigation:* narrow capability (menu and order at one table), rotation, rate limits, Turnstile, staff acceptance.
3. *Test:* abuse simulations, rotation test, revoked-token behaviour.
4. *Limits:* physical presence cannot be proven without a table code (D-16) or geofencing (rejected: unreliable and privacy-invasive).

**Decision: DB-enforced immutability of finalized bills (D-11)**
1. *Risk:* bug, staff misuse or a future feature alters finalized amounts.
2. *Mitigation:* triggers plus revoked `UPDATE/DELETE`; void-and-reissue only.
3. *Test:* attempts to update/delete every column as every role; snapshot equality of PDF before/after menu edits.
4. *Limits:* migration-owner access; mitigated by audit and off-site backups.

**Decision: encrypted off-site backups (D-14)**
1. *Risk:* backup theft exposes all tenants; backup failure loses data.
2. *Mitigation:* `age` encryption before upload, private storage, offline key with two custodians, restore drills.
3. *Test:* restore drill with integrity script; attempt to read dump without key.
4. *Limits:* key loss; human process failure — hence the drill schedule.

## 6. Security review gates

- **Per module:** the module's negative and isolation tests pass before it is declared done; a checklist item "new tables have RLS + tests" is mandatory in the PR template.
- **Before staging release:** dependency audit, secret scan, ZAP baseline, Semgrep, full isolation matrix.
- **Before production:** the checklist in `docs/SECURITY-CHECKLIST.md` (created in the foundation module), backup restore drill, MFA on all provider accounts, review of provider dashboard settings, external review recommended (an independent penetration test or code review of the auth and RLS layers is worth budgeting before selling widely).
