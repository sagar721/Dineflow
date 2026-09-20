# DineFlow — Technical Design, Part 4: Test Strategy

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for approval) |
| **Principle** | A test counts only when it has actually been executed and its result recorded. Reports will state what ran, what passed, what failed, and what could not be run (with instructions to run it locally). |

---

## 1. Test pyramid and tooling

| Layer | Tool | What it proves | Runs |
|---|---|---|---|
| **Unit** | Vitest | Pure logic: money and rounding, tax calculation (inclusive/exclusive), discount caps, order state machine, permission matrix, token/idempotency helpers, CSV escaping, redaction | Every commit (seconds) |
| **Database** | **Vitest + `pg`** against a disposable Postgres (Docker), using the API's own transaction wrappers (D-22) | RLS per table × role, immutability triggers, constraints, composite FK rejection, counters, status-transition rules, retention/purge function | Every PR |
| **Concurrency** | Vitest + `pg` pool / API with parallel requests | Idempotent orders under race, gap-free numbering, double finalize/pay, simultaneous status updates | Every PR |
| **API integration** | Vitest + Supertest against the real Express app and the local Supabase stack (real DB, real RLS, real Auth) | Full request paths incl. cookies, CSRF, validation, RBAC, isolation matrix, uploads | Every PR |
| **E2E / UI** | Playwright (Chromium, WebKit, Firefox; mobile viewport for customer flows) | User journeys J1–J6; print and PDF; kitchen alert flow; cookie/`localStorage` inspection | Every PR (smoke subset), nightly (full) |
| **Accessibility** | axe-core inside Playwright + manual keyboard and screen-reader spot checks | WCAG 2.1 AA violations detectable automatically; manual review of the rest | Every PR (automated), each release (manual) |
| **Security** | Semgrep, gitleaks, `pnpm audit`, OWASP ZAP baseline (staging), custom negative suites | Static findings, secrets, dependency CVEs, dynamic baseline | Every PR / nightly / pre-release |
| **Performance** | k6 against staging | NFR-P01…P07 | Pre-release and after significant changes |
| **Recovery** | `scripts/restore-drill` — dump → encrypt → restore → verify schema, security posture, checksums, integrity, ledger and isolation (Part 7 §4) | Backups are restorable *and still safe* within RTO | Every PR touching migrations (local round trip), weekly; production-shaped drill before go-live then monthly |
| **Isolation harness** | Guard + generated matrix + **sabotage canaries** (Part 7 §2) | Tenant isolation holds, and the harness itself still detects breakage | Every PR |

Security-sensitive tests are run **only against local or staging environments that we own**, never against production or third-party services.

## 2. Test environments and data

- **Local/CI:** ephemeral Supabase stack (Docker) reset per test suite; deterministic seed factories create **two or more restaurants** with data in every table so that isolation assertions are always meaningful.
- **Staging:** synthetic data only; same schema and migrations as production, applied by CI.
- **Demo data** is labelled `[DEMO]` in the UI and cannot be created in production (seed script refuses to run against a production URL).
- Time is injectable (fake clock) for midnight-boundary, retention and expiry tests. Only the server clock is authoritative.

## 3. Test areas mapped to the PRD

### 3.1 Functional

| Area | Key cases (illustrative; the full matrix is built module by module) |
|---|---|
| Onboarding | Invite → accept → wizard → activate; invalid/expired/reused invite; incomplete wizard cannot activate |
| Tables/QR | Create/edit/duplicate label (case-insensitive); archive vs delete with history; rotate QR (old invalid, new valid); print sheet renders every table; QR for inactive table/suspended restaurant |
| Menu | CRUD; price bounds; availability toggle propagates within 30 s; hidden vs sold-out display; archive keeps history readable |
| Customer ordering | Scan → menu → cart → contact policy variants → order; cart persistence and clearing; item became unavailable; accepting-orders off; quantity limits |
| Order workflow | Every legal and illegal transition × role; cancellation reason; revert; history rows; live polling shows new order ≤ 5 s; "reconnecting" state |
| Billing | Bill from one and multiple orders; inclusive/exclusive tax; multiple tax components; discount percent/fixed; rounding modes; finalize, print, PDF; void; payment; reversal; cancelled orders excluded |
| Roles/staff | Each cell of the permission matrix; escalation attempts; last-owner rule; deactivation immediate |
| Dashboard | Counts and sales definitions; timezone midnight boundary; exclusion of cancelled/void |
| Export/offboarding | Export contains only the tenant's data; audit entry; signed URL expiry |

### 3.2 Security (mapped to the threat register T-xx)

- **Isolation matrix:** generated for every route × role × foreign object type (from the endpoint registry and permission matrix) asserting 403/404 and absence of foreign data; plus response-body scans for the second tenant's known marker strings.
- **RLS:** database tests for every tenant table, generated from the declared matrix (Part 7 §2): select/insert/update/delete as owner-of-A, staff-of-A per role, owner-of-B, public, platform admin with/without grant, deactivated user, suspended restaurant; attempts to update `restaurant_id`.
- **Injection:** payload corpora (SQLi, XSS, template, path traversal, header/CRLF, unicode/control characters, oversize) applied to every string field in the API schema registry.
- **Order and price tampering:** modified price, total, quantity (0, −1, 1e9, fractional), duplicate lines, foreign menu-item ID, archived item, extra properties, wrong types.
- **Authentication:** lockout and back-off, timing-equivalent responses for known/unknown accounts, refresh reuse, expired/forged tokens, logout invalidation, deactivated user, MFA enforcement for platform admin.
- **CSRF/CORS:** cross-origin and header-less state-changing requests rejected; CORS preflight limited to the allow-list.
- **Rate limits:** each route class hits its limit and recovers; limit keys cannot be bypassed via header spoofing.
- **Uploads:** polyglots, SVG, wrong magic bytes, oversized files and dimensions, decompression bombs, path-like filenames.
- **Headers/config:** security-header assertions, no stack traces, config validation refuses to boot on missing variables.
- **Static/dependency/secret:** Semgrep ruleset (including "no raw SQL", "no dangerouslySetInnerHTML"), gitleaks, audit gate (high/critical block).

