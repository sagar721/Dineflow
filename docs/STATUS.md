# DineFlow — Project Status Report

| | |
|---|---|
| **Date** | 2026-09-20 |
| **Stages complete** | 1 (PRD), 2 (technical design, conditionally approved), 3 (design system and scaffold) |
| **Awaiting** | Your approval of Stage 3 before module-by-module feature development begins |
| **Verification** | Every result in §4 was produced by a command executed on 2026-09-20 22:57. Nothing is reported as passing that was not run. |

---

## 1. Where the project stands

Three stages are finished. The product is fully specified, the architecture is designed and reviewed against a threat model, and the two things that carry the most risk — tenant isolation and backup recovery — are not just designed but **built, executed and proven to fail when they should**.

No customer-facing feature exists yet. There is no API, no authentication, no menu, no ordering, no billing. That is deliberate: the plan was to establish the foundation and prove isolation before writing features on top of it.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Product Requirements Document | Approved |
| 2 | Architecture, database, API, threat model, test strategy, project plan, licensing framework | Approved with six conditions; all six resolved |
| 3 | Brand, design tokens, component library, app shell, dashboard, living design reference | **Complete, awaiting approval** |
| 4 | 18 feature modules | Not started |
| 5 | Release readiness | Not started |

## 2. What was produced

### 2.1 Documentation (10 files, ~2,460 lines)

| Document | Contents |
|---|---|
| [PRD.md](PRD.md) | 95 functional requirements, 45 non-functional, 23 business rules, 13 user stories with Given/When/Then criteria, 16 risks, 21 open questions |
| [design/00](design/00-architecture-and-decisions.md) | Architecture options compared, 22 numbered decisions with rationale, hosting and cost model, failure scenarios, scaling path |
| [design/01](design/01-database.md) | Full relational schema, ERD, lifecycles, integrity mechanisms, RLS policy matrix, indexes, retention, migration plan |
| [design/02](design/02-api-auth-tenancy.md) | API conventions, middleware order, authentication design, permission model, five-layer tenant isolation, endpoint catalogue, rate limits |
| [design/03](design/03-threat-model.md) | 37 threats, each with risk, mitigation, how it will be tested, and what limitation remains |
| [design/04](design/04-test-strategy.md) | Test pyramid, tooling, coverage per PRD area, quality gates, what I cannot run and how you would |
| [design/05](design/05-project-structure.md) | Folder structure, coding standards, 18-module delivery plan, CI/CD pipeline, documentation map |
| [design/06](design/06-licensing-framework.md) | Licensing models compared, terms to define, pricing inputs, documents a lawyer must draft |
| [design/07](design/07-stage2-conditions.md) | Resolution of your six conditions, plus the assumption register |
| [design/08](design/08-design-system.md) | Design language, tokens, component contract, accessibility contract, screen patterns, verification results |

### 2.2 Database foundation (11 files, ~1,640 lines)

Two SQL migrations, applied and running against PostgreSQL 17: **6 tables, 14 RLS policies, 13 helper functions, 5 triggers.**

- `restaurants`, `restaurant_users`, `platform_admins`, `support_grants`, `audit_log`, `schema_migrations`
- Four database roles. The API's login role owns nothing, holds no table privileges, and cannot bypass RLS.
- Triggers enforcing what code must not be trusted to remember: a restaurant always keeps an active owner, audit rows cannot be changed or deleted, support grants can only be revoked and never re-pointed.
- A migration runner that records checksums and refuses to run a migration that changed after it was applied.

### 2.3 Tenant-isolation harness (the core risk control)

Rather than a list of hand-written tests, this is a declarative matrix plus three layers of self-checking:

| Layer | What it does |
|---|---|
| Discovery | Introspects the catalog. A table added later cannot escape testing by being forgotten. |
| Declaration | Every table × principal × command must have a stated expectation. An *undeclared* combination fails the run, so adding a table or role forces a conscious decision. |
| Probes | 13 principals — including a deactivated user, an owner of a suspended restaurant, a platform admin without MFA, and one with an expired grant — attempt reads, writes, cross-tenant writes, re-parenting and deletes through the same transaction wrappers production will use. |
| Role hygiene | Verifies the test connection itself cannot bypass RLS. A superuser connection would make every other result meaningless while appearing to pass. |
| Canaries | Nine deliberate sabotages (disable RLS, drop a policy, `USING (true)`, grant to `PUBLIC`, `BYPASSRLS`, unreviewed `SECURITY DEFINER`, owner-rights view, table without RLS) that **must** be detected, then repaired. |

