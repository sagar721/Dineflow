# Module 5 — Public QR menu, cart and order creation

What was built, how it is protected, and what is still missing. Design sources:
- [design/01 §3.4](../design/01-database.md): orders schema;
- [design/02 §6.6, §7, §8](../design/02-api-auth-tenancy.md): public routes, rate limits, the placement algorithm;
- PRD FR-030 … FR-046.

## Customer flow

```
/t/:token  →  menu (from the API, for this QR only)  →  add / change / remove  →  review (server-priced)
          →  Place order  →  /o/:statusToken (confirmation and live status)
```

- **The cart** holds choices only: item ids, quantities and notes.
  - It lives in `localStorage` for that table (FR-035). It is versioned, validated on load, and discarded after 12 hours.
  - On load it is checked against the current menu. Sold-out or vanished items are dropped, and the customer is told.
- **Prices while browsing** come from the menu the server sent. The **review screen asks the server to price the cart** (`/quote`). **Placing the order prices it again** from the database. The browser never sends a price, subtotal, restaurant or table.
- **Past orders on this device.** `/o/:statusToken` works after a reload and later on the same device (FR-042). The menu lists "Your orders at this table".

## API

| Method and path | Notes |
|---|---|
| `GET /public/tables/:token/menu` | As in module 4, plus `ordering: { contactPolicy, maxQtyPerLine, maxItemsPerOrder }`. |
| `POST /public/tables/:token/quote` | `{ items: [{ menuItemId, quantity, note? }] }` → server-priced lines and subtotal. Writes nothing. 60 per minute per IP. |
| `POST /public/tables/:token/orders` | Header `Idempotency-Key: <uuid>`. Body `{ items, specialInstructions?, contact?: { mobile?, email? } }`. Answers 201 (created) or 200 (idempotent replay) with `{ order, statusToken, replayed }`. |
| `GET /public/orders/:statusToken` | The order: ref, number, status, items, subtotal and restaurant name. **Never contact details or ids.** 120 per minute per IP. |

**Errors:**

| Status | Code | When |
|---|---|---|
| 400 | `CART_EMPTY` | The cart has no items |
| 400 | `VALIDATION_FAILED` | Bad quantity (0, negative, fractional, over 99, or not a number), bad id, a note over 200 characters, instructions over 500, or an unknown field (such as a price) |
| 400 | `DUPLICATE_ITEM` | The same item appears twice |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | The header is missing or not a UUID |
| 400 | `CONTACT_NOT_COLLECTED` | Contact details sent while the policy is `off` |
| 404 | `TABLE_UNAVAILABLE` / `ORDER_NOT_FOUND` | One generic answer each, after the same 250 ms floor |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different cart or table |
| 413 / 400 | `PAYLOAD_TOO_LARGE` / `INVALID_JSON` | Oversized or unreadable body |
| 422 | `ORDER_ITEM_UNAVAILABLE` | `details: [{ menuItemId, reason: 'sold_out' \| 'not_on_menu' }]` |
| 422 | `QUANTITY_LIMIT` / `ORDER_TOO_LARGE` | Over the restaurant's per-item or per-order limit |
| 422 | `ORDERING_PAUSED` | The restaurant is not taking orders |
| 429 | `RATE_LIMITED` | Too many orders in the window |

## Placing an order

The whole placement runs in **one transaction**, as the customer role, scoped by RLS to the restaurant the QR resolved to (design/02 §8):

1. Verify the QR token's MAC in memory, then resolve it. A live code, active table and active restaurant are all required, or the answer is the generic 404.
2. Apply rate limits: 10 per IP, 5 per table and 200 per restaurant, each per 10 minutes.
3. Load the restaurant's `accepting_orders` flag, contact policy, limits and order prefix. Apply the contact policy.
4. **Idempotency.** An order with this key and the same request fingerprint is returned as a replay. The same key with a different cart or table is refused (409).
5. Load **every requested item in one query**. RLS returns only shown, live items in shown, live categories of this restaurant, so hidden, archived, deleted and **other restaurants'** items are all answered as "no longer on the menu", never revealed. Sold-out items are named.
6. Compute line totals and the subtotal from database prices, in integer paise.
7. `app.next_order_no()` allocates the number: one counter row per restaurant, locked for the transaction. Then write `orders`, all `order_items` in one statement (name and price **snapshots**), and `order_customers` if contact details were given.
8. Commit. A deferred database trigger checks that the order has at least one line and that its subtotal equals the sum of its lines.

Any failure at any step rolls back **everything, including the order number**. The tests cover a database failure injected after the lines are written: no order, no lines and no number used.

## Idempotency

