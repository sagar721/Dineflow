# DineFlow

Multi-tenant QR ordering and basic billing for restaurants and cafés.

**Status: Stage 2 approved with conditions; foundation and tenant-isolation harness built and verified. No application code (API or web app) exists yet.**

| What | Where |
|---|---|
| Product requirements | [docs/PRD.md](docs/PRD.md) |
| Technical design (7 parts) | [docs/design/](docs/design/) |
| Conditions from the Stage 2 review | [docs/design/07-stage2-conditions.md](docs/design/07-stage2-conditions.md) |
| Database migrations | [packages/db/migrations/](packages/db/migrations/) |
| Tenant-isolation harness | [packages/db/test/](packages/db/test/) |
| Restore drill | [scripts/restore-drill/](scripts/restore-drill/) |

## Requirements

- Node 22+ (this repo runs TypeScript directly; no build step for the database package)
- Docker (for the disposable Postgres the tests use)
- [`age`](https://github.com/FiloSottile/age) (backup encryption in the restore drill): `brew install age`

## Getting started

```bash
npm install
npm run db:up        # start a disposable Postgres on localhost:55432
npm run db:migrate   # apply migrations
npm run harness      # tenant-isolation harness (schema guards, matrix, canaries)
npm run restore-drill
npm run db:down      # remove the container
```

`npm run harness` exits non-zero on any failure and is the merge gate in CI.

## What the harness checks

| Group | Question it answers |
|---|---|
| Role hygiene | Does the test connection itself run without the power to bypass RLS? (Otherwise every other result is meaningless.) |
| Schema guards | Is the schema closed by default: RLS enabled *and* forced, no `USING (true)`, no grants to `anon`/`authenticated`/`service_role`/`PUBLIC`, `SECURITY DEFINER` functions reviewed and `search_path`-pinned, no owner-rights views? |
| Isolation matrix | For every table × principal × command, does the database behave exactly as declared — and does any *undeclared* combination fail the run? |
| Context isolation | Can a pooled connection carry one request's identity into the next? |
| Canaries | If someone disables RLS, drops a policy, grants a table to `PUBLIC` or adds an unreviewed `SECURITY DEFINER` function, does the harness actually catch it? |

The canaries matter as much as the tests: a suite that has never been seen to fail is not evidence.

## Conventions

- Money is stored and computed in **integer minor units**; no floating point anywhere.
- Financial and audit rows are never deleted by application code.
- Migrations are plain SQL, applied in order, recorded with a checksum, and written to be idempotent.
- Every tenant table carries `restaurant_id`, has RLS forced, and appears in the isolation matrix.

## Not yet built

API server, web app, QR tokens, menu, orders, billing, PDF, deployment. See the module plan in [docs/design/05-project-structure.md](docs/design/05-project-structure.md).