### 2.4 Backup and restore drill

A single command performs dump → encrypt (`age`) → decrypt → restore → verify, and checks the restored database for schema, **security posture**, grants, data checksums, referential integrity and tamper detection. A restore that keeps the data but loses the RLS policies fails the drill, because that outcome looks like success while exposing every tenant.

Negative tests included: wrong decryption key, truncated backup, modified row.

### 2.5 Shared logic (5 files)

`money.ts` — integer minor units end to end, half-up rounding, basis-point tax rates, rejects non-integer input rather than rounding silently. `order-status.ts` — the order state machine and role permissions in one place, to be shared by UI, API and a contract test against the database trigger.

### 2.6 Web scaffold (28 files, ~1,450 lines)

- **Brand:** DineFlow wordmark and mark (a plate with a flow line through it), drawn in `currentColor`, legible at 16 px.
- **Tokens:** one set, with the kitchen dark theme redefining the same names, so each component is written once.
- **Components (11 + shell):** Button, IconButton, Card, Badge, Field/Input, MoneyText, OrderStatusChip, StatTile, EmptyState, Skeleton, LiveIndicator, DemoBanner, AppShell, Page.
- **Dashboard:** stat tiles carrying their own definitions, recent orders as a table on desktop and cards on mobile, unbilled money shown separately from sales, working empty state.
- **`/design` route:** every component in every state with a light/dark toggle — the target for accessibility and visual checks.
- **CI:** three jobs (database harness and restore drill against a real Postgres service; shared tests, contrast, typecheck, build and render smoke; secret scanning).

## 3. Your six Stage 2 conditions

| Condition | Resolution |
|---|---|
| Tenant-isolation testing | Declarative matrix with automatic discovery, undeclared-cell failure, and nine sabotage canaries. Built and passing. |
| RLS enforcement | Found a hole in my own design: Supabase's `authenticated` role would have let a staff member use their own token against the auto-generated Data API, bypassing every rule and the audit log. DineFlow now uses its own roles, the Supabase roles get nothing, and the API refuses to start if its role can bypass RLS. |
| Backup-restore testing | Automated at three levels rather than a quarterly manual drill. Level 1 runs locally and in CI today; levels 2 and 3 need your accounts and are scripted for module 18. |
| QR security | Redesigned. Tokens are HMAC-signed; the database stores only a random id, never a usable token. Two independent secrets are needed to forge one, and forged tokens are rejected before any database query. |
| Billing auditability | Hash-chained ledger with externally anchored heads, a content hash printed on each bill, duplicate-copy marking on reprints, daily reconciliation, and an honest statement that this is detective rather than preventive. |
| Licensing | Provisional defaults set, plus the points the architecture forces into the contract — most importantly that "we delete your data in 90 days" is untrue unless backup expiry is stated separately. |

## 4. Verification results (executed 2026-09-20 22:57)

| Suite | Result | What it proves |
|---|---|---|
| Shared unit tests | **5/5 pass** | Money arithmetic is exact; non-integer amounts are rejected, not silently rounded |
| Role hygiene | **2/2 pass** | The harness itself cannot bypass RLS |
| Schema guards | **1/1 pass** | Schema is closed by default: RLS forced, no `USING (true)`, no forbidden grants, definer functions reviewed and pinned |
| Isolation matrix | **408/408 pass** (195 declared cells) | No principal sees or writes another tenant's data |
| Request-context isolation | **3/3 pass** | A pooled connection cannot carry one request's identity into the next |
| Sabotage canaries | **18/18 pass** | All nine sabotages are detected and repaired — the harness still works |
| Restore drill | **15/15 pass** in 0.8 s | Backups restore with data *and* security posture intact; wrong keys and truncation are rejected |
| Token contrast, both themes | **44/44 pass** | Every colour pair meets its WCAG AA minimum |
| Render smoke test, 3 routes | **19/19 pass** | The component tree renders, has a skip link, one `h1`, labelled demo data and named icon buttons |
| Typecheck and production build | **passes** | Strict TypeScript, 81.7 kB gzipped framework chunk + 3.4 kB app |

