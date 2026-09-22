# Module 6 — Orders and kitchen

What was built, how it is protected, and what is still missing. Design sources:
- [design/01 §3.4, §4.1](../design/01-database.md): status history, and the state machine enforced in the database;
- [design/02 §6.7](../design/02-api-auth-tenancy.md): the order routes;
- [design/00 §3.2, D-05, PRD-CHG-04](../design/00-architecture-and-decisions.md): live updates by polling;
- PRD FR-050 … FR-060.

## Order lifecycle

```
pending ──► accepted ──► preparing ──► ready ──► served
   │            │            │
   └────────────┴────────────┴──► cancelled          served and cancelled are final
Owner/manager only: revert one step (accepted→pending, preparing→accepted, ready→preparing, served→ready)
```

| Change | Who | Notes |
|---|---|---|
| pending → accepted, accepted → preparing, preparing → ready | Owner, manager, kitchen | |
| ready → served | Owner, manager, billing | Kitchen does not serve |
| pending/accepted → cancelled | Owner, manager, kitchen | **Reason required** (3–300 characters) |
| preparing → cancelled | Owner, manager | Reason required |
| Revert one step | Owner, manager | Reason required. **Cancelled is never reverted.** Served → ready is allowed while bills don't exist; the billing module adds "only if the order is on no live bill" (BR-ORD-03). |

The rules are in one place, `packages/shared/src/order-status.ts`, and are enforced **twice**:
- **API:** refuses an illegal change (409 `ILLEGAL_TRANSITION`) and a change the role may not make (403).
- **Database:** `app.order_update_guard`, a `BEFORE UPDATE` trigger, refuses the same changes independently. It also refuses any edit to what was placed: amounts, lines, table, number, reference, instructions and token.
- **A cancellation's reason and author are fixed.** Once an order is cancelled, staff cannot change `cancel_reason` or `cancelled_by`, and `cancelled_by` can be set only by the cancelling change itself. The history keeps the original reason in any case.
- **A contract test** runs every role × from × to (120 combinations) against the database and asserts that it agrees with the shared state machine.

## API

