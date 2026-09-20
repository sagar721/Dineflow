# DineFlow — Technical Design, Part 5: Project Structure and Delivery Plan

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for approval) |
| **Repo** | Monorepo (pnpm workspaces) rooted at the current project folder, under version control (Git) from the first commit. |

---

## 1. Folder structure

```
dineflow/
├─ apps/
│  ├─ web/                          # React + Vite + TS + Tailwind
│  │  ├─ src/
│  │  │  ├─ app/                    # router, providers, layouts, error boundaries
│  │  │  ├─ components/ui/          # design-system primitives (Button, Input, Dialog, Table, Toast…)
│  │  │  ├─ features/               # one folder per domain; UI + hooks, no business rules
│  │  │  │  ├─ auth/  onboarding/  dashboard/  tables/  qr/  menu/
│  │  │  │  ├─ orders/  kitchen/  billing/  staff/  settings/  audit/
│  │  │  │  └─ public-menu/         # customer QR flow (own lightweight bundle)
│  │  │  ├─ lib/                    # api client, query client, formatting, cart storage
│  │  │  └─ styles/                 # tokens, Tailwind config
│  │  └─ public/  index.html  _headers (CSP)
│  └─ api/                          # Express + TS
│     ├─ src/
│     │  ├─ server.ts  app.ts       # bootstrap, middleware wiring
│     │  ├─ config/                 # Zod-validated environment
│     │  ├─ middleware/             # requestId, security, cors, csrf, rateLimit, auth, tenant, permission, errors
│     │  ├─ db/                     # Kysely instance, withTenantTx / withPublicTx, generated types
│     │  ├─ modules/                # one folder per domain: routes.ts, schemas.ts, service.ts, repo.ts
│     │  │  ├─ auth/  platform/  restaurant/  staff/  tables/  menu/
│     │  │  ├─ public/  orders/  billing/  reports/  audit/  exports/
│     │  ├─ lib/                    # pdf, images, email, turnstile, storage, logging, tokens
│     │  └─ openapi/                # spec generation
│     └─ test/                      # integration, concurrency, security
├─ packages/
│  └─ shared/                       # used by both apps
│     └─ src/  money.ts  tax.ts  permissions.ts  order-state.ts  schemas/  types.ts
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/                   # timestamped SQL (Part 1 §9)
│  ├─ seed/                         # dev/staging only, `[DEMO]`-labelled
│  └─ tests/                        # pgTAP
├─ e2e/                             # Playwright
├─ load/                            # k6
├─ scripts/                         # backup, restore-drill, seed, env check
├─ docs/
│  ├─ PRD.md
│  ├─ design/                       # this document set
│  ├─ api/                          # generated OpenAPI
│  ├─ runbooks/                     # deploy, rollback, restore, incident, offboarding, cost review
│  ├─ user-guide/                   # for restaurant owners
│  └─ ENVIRONMENT.md  SECURITY-CHECKLIST.md  TESTING.md  TROUBLESHOOTING.md  traceability.md  RELEASE-NOTES.md
├─ .github/
│  ├─ workflows/                    # ci.yml, deploy-staging.yml, deploy-prod.yml, backup.yml, nightly.yml
│  └─ pull_request_template.md      # security & isolation checklist
├─ .nvmrc  .editorconfig  .gitignore  pnpm-workspace.yaml  package.json
└─ README.md
```

**Boundary rules (lint-enforced):** `features/*` in the web app never contain money, tax or permission logic (they import from `packages/shared`); `modules/*` in the API never import from each other's `repo.ts` (only through service interfaces); only `db/` may import the database driver; only `middleware/auth` and `lib/storage` may hold provider credentials.

## 2. Coding standards

- TypeScript `strict`, `noUncheckedIndexedAccess`; ESLint (typescript-eslint, security and import rules), Prettier; conventional commit messages; small PRs with the security/isolation checklist.
- No `any` in shared and API code without an explanatory comment; no raw SQL string concatenation (Semgrep/ESLint rule); no `dangerouslySetInnerHTML`; no `console.log` in API (pino only).
- Errors are typed (`AppError` with code and HTTP status); nothing is swallowed; unknown errors are logged with the request ID and returned generically.
- Dependencies added only with a short justification in the PR; prefer well-maintained, widely used packages; lockfile committed.

## 3. Module delivery plan (Stage 4)