**Total: 528 automated checks, all passing.**

### Not run

axe-core and screen-reader passes (need a browser driver, arriving with the E2E setup), real-device iOS Safari checks, thermal-printer output, load tests, and the production-shaped restore drill against real backups. None of these is claimed as passing.

## 5. Defects found and fixed

Seven real defects, each caught by a check rather than by review:

| # | Defect | Found by |
|---|---|---|
| 1 | Support grants were editable — a platform admin could re-point an existing grant at another restaurant and inherit its access | Isolation matrix |
| 2 | My `PUBLIC` grant check never fired: `information_schema` spells the role `PUBLIC`, my comparison was lowercase | Sabotage canary |
| 3 | Migration re-application was silently skipped, which would have made canary repair a no-op and left later canaries testing a broken schema | Canary repair step |
| 4 | The contrast script's CSS parser matched the wrong block and scored the light theme as "missing tokens" while appearing to run | Its own output |
| 5 | Four dark-theme colour pairs genuinely failed, including white text on filled brand and danger buttons at 2.92:1 and 2.68:1 | Contrast check |
| 6 | Light-theme input borders failed the 3:1 non-text minimum | Contrast check |
| 7 | The demo-data guard fired during the first production build | The guard working as designed |

Defect 2 is the one worth remembering: a security check that silently passes is worse than no check, and only the canary exposed it.

## 6. Decisions taken without your input

You have not answered the open questions in PRD §17, so these assumptions are in force and recorded in [design/07 §1](design/07-stage2-conditions.md). All are cheap to change now.

| Topic | Assumption |
|---|---|
| Budget (Q-03) | ≈ $45/month total, Supabase Pro accepted |
| Domain (Q-04) | Provisional. QR printing is gated behind `QR_DOMAIN_FINAL` and watermarked until you confirm a permanent domain |
| Billing unit (Q-06) | A bill may cover several orders from the same table visit |
| Roles (Q-10) | PRD §8 matrix as written; managers manage kitchen and billing staff only; no separate Waiter role |
| Licensing (Q-14) | Single shared hosted deployment, no source-code delivery |
| Market | India-first: INR, Asia/Kolkata, configurable tax |
| Brand | Green-teal palette, plate-and-flow mark, kitchen-only dark mode |

## 7. Risks currently carried

| Risk | State |
|---|---|
| Printed QR codes depend on a permanent domain | **Open.** Blocked on your domain decision; printing is disabled until then |
| One-time revenue against ongoing hosting cost | **Open.** Cost model built (≈ $4.50/restaurant/month at 10 restaurants), but renewal terms need your decision |
| Tax and invoice legality | **Open by design.** Configurable, disclaimed, and flagged for an accountant |
| Licensing and data-protection wording | **Open.** Needs a lawyer; ⚖ items marked throughout |
| Cross-tenant leakage | **Controlled.** Five layers, 408 checks, canaries proving the checks work |
| Data loss | **Controlled locally.** Drill passes; production-shaped drill pending your Supabase account |
| Insider or stolen-credential tampering | **Partly controlled.** Hash-chained ledger makes it detectable, not impossible |
| Solo-operator dependency | **Open.** Runbooks and monitoring are planned for module 18 |

## 8. What happens next

On your approval of Stage 3, module-by-module development begins in this order, each with plan → implement → test → review and your approval between modules:

1. Authentication (login, MFA, sessions, invitations, rate limits)
2. Restaurant onboarding and staff management
3. Dashboard wired to a real API
4. Tables and QR generation
5. Menu management
6. Public QR menu, cart and ordering
7. Order dashboard and kitchen workflow
8. Billing, ledger and PDF
9. Audit log viewer, exports, retention
10. Deployment, monitoring, runbooks

Three answers would unblock real spending and printed material: the infrastructure budget, the permanent domain, and whether restaurants get a hosted service or expect source code.