- The app makes one `Idempotency-Key` per cart, saves it with the cart before sending, and reuses it on retry or reload. Any edit to the cart drops the key.
- The database stores the key with a SHA-256 **fingerprint** of the request (table, items, notes, instructions and contact), with `UNIQUE (restaurant_id, idempotency_key)`.
- **Simultaneous identical requests:** one commits and the others hit the unique key. They then look again and answer as replays. Tested with 10 at once: exactly one order.

## Order numbers

- Numbers are continuous per restaurant (Q-13, D-18). The reference is `<prefix>-<n>`, or `<n>` without a prefix; the prefix is `restaurant_settings.order_prefix`.
- They're allocated only through `app.next_order_no()`. It takes no argument, so a customer request can only number orders of its own restaurant.
- The counter's row lock serialises concurrent orders, and a rollback returns the number. Tested with 12 at once: consecutive, no gaps, no duplicates.

## The status token

- It's 128 bits. It's derived from the idempotency key with the server's QR signing key (domain-separated), so a replayed request returns the same link.
- **Only its SHA-256 is stored** (`public_token_hash`). A customer can read an order back only by presenting the token: RLS matches its hash, set for one transaction.
- **Caveat:** if the QR signing key is rotated, a *replay* of an order placed under the old key will get a 409 rather than its original link. The link already issued keeps working.

## Data and security

Migration `009_orders.sql` adds `order_counters`, `orders`, `order_items` and `order_customers`.

- **Tenant links:**
  - `orders.table_id → dining_tables` and `order_items.menu_item_id → menu_items` use composite `(id, restaurant_id)` foreign keys. An order can't use another restaurant's table or item.
  - `order_items → orders` is composite too.
- **Integer money with bounds.** `line_total_minor` is a generated column. Quantities are 1–99. Notes and instructions are length-limited.
- **One line per item per order** is enforced by a unique constraint.

| Role | orders / order_items | order_customers | order_counters |
|---|---|---|---|
| Owner, manager, billing | read own | read own | — |
| Kitchen | read own | **none** | — |
| Platform admin with a support grant | read | none | — |
| Customer (QR) | insert own (new, pending, only while accepting); read **only with the status token** | insert own | via `app.next_order_no()` only |

- **No role may update or delete** an order, line or contact row yet. The status workflow is the next module.
- There are two new reviewed SECURITY DEFINER functions: `app.next_order_no` and `app.check_order_totals`. Customers may now also read the `order_prefix` column of their restaurant's settings.
- **Isolation harness:** 714 declared cells, 1,613 checks, including all four new tables.

## Tests

- **`apps/api/test/ordering.test.ts` (34 tests):**
  - the quote;
  - validation of every malformed input;
  - revalidation of sold-out, hidden, archived, hidden-category, nonexistent and foreign items;
  - database prices at the moment of ordering;
  - paused restaurants;
  - invalid, forged, revoked, inactive-table and suspended-restaurant codes;
  - idempotency (replay, changed cart, other table, missing key, 10 concurrent);
  - numbering (12 concurrent, per-restaurant prefix);
  - atomicity (injected failure, the database total check, cross-tenant foreign keys);
  - contact policies and kitchen/billing visibility;
  - the status page (content, snapshots, generic 404 with timing floor, no access without the token);
  - rate limits;
  - staff isolation, and no updates or deletes.
- **`apps/web/src/features/order/cart.test.ts` (8 tests):**
  - add, change and remove;
  - sold-out refusal;
  - limits, integer money and choices-only requests;
  - key reset on change;
  - reconciliation;
  - storage parsing that drops tampered data.
- **The render smoke test** also renders the customer menu with fixed data, checking:
  - add controls follow availability;
  - quantity controls appear for items in the cart;
  - no add buttons while the restaurant is paused;
  - veg/non-veg labels.

## Verification status (not production-verified)

Verified **locally only**, against the local Docker database. Nothing here has run in production.

- **Migration 009 is local only.** It needs 006, 007 and 008 before it.
- **No browser click-through testing yet** of the cart, review or status pages.
- **Lint:** the repository has no linter.

## Known limitations and deferred items

- **FR-044 bot protection (Turnstile) is not built.** It needs a Cloudflare account and a server secret. The in-app rate limits are in place.
- **FR-045 customer cancellation** (a Should) is deferred to the orders module. It needs the status history and the cancellation reason (FR-054, FR-055), which come with the state machine.
- **Estimated taxes (D-17)** are not shown. The customer sees the server-computed **subtotal**, labelled "taxes, if any, on your bill". The shared tax function will come with Billing, and the estimate will use it then.
- **Status updates** use polling every 15 s (FR-041). Staff can't change status until the next module, so orders stay `pending`.
- **Table occupancy and permanent table deletion** still wait for the orders module's status workflow.
- **Rate-limit counters** are in memory, per API process (as before).
