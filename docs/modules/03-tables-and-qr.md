# Module 3 — Tables & QR codes

What was built, how the QR codes work, and how to deploy it. Design sources: [design/01 §3.2](../design/01-database.md), [design/07 §5](../design/07-stage2-conditions.md), PRD FR-010 … FR-018.

## QR lifecycle

```
token = base64url( key id (1 byte) ‖ qr_id (16 bytes) ‖ MAC (16 bytes) )     44 characters
MAC   = first 16 bytes of HMAC-SHA256( QR_SIGNING_KEYS[key id], "dineflow-qr-v1" ‖ qr_id )
URL   = {APP_BASE_URL}/t/{token}
```

| Event | What happens |
|---|---|
| **Generate** | A random `qr_id` (128 random bits from the API, not a version-4 uuid, which has only 122) is stored with the key id that will sign it. Nothing else is stored — not the token, not the MAC. If the table already has a live code, the existing one is returned (201 on issue, 200 on repeat). |
| **View / download again** | The token is recomputed from `qr_id` and the key, so a lost card can be reprinted **without** invalidating the one already on the table. This is why the design signs tokens instead of hashing them: with hash-only storage a reprint forces a regeneration. |
| **Scan** | The MAC is checked in memory first; a forged, malformed or truncated token never reaches the database. Then `app.resolve_table_qr` requires the code, the table and the restaurant all to be live, and the key id in the token to match the one recorded. |
| **Regenerate** | Revokes the live code and issues a new one in one transaction, under a row lock on the table. The old card stops working when it commits. Concurrent regenerations run one after another and leave exactly one live code. |
| **Revoke** | Marks the live code revoked. Repeating it is harmless and returns `revoked: false`. A revoked code cannot be reinstated, even by the database owner. |
| **Deactivate the table** | Does **not** revoke the code. Scanning shows "not available" while the table is out of service, and the same printed card works again on reactivation. |

Every way a code can fail — malformed, forged, unknown, revoked, table inactive, restaurant suspended or not yet live — returns the same 404 with the same message, **after the same minimum time (250 ms)**, so scanning reveals nothing about which restaurants or tables exist. Without the floor, a forged token (rejected in memory) answered faster than a once-real one (rejected after a database lookup).

### Two secrets, held apart

The database holds `qr_id`s; the API's environment holds the keys. A working token needs both, so a stolen backup cannot be used to order at a table, and a leaked key cannot be aimed at a table without its `qr_id`.

### Key rotation

`QR_SIGNING_KEYS` may list several keys. New codes are signed with the highest key id (or `QR_SIGNING_KEY_ID`); older ones keep verifying. Removing a key from the list deliberately invalidates every card signed with it — use that only if a key is compromised, and plan a reprint.

A token only works with the key its `qr_id` was issued under. Without that check, a key kept only so old cards keep working could be used to mint new tokens for any code.

### The print gate

Until `QR_DOMAIN_FINAL=true`, every card is marked **PROVISIONAL — DO NOT PRINT** and download and print are disabled. A laminated card encodes `APP_BASE_URL` permanently; printing before the domain is settled would strand every card (design Q-04). Scanning the on-screen code still works for testing.

## API