### 3.3 Data integrity

| Test | Assertion |
|---|---|
| Idempotency | 50 parallel `POST` orders with the same key → exactly 1 order; same key, different body → 409 |
| Concurrent orders | 200 parallel orders across 2 restaurants → order numbers unique and contiguous per restaurant |
| Totals | Property-based tests (fast-check) over random carts/tax/discount/rounding: `total = subtotal − discount + service + tax (+ rounding)`, never negative, identical across screen/print/PDF |
| Transaction rollback | Inject failure after order insert (before commit) → no order, no items, counter unchanged |
| Bill immutability | As every role, attempt `UPDATE`/`DELETE` on every finalized bill column, line, tax, link; only `finalized → void` succeeds and only for permitted roles |
| Numbering | 100 parallel finalizations → contiguous bill numbers with no duplicates; rollback returns the number |
| Payments | Double payment blocked; void with live payment blocked; reversal then void allowed |
| Snapshots | Change item price/name and tax rates after finalization → bill PDF byte-for-byte amounts unchanged |
| Cross-tenant FK | Direct SQL insert of an order item pointing at another tenant's menu item → rejected |

### 3.4 Performance (targets from NFR-P; run on staging sized like production)

| Scenario | Load | Pass criteria |
|---|---|---|
| Public menu | 1,000 concurrent virtual users, 10 restaurants | p95 API ≤ 300 ms; error rate < 0.1 %; SPA LCP ≤ 2.5 s on throttled mid-range mobile profile (Lighthouse CI) |
| Order placement | 10 orders/min/restaurant sustained plus 3× burst | p95 ≤ 2 s end to end; no duplicates; DB CPU headroom recorded |
| Staff polling | 30 devices polling every 3 s | p95 ≤ 100 ms per poll; new order visible ≤ 5 s |
| Dashboard/reports | Restaurant with 50k historical orders | p95 ≤ 500 ms with indexes; `EXPLAIN` reviewed |
| PDF | 30 concurrent generations | ≤ 3 s each; API memory stays within limit |
| Soak | 2 h at normal load | No memory growth trend; connection pool stable |
| Failure injection | Kill API, drop DB connection, block Turnstile | Behaviour matches Part 0 §6.2 |

### 3.5 Regression

- Full unit + DB + API + smoke E2E suite on every PR; full E2E + accessibility + ZAP nightly against staging.
- Every fixed bug gets a failing test first, permanently retained.
- Before each module is signed off, the entire earlier suite must be green (PRD: "do not move on if critical tests fail").

## 4. Quality gates

| Gate | Requirements |
|---|---|
| **PR merge** | Lint + typecheck (strict) + unit + DB + API + smoke E2E + gitleaks + audit (no high/critical) all green; new tables have RLS + tests; coverage on shared `money`, `permissions`, state-machine modules ≥ 95 % lines/branches (other packages tracked, not gated by a vanity number) |
| **Module sign-off** | Module acceptance criteria met; security and isolation tests for the module pass; tests documented; known limitations listed |
| **Staging release** | Everything above + full E2E + accessibility + ZAP baseline with no medium+ findings unaddressed |
| **Production release** | Load test results within targets, restore drill within RTO, security checklist complete, MFA verified on all provider accounts, rollback rehearsed, open-bug list with no critical/high items |

## 5. Deliverables of the release-readiness stage

Test summary (counts, results, dates), open bug list with severities, security checklist with evidence, restore-drill record, load-test report, deployment and rollback rehearsal record, accessibility report, and a production-readiness assessment. Anything not executed is listed as **not run**.

## 6. Traceability

`docs/traceability.md` maps every FR/NFR/BR/US ID to its design element and test IDs (e.g., `T-ORD-IDEMP-01`). A CI script fails if a *Must* requirement has no mapped test, so gaps are visible rather than discovered later.

## 7. Where tests live

```
packages/shared/src/**/*.test.ts     # unit tests next to the code
apps/api/test/integration/           # API + isolation matrix + security negatives
apps/api/test/concurrency/           # race and integrity tests
packages/db/test/                    # schema guards, RLS matrix, sabotage canaries, restore drill
apps/web/src/**/*.test.tsx           # component tests (Testing Library)
e2e/                                 # Playwright journeys + axe
load/                                # k6 scenarios
scripts/restore-drill/               # restore + integrity verification
```

## 8. What I cannot run and how you would

Some checks need your accounts or real devices: production-like load tests (need the staging project), the restore drill against real backups, real-device iOS Safari audio/print behaviour, real thermal printers, and email deliverability (SPF/DKIM). For each I will provide a step-by-step script or checklist and ask you to report results; I will not mark them as passed on your behalf.
