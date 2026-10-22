# DineFlow

**Multi-tenant restaurant platform — security-first foundation, in active development.**

DineFlow is being developed to let restaurants manage menus, table QR codes, kitchen workflows and billing on one shared platform. The public repository currently contains the project specification, database-security foundation, tenant-isolation tests, backup/restore drill, shared logic and a web design-system scaffold.

> **Current status:** customer-facing modules are not all complete. Read the implementation table below and `docs/STATUS.md` before treating any feature as implemented. Nothing in this README claims production deployment or production readiness.

## My role

I lead product definition and implementation review for this project, including the requirements, architecture and security verification approach. AI coding tools have assisted with implementation. The claims in this README should be checked against the code and verification records in the repository.

## Implementation status

The detailed verification report records its run on **2026-09-20**; counts below are historical results from that run, not a claim that the same checks have been rerun today.

| Area | Status in the documented report | Source |
|---|---|---|
| Product requirements and user stories | Documented | [PRD](docs/PRD.md) |
| Architecture, database design, API/auth design and threat model | Documented | [Design documents](docs/design/) |
| PostgreSQL foundation and row-level security policies | Implemented and tested in the documented run | [Database migrations](packages/db/migrations/) |
| Tenant-isolation harness | 408 checks reported passing in the dated report | [Database tests](packages/db/test/) |
| Encrypted backup/restore drill | 15 checks reported passing in the dated report | [Restore drill](scripts/restore-drill/) |
| Shared money and order-state logic | Implemented; see tests and code | [Shared package](packages/shared/src/) |
| Web design system and dashboard scaffold | Implemented as a scaffold; dashboard data is labelled demo data | [Web app](apps/web/) |
| API server | Work in progress in the documented README status | [API app](apps/api/) |
| Authentication | Do not mark complete unless its code and tests are pushed to the reviewed branch and API tests pass | [API app](apps/api/) |
| Tables and signed QR codes | Planned / not confirmed complete by the dated report | [Technical design](docs/design/02-api-auth-tenancy.md) |
| Menu, ordering, kitchen workflow and billing | Not confirmed complete by the dated report | [Project plan](docs/design/05-project-structure.md) |
| Deployment and production operations | Not confirmed complete by the dated report | — |

## Architecture

```text
apps/
  api/       Node.js + TypeScript API
  web/       React + Vite web app
packages/
  db/        SQL migrations, migration runner and tenant-isolation harness
  shared/    Money and order-state logic
scripts/
  restore-drill/  Encrypted backup/restore verification
docs/        Product requirements, technical design and status
```

## Security and design principles

- **Tenant isolation at the database layer:** PostgreSQL row-level security is part of the design; see the migrations and tests for the implementation.
- **Adversarial verification:** the documented harness includes deliberate schema/policy sabotage checks intended to catch security regressions.
- **Integer money arithmetic:** financial calculations should use integer minor units rather than floating-point amounts.
- **Append-only audit trail and restore verification:** see migrations and the restore-drill implementation for the concrete mechanisms.

## Tech stack

TypeScript, Node.js, PostgreSQL, React, Vite, Docker and GitHub Actions. The project also documents Supabase integration and uses `age` for backup encryption in the restore drill.

## Getting started

Requirements described by the repository include Node.js, Docker and `age`.

```bash
npm install
npm run db:up
npm run db:migrate
npm run harness
npm run restore-drill
npm test
npm run dev:web
npm run db:down
```

Check `.nvmrc`, `package.json` and the environment documentation in the current branch before running commands. Copy `.env.example` to `.env` if present and never commit real secrets.

## Historical test results

The status report dated **2026-09-20** records the following run:

| Suite | Reported result |
|---|---:|
| Isolation matrix | 408 / 408 |
| Sabotage canaries | 18 / 18 |
| Restore drill | 15 / 15 |
| Token contrast checks | 44 / 44 |
| Render smoke test | 19 / 19 |
| Shared unit tests, role hygiene, schema guards and request-context isolation | 5/5, 2/2, 1/1 and 3/3 |
| Total reported automated checks | 528 |

These are historical results, not newly run checks. The report lists accessibility tooling/screen-reader passes, real-device checks, load tests and a production-shaped restore drill as not yet run.

## Documentation

- [Project status](docs/STATUS.md)
- [Product requirements](docs/PRD.md)
- [Technical design documents](docs/design/)
- [Database migrations](packages/db/migrations/)
- [Tenant-isolation tests](packages/db/test/)
- [Restore drill](scripts/restore-drill/)
- [Web app](apps/web/)
- [API app](apps/api/)

## Limitations

- Do not treat the app as deployed or production-ready based on this repository alone.
- The dated status report does not verify that customer-facing menu, ordering or billing modules are complete.
- Tax/invoice rules and licensing terms require appropriate professional review before real-world use.

## Author

**Sagar Kumar** — [GitHub](https://github.com/sagar721) · [LinkedIn](https://www.linkedin.com/in/sagar-kumar-1314a6379/)