Each module follows Plan → Implement → Test → Review, with your approval before the next major module. I adjusted the PRD's order in **bold** where a change reduces risk.

| # | Module | Main deliverables | Key acceptance gate |
|---|---|---|---|
| 1 | **Project foundation, CI and security scaffolding** | Monorepo, tooling, config validation, error handling skeleton, logging, CI, PR template, secret scanning, local Supabase, `docs/ENVIRONMENT.md` | CI green on an empty feature; app boots only with valid config |
| 2 | **Database foundation and tenant-isolation harness (moved earlier)** | Migration 001–002, roles, RLS helper functions, `restaurants`/`restaurant_users`, pgTAP harness with two-tenant fixtures, `withTenantTx` | Isolation tests fail if RLS is removed (proving they can fail) |
| 3 | Authentication | Login, logout, refresh, MFA, reset, cookie handling, CSRF, rate limits | Auth negative suite green |
| 4 | Restaurant onboarding & staff invites | Super Admin provisioning, invitation flow, onboarding wizard, settings | J1 end to end |
| 5 | Design system and app shell (Stage 3 work, delivered here) | Tokens, base components, layout, responsive nav, accessibility checks | axe clean; keyboard walkthrough |
| 6 | Restaurant dashboard shell | Summary API + UI, empty/loading/error states | Numbers match definitions |
| 7 | Table management | Migration 003, CRUD, archive/delete rules | Duplicate/archival tests |
| 8 | QR generation | Tokens, rotation, print sheet | Rotation and abuse tests |
| 9 | Menu management | Migration 004, editor, image pipeline | Upload security suite |
| 10 | Public QR menu | Public endpoints, SPA route, caching | Performance budget met |
| 11 | Cart and ordering | Migration 005, order algorithm, idempotency, Turnstile | Tampering/duplication/concurrency suites |
| 12 | Order dashboard | Polling, list, filters, detail | ≤ 5 s visibility |
| 13 | Kitchen workflow | Status machine, kitchen screen, alerts, history | Transition × role matrix |
| 14 | Billing and PDF | Migration 006, draft/finalize/void/pay, printable + PDF, reports (should-have) | Integrity and immutability suites |
| 15 | Staff roles and permissions (hardening) | Full matrix tests across all routes, escalation tests | Generated matrix green |
| 16 | Audit logs | Migration 007, viewer, coverage of FR-121 events | Every listed event produces an entry |
| 17 | Exports, retention, error handling, performance | Export job, retention job, load tests, tuning | NFR-P targets met |
| 18 | Deployment configuration | Render/Pages/Supabase setup, secrets, runbooks, backup workflow, monitoring | Restore drill, rollback rehearsal |

> **Stage 3 sequencing:** the PRD puts the UI/UX design system (Stage 3) before module development. I will still run it as its own approved stage right after Stage 2, using only a minimal `apps/web` scaffold (no backend needed). Module 5 above is then just the integration of that approved design system into the app shell.
>
> The PRD listed audit logs as module 16. To keep sensitive actions auditable from the start, module 1 ships the `audit_log` table and the `audit()` helper skeleton, and each later module records its events as it is built. Module 16 then completes the viewer UI and verifies full FR-121 coverage.

## 4. CI/CD pipeline

```
PR:      install → lint → typecheck → unit → start local Supabase → pgTAP → API integration/concurrency → build → smoke E2E → gitleaks → audit
main:    all of the above → deploy staging (migrations first, then API, then web) → nightly full E2E + a11y + ZAP baseline
release: tag → manual approval → backup snapshot → migrations → API deploy with health gate → web promote → post-deploy smoke test → release notes
rollback: web = promote previous deployment; API = redeploy previous image; DB = expand/contract, forward-fix or documented reverse migration
```

## 5. Documentation map (kept current with each module)

| Document | Created in module |
|---|---|
| README, ENVIRONMENT, TESTING, SECURITY-CHECKLIST | 1 |
| Database docs (generated ERD + policy matrix) | 2, updated per migration |
| API docs (OpenAPI) | Each module adds its routes |
| Auth and authorization guide | 3, 15 |
| User guide for restaurant owners (with screenshots) | 4–14, finalized 18 |
| Deployment, rollback, backup/restore, incident, offboarding, cost runbooks | 18 |
| Troubleshooting guide, release notes | 17–18, ongoing |