All routes are under `/api/v1/restaurant/orders`, need a signed-in staff member, and take the restaurant from the session. None accepts a restaurant id.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /` | `order.read` (all four roles) | Filters: `status` (comma list), `table`, `from`/`to` (dates in the **restaurant's timezone**), `q` (reference or number), `cursor`, `limit` (≤100). Newest first, with keyset paging. Each order carries its item summary. **Never contact details.** |
| `GET /?view=kitchen` | `order.read` | Active orders only, **oldest first**, up to 200 (FR-056). |
| `GET /live?since=<cursor>` | `order.read` | Live updates: `{ cursor, changes: [{id, version}], newOrders: [{id, ref, tableNumber}] }`. |
| `GET /:id` | `order.read` | The **snapshot** lines, subtotal, status history, staff note and cancel reason. Contact details **only for owner, manager and billing**: the field is absent for kitchen, and RLS would return nothing anyway. |
| `POST /:id/status` | Per the table above | `{ to, version, reason? }` |
| `POST /:id/revert` | `order.revert` (owner, manager) | `{ version, reason }` |
| `PATCH /:id/staff-note` | `order.staffNote` (all four roles) | `{ note \| null, version }`. Internal only; never shown to the customer (FR-059). |

**Errors:**

| Status | When |
|---|---|
| 400 | Validation failed, or the reason is missing (`REASON_REQUIRED`) |
| 403 | The role may not make this change, or the caller is a platform admin |
| 404 | The order is missing, belongs to another restaurant, or the id is malformed. All three look the same. |
| 409 | `STALE_VERSION` (FR-058) or `ILLEGAL_TRANSITION` |

## Concurrency (FR-058)

Every change:
1. locks the order row (`FOR UPDATE`);
2. checks the caller's `version`;
3. updates it with `version + 1`, in one transaction.

A second device acting on the same version gets 409 `STALE_VERSION`. The screen then reloads the order and says why. Tested: 8 simultaneous "Accept" requests give exactly 1 success and 7 conflicts, and there is exactly one history row.

## Live updates (FR-050)

Per the approved design, **D-05 and PRD-CHG-04: "realtime" is 3-second cursor polling**, not Supabase Realtime. Supabase Realtime stays disabled (D-19), because it would put a Supabase token in the browser. Polling *is* the mechanism, so there is no separate fallback.

- The web app's `useLiveOrders` hook polls `/live` every 3 s, and only while the tab is visible.
  - It de-duplicates by order id and version, and announces each new order once.
  - When the tab comes back into view, it catches up at once.
- The server looks back 5 s past the cursor. A transaction that commits late with an earlier timestamp is still seen; clients ignore repeats.
- The connection state is always visible: **Live**, **Reconnecting** after one failed poll, and **Not receiving orders** after 15 s without success.
- New orders **chime** (Web Audio, after staff tap "Turn on sound" once, as browsers require) and **flash** the kitchen board.
- Worst-case latency is about 3 s plus the network, inside the 5 s target (NFR-P04).
- **The customer's status page** (`/o/:statusToken`) polls every 15 s, as in module 5. It now follows the real lifecycle. A cancelled order shows a general message, **never the staff's reason** (FR-054: "in generic form").

## Kitchen screen (FR-056)

`/kitchen` has four columns: Pending, Accepted, Preparing, Ready.
- Orders are oldest first, in large type.
- Each card shows the elapsed time, and is highlighted after 15 minutes.
- Cards show item notes and instructions.
- Each card has **one large button for the next step this role may take**. Cancel, revert and notes are in the order's details.

The rules behind the board (`features/orders/board.ts`) are pure functions with unit tests.

## Database (migration `010_order_workflow.sql`, local only)

- **New columns on `orders`:** `cancel_reason` (3–300 characters; present exactly when the order is cancelled), `cancelled_by`, `staff_note` (≤500), and `updated_at` (the live cursor, with an index).
- **New table `order_status_history`:** append-only, written only by the `SECURITY DEFINER` trigger `app.record_order_status`.
  - It records a row when an order is placed and on every status change: from, to, actor, the actor's role, the reason and the time.
  - Existing orders are backfilled with their "placed" row.
  - `app.deny_mutation` blocks updates and deletes, even by the table owner.
- **Staff privileges:**
  - `UPDATE` only on the workflow columns;
  - RLS `UPDATE` for any staff role of the order's own restaurant, with the guard deciding which changes are allowed;
  - read-only history.
  - Platform admins with support access stay read-only.
- **Reviewed SECURITY DEFINER list:** now includes `app.record_order_status`.
- **Isolation harness:** 756 declared cells and 1,712 checks, including history and the new staff update rights.

## Audit

- **`order.cancelled`:** the reference, the status it was cancelled from, and the reason.
- **`order.reverted`:** the reference, from, to and the reason.

FR-121 names cancellation and revert. Every other step is recorded in the status history (FR-055). Audit rows are append-only (migration 002).

## Tests

- **`apps/api/test/orders.test.ts` (27 tests):**
  - the list: filters, timezone dates, paging without repeats, the kitchen view;
  - detail: the snapshot, history, and contact details by role (none for kitchen);
  - every transition by role;
  - skipping, backwards moves and finished orders;
  - cancel with a reason, audited, shown to the customer only in general terms;
  - revert rules;
  - stale versions, and 8 concurrent accepts;
  - the database guard on its own: the contract test, immutable placed data, a cancel reason required, immutable cancellation reason and author, no history writes;
  - the staff note;
  - live updates, isolated per restaurant;
  - the customer's view of each step;
  - isolation: other restaurant, platform admin, signed out.
- **`apps/web/src/features/orders/board.test.ts` (8 tests):** role actions, board grouping, elapsed time, late flags, one announcement per order.
- **The smoke test:** renders `/orders` and `/kitchen`, and the kitchen board with fixed data for kitchen and billing roles.
- **Every setup step is asserted.** A status change used only to prepare a test must itself succeed, or the test stops and shows the response.

### Test harness: why the suite once failed intermittently

About 1 run in 12 used to fail, on a different test each time, because a test's request reached **another program on this machine** instead of the app.
- supertest starts each app on a random port on every address (`::`), then connects to `127.0.0.1`.
- When another program already listened on `127.0.0.1` at the port the OS picked (VS Code's helper processes do, in the same port range), the OS allowed both, and the request went to that program. The test then got an unrelated 401 or 404.

**The fix:** `serveLocally` in `apps/api/test/helpers.ts` starts every test app on `127.0.0.1` itself, so the OS only hands out ports free on that address. `apps/api/test/test-server.test.ts` guards it.

The same investigation found a real bug in order placement (module 5). Identical requests racing each other could fail with a 500, because the second one could trip either of two unique indexes; only one was handled as a replay. Both are handled now, and the concurrency test runs 5 rounds.

## Verification status

- **Verified locally only**, against the local Docker database. **Migration 010 is local only** and needs 006–009 before it.
- **Browser testing has not been done.** No browser automation is installed. Signing in locally uses the real Supabase project and real accounts, which I have not used for testing. The screens have been checked by type checking, the render smoke test and the API tests only.

## Known limitations

- **FR-060 (edit items after placement, a Could)** is not built. The way is cancel and re-order.
- **FR-045 (customer self-cancel, a Should)** is still deferred. The staff side of cancellation exists now.
- **Served → ready** is allowed without the bill check, because bills don't exist yet. The billing module must extend `app.order_revert_allowed`.
- **Live updates are polling**, per design D-05: in memory, one API process. SSE plus pub/sub is the documented upgrade for more than one instance.
- **The chime** needs one tap per screen load. It can't sound on a screen nobody has touched, which is a browser rule.
- **The kitchen board** shows at most the 200 oldest active orders.