All staff routes derive the restaurant from the session and RLS; none accept a restaurant id.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /restaurant/tables` | `table.read` | `?status=`, `?search=` (literal). The `qr` field appears only for roles with `qr.read`. Capped at 500. |
| `GET /restaurant/tables/:id` | `table.read` | Another restaurant's id returns 404. |
| `POST /restaurant/tables` | `table.write` | `{ tableNumber, name?, notes?, capacity }` |
| `POST /restaurant/tables/bulk` | `table.write` | `{ prefix?, from, to, capacity }` creates `prefix+from` … `prefix+to`, at most 100. All or nothing: any clash returns 409 naming the clashing numbers, and nothing is created. Each table is audited. |
| `PATCH /restaurant/tables/:id` | `table.write` | `{ tableNumber?, name?, notes?, capacity?, version }`. Status is not settable here. |
| `PATCH /restaurant/tables/:id/status` | `table.write` | `{ status, reason?, version }` |
| `GET /restaurant/tables/:id/qr` | `qr.read` | 404 when no live code |
| `GET /restaurant/tables/:id/qr/png` | `qr.read` | The live code as a 1024 px PNG attachment |
| `GET /restaurant/tables/qr-sheet` | `qr.read` | Every active table with a live code, for the A4 sheet, plus a count of active tables without one |
| `POST /restaurant/tables/qr/issue-missing` | `qr.rotate` | Issues a code for each active table without one; never replaces an existing code. Returns `{ issued }`. |
| `POST /restaurant/tables/:id/qr` | `qr.rotate` | Generate, or return the existing code |
| `POST /restaurant/tables/:id/qr/regenerate` | `qr.rotate` | |
| `POST /restaurant/tables/:id/qr/revoke` | `qr.rotate` | Idempotent |
| `GET /public/tables/:token` | none | Rate limited to 120 per minute per IP. Returns restaurant name, accent colour, whether it is taking orders, and the table number and name — no ids. |

`table.read`: owner, manager, kitchen, billing. `table.write`, `qr.read`, `qr.rotate`: owner, manager. Platform admins get nothing here; a support grant gives read-only access to tables but **not** to QR records.

## Rules

- Table numbers: 1–20 characters, stored as typed after trimming, unique per restaurant **case-insensitively** ("t01" and "T01" collide). Different restaurants may reuse a number.
- Capacity: whole number, 1–100.
- Notes (migration 007): optional, up to 500 characters, trimmed, **staff only**. Readable by every role with `table.read`, never returned to customers.
- A table never moves between restaurants; a QR record is never re-aimed.
- Nothing is deleted. Hard deletion of a table with no order history (FR-012) waits for the orders module, which is what makes "no history" checkable.

## Printing

- **One card:** the QR dialog shows the card, with SVG and PNG download and print.
- **A4 sheet:** `/tables/qr-sheet` prints every active table's card, three across, none split over a page break. It offers to generate any missing codes first.
- Both follow the print gate above: provisional cards are watermarked, and download and print stay off.

## Deploying

Migrations `006_tables_and_qr.sql` and `007_table_notes.sql` are applied locally and **not** to Supabase. The API reads the `notes` column, so **both must be applied together** before this API version serves table requests in an environment.

1. Generate a production key and set `QR_SIGNING_KEYS` on the API host, following [runbooks/qr-signing-key.md](../runbooks/qr-signing-key.md). It generates straight to the clipboard, so the key is never displayed. The API refuses to start without a valid key.
2. Confirm the deploy log shows `api listening`, not a `QR_SIGNING_KEYS:` error.
3. Apply the migrations, once approved:
   ```bash
   set -a && . ./.env && set +a && node -e "import('./packages/db/src/migrate.ts').then(m=>m.migrate(process.env.SUPABASE_OWNER_URL))"
   ```
4. Re-run the isolation harness against the target (see [ENVIRONMENT.md](../ENVIRONMENT.md)).
5. Set `QR_DOMAIN_FINAL=true` only once the public domain is permanent.

### Rollback

The migration is additive: two tables, one enum, triggers and functions, and nothing existing is altered. If it has to be reversed before any real QR codes are printed, drop `table_qr_tokens`, then `dining_tables`, the `table_status` type, and the functions `app.resolve_table_qr`, `app.dining_table_immutable` and `app.table_qr_immutable`, and delete the `006_tables_and_qr.sql` row from `schema_migrations`. **After codes are printed, do not roll back**: every printed card would stop working.

Rollback of 007 before any notes are relied on: `alter table dining_tables drop column notes`, and delete the `007_table_notes.sql` row from `schema_migrations`.

## Verification status (not production-verified)

Verified **locally only**: API tests against a real Postgres with RLS, the tenant-isolation harness and sabotage canaries, the restore drill, the web render smoke test and the production build. Nothing here has run in production yet.

| # | Not yet done | Why, and when |
|---|---|---|
| 1 | **The Supabase Storage bucket has not been created.** | A production change that needs approval (see Deploying). |
| 2 | **Photo upload has not been tested against a real Supabase bucket.** | Tested only against an in-memory store. Test it once the bucket exists. |
| 3 | **No browser click-through testing yet** of the Tables, QR sheet, Menu or customer menu pages. | Only the render smoke test and API tests have run. |
| 4 | Table occupancy (vacant, occupied, awaiting bill) | Needs orders and bills. |
| 5 | Permanent deletion of a table with no order history | Needs order-history rules. |
| 6 | Past orders keeping an item's original name and price | Comes with the orders table's snapshot. |
| 7 | Reordering items within a category | Not built yet; category order is editable. |
| 8 | Restaurant logo | Not built yet. |
| 9 | Lint | **The repository has no linter.** Strict TypeScript is the only static check; setting one up is a separate task. |
| — | Migrations 006, 007 and 008 | Applied to the local database only. |

## Known limitations

- **Waiting for the orders module**, deliberately:
  - **Occupancy (FR-013: vacant, occupied, awaiting bill).** It must be derived from real orders and bills, and neither exists yet, so no status is shown rather than a made-up one.
  - **Hard deletion of a table with no order history (FR-012).** "No history" can only be checked once orders reference tables. The orders table's foreign key to `dining_tables` will then make the database itself refuse to delete a table with history.
- The timing floor adds 250 ms to unavailable answers only. Successful scans are not delayed.
- Rate limits are per process and in memory, and need a shared store before a second API instance is added.
