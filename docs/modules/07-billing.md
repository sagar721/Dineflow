# Module 7 — Billing

What was built, how it is protected, and what is still missing. Sources:
- PRD FR-070 … FR-084, BR-BILL-01 … 08, BR-ORD-03/04, US-08;
- [design/01 §4.2](../design/01-database.md): bill arithmetic and the lifecycle in the database;
- [design/02 §6.8](../design/02-api-auth-tenancy.md): the billing routes;
- [design/07 §5](../design/07-stage2-conditions.md): the ledger, content hashes and duplicate copies;
- the approved billing decisions (1–11) recorded with this module's plan.

## Lifecycle

```
            discount (owner/manager, capped for managers)
                 ▲
   Draft ────────┴────► Finalized ────► Void      (numbers are never reused)
     │                      │
     │ discard              │ payment recorded → reversed → recorded again
     ▼                      ▼
   deleted, ledgered     PDF / print copies: 1st is the original, later ones DUPLICATE
```

- **A draft** is a snapshot: its lines, tax components, service charge, rounding mode
  and currency are copied from the orders and settings as they are at that moment
  (FR-074). Later menu or tax changes never alter it. Only the discount can change.
- **Finalizing** draws the next number for the restaurant, refreshes the issuer
  details once more, and freezes the bill with a SHA-256 **content hash**.
- **A finalized bill is never edited.** A mistake is corrected by voiding it (with a
  reason) and issuing a new one; the number stays and shows as VOID (FR-077).
- **A draft may be discarded** (approved decision 7). No number is consumed, and the
  discard is recorded in the ledger.

## Money (FR-073, FR-075, FR-082, BR-BILL-04/05)

One implementation, `packages/shared/src/bill.ts`, in integer minor units (paise):

| Step | Rule |
|---|---|
| Subtotal | Σ unit price × quantity, from the snapshot lines |
| Discount | percent (basis points, half-up) or a fixed amount; never more than the subtotal; reason required |
| Service charge | on the **post-discount** base, and **not taxed** (approved decision 4) |
| Tax, exclusive | each component's rate on the post-discount base, added on top |
| Tax, inclusive | the **combined** rate is extracted from the base once, then split by rate, with the paise remainder on the last component, so taxable + taxes = base **exactly** (approved decision 3) |
| Rounding | none, nearest 0.50 or nearest 1.00, shown as its own (possibly negative) line |

The database re-checks the result: `bills_total_identity` holds on every row, always,
and finalization re-checks the totals against the stored lines and taxes.

## API

Under `/api/v1/restaurant`; the restaurant comes from the session and RLS. No route accepts a restaurant id.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /bills` | `bill.read` (O, M, B) | Filters: `status`, `payment`, `table`, `from`/`to` (restaurant's days), `q` (bill number), keyset paging |
| `GET /bills/billable` | `bill.create` | Tables with unbilled, non-cancelled orders; with `?table=` their orders (approved decision 1) |
| `POST /bills` | `bill.create` | `{orderIds[]}` of one table; creates the draft snapshot |
| `GET /bills/:id` | `bill.read` | The whole bill, its orders, payments and content hash |
| `PATCH /bills/:id/discount` | `bill.discount.apply` (O, M) | `{type, value, reason, version}`; `{type: null}` removes it. Percent in basis points, fixed in minor units |
| `DELETE /bills/:id` | `bill.create` | Drafts only |
| `POST /bills/:id/finalize` | `bill.finalize` | `{version}`; **idempotent**: a bill already issued is returned with `repeated: true` |
| `POST /bills/:id/void` | `bill.void` (O, M) | `{reason, version}`; refused while a payment stands |
| `POST /bills/:id/payments` | `payment.record` | `{method, amountMinor, reference?}`; the exact total, once. Repeating the identical payment returns it with `repeated: true` |
| `POST /payments/:id/reverse` | `payment.reverse` (O, M) | `{reason}` |
| `POST /bills/:id/print`, `POST /bills/:id/pdf` | `bill.read` | Each records a numbered copy in the ledger; the PDF is the file itself |
| `GET /reports/sales` | `report.sales` (O, M, B) | `from`, `to`, `groupBy=day\|method`; a plain read |
| `POST /reports/sales/export` | `report.sales` | The same parameters; returns the CSV and records `report.sales.exported` |

**Errors:** 400 `VALIDATION_FAILED`, `MIXED_TABLES`, `AMOUNT_MISMATCH`, `DISCOUNT_TOO_LARGE`;
403 `FORBIDDEN`, `DISCOUNT_ABOVE_LIMIT`; 404 for anything of another restaurant or a
malformed id; 409 `STALE_VERSION`, `ORDER_CANCELLED`, `ALREADY_BILLED`, `NOT_DRAFT`,
`NOT_FINALIZED`, `ALREADY_PAID`, `ALREADY_REVERSED`, `PAYMENT_EXISTS`, `BILL_VOID`,
`ALREADY_VOID`, `BILL_RULE` (a database guard refused).

## Database (migrations `011_billing.sql` and `012_billing_ledger.sql`, local only)

- **Tables:** `bill_counters`, `bills`, `bill_orders`, `bill_lines`, `bill_taxes`,
  `payments`, `bill_ledger`, `bill_ledger_heads`.
- **Numbering (FR-072, BR-BILL-03):** `app.next_bill_no()` takes no restaurant
  argument — a caller can only number its own bills — and a bill can be finalized
  only with the number just drawn (`app.bill_no_is_current`). The draw is in the
  finalizing transaction, so a failed finalization gives the number back. One
  continuous `main` series; a financial-year reset is deferred (decision 5). The
  reference is the plain number (decision 6).
- **`app.bills_guard`** (BEFORE UPDATE OR DELETE) holds the lifecycle for everyone,
  the table owner included: what a bill was generated from can never change; a void
  bill is frozen; a finalized bill may only become void (owner or manager, no live
  payment); a draft's discount is owner/manager only, with the manager's cap from
  `restaurant_settings`; finalization re-checks the number, the orders, that none was
  cancelled, and the totals against the lines and taxes.
- **`app.bill_children_guard`** keeps lines, taxes and order links to drafts; the only
  later change is an order being released when its bill is voided.
- **`app.payments_guard`:** only on a finalized bill (read `FOR SHARE`, so a
  concurrent void is seen), for the exact total, never deleted, reversed once, by an
  owner or manager. `ux_payments_live` allows one live payment per bill.
- **`ux_bill_orders_live`** gives BR-BILL-01: an order is on at most one live bill.
- **Order rules:** `app.order_update_guard` now also refuses cancelling an order on a
  finalized bill (BR-ORD-04) and served → ready while the order is on any live bill
  (BR-ORD-03). The API answers both with 409 `ORDER_BILLED` first.
- **Privileges:** kitchen has none at all. Column-level `UPDATE` on `bills` and
  `payments`; nobody holds any privilege on `bill_counters`.
- **Reviewed SECURITY DEFINER list:** `app.next_bill_no`, `app.bill_no_is_current`,
  `app.order_bill_state`, `app.ledger_on_bills`, `app.ledger_on_payments`,
  `app.record_bill_copy`.

## The billing ledger (design/07 §5)

Every billing event is appended by a trigger, in the same transaction as the change:
`bill_created`, `discount_applied`, `draft_discarded`, `bill_finalized`,
`bill_voided`, `payment_recorded`, `payment_reversed`, `pdf_generated`,
`bill_printed`.

- Entries are **chained per restaurant**: `entry_hash = SHA-256(prev_hash + entry text)`,
  numbered 1, 2, 3 …, with the head in `bill_ledger_heads` (locked during an append,
  so concurrent billing still forms one chain).
- The table is **append-only** (`app.deny_mutation`) and readable only by the billing
  roles of its own restaurant and by support access. Nobody can write to it directly:
  the append function is granted to no one and runs inside the definer triggers.
- **Content hash:** a finalized bill's canonical text (`canonicalBillText`, fixed key
  order, no timestamps) is hashed and stored on the bill and in its ledger entry, so
  a paper or PDF copy can be checked against the database later.
- **Duplicate copies (condition 5.3):** `app.record_bill_copy` numbers every PDF and
  print. The first is the original; later ones print **DUPLICATE COPY n**. A void bill
  prints VOID.
- **The verifier** (`packages/db/src/billing-ledger.ts`) recomputes all of it from the
  stored rows, in TypeScript, independently of the database's own hash function:
  chains and head, every issued bill's content hash, gap-free numbering with the
  counter at n + 1, and that every payment and reversal is ledgered.
  - `DATABASE_URL=… node scripts/verify-billing-ledger.mjs [--restaurant <uuid>] [--json]` — read-only.
  - It also runs in the **restore drill**, against the restored copy, together with a
    check that the restored counters cannot reissue a number and a deliberate
    tampering that must be detected.

**Deferred by approved decision 9:** external anchoring of chain heads, the weekly
digest email, and a reconciliation/exception UI.

## Screens

- **`/billing`** — "New bill": tables with unbilled orders, then the orders to include;
  then the bill list with filters (unpaid, paid, draft, void, number, dates).
- **The bill dialog** — the bill as it will print, its payments, and the actions this
  role may take: discount, finalize, discard, record payment, reverse, void, print.
- **`/billing/:id/print`** — outside the app shell, so only the bill is printed; 80 mm
  roll and A4 widths, and a PDF download. Printing marks duplicates.
- **`/billing/sales`** — sales by day or by payment method, with CSV export (FR-084).
- **Orders** — an order's details show its bill, or offer "Create bill".

## Sales report (FR-084)

Bills **finalized** in the period, on the restaurant's own days (its timezone):
by day (bills, voided bills, subtotal, discounts, service charge, tax, rounding,
total) or by payment method (live payments only). Void bills are not sales and are
counted separately. Owners and managers see everything; **billing staff see the sales
they billed themselves**, which is how design/02 §6.8 reads "B: own billed sales".
CSV export is audited (`report.sales.exported`), carries a UTF-8 BOM, writes money as
plain decimals, and neutralises any text a spreadsheet would run as a formula.

## Audit

`bill.created`, `bill.discount_applied`, `bill.finalized`, `bill.voided`,
`bill.discarded`, `payment.recorded`, `payment.reversed`, `report.sales.exported`.
Audit rows are append-only (migration 002); the ledger records the same events
independently, with hashes.

## Tests

- **`packages/shared/src/bill.test.ts` (10):** the PRD worked example, exclusive and
  inclusive tax (including an awkward split), discounts, the untaxed service charge,
  rounding, invalid input, a 5,000-case property test of the stored identity, and the
  stability of the canonical text.
- **`apps/api/test/billing.test.ts` (43):** drafts and their snapshots; refusals
  (cancelled, already billed, mixed tables, unknown); six people billing one order at
  once; discounts and the manager cap (API **and** database); numbering, including 8
  concurrent finalizations with no gaps and one bill finalized 5 times getting one
  number; the content hash; immutability enforced by the database against the table
  owner; voiding and re-billing; payments, repeats, concurrency and reversal;
  BR-ORD-03/04 in the API and in the database; the ledger (every event, in order,
  append-only, unbroken under concurrency, tampering detected); copies and duplicate
  marks; the sales report, its scope for billing staff, its CSV and its refusals;
  isolation from another restaurant, platform admins and signed-out callers.
- **`packages/db` harness:** 1,008 declared cells, 2,524 checks, plus 6 ledger checks
  (clean verification and four tamperings detected).
- **`apps/web`:** `features/billing/logic.test.ts` (5) and a bill-document render
  check in the smoke test; the print page and sales report render.
- **Restore drill:** 20/20, including billing fingerprints and ledger verification.

## Verification status

- **Verified locally only**, against the local Docker database. **Migrations 011 and
  012 are local only.**
- **Browser testing has not been done.** No browser automation is installed; the
  screens were checked by type checking, the render smoke test and the API tests.
  **The print layout has not been checked on paper or on a thermal printer.**

## Known limitations

- **FR-083 (email or share the bill to the customer)** is deferred, as approved.
- **Deferred ledger work:** external anchoring, the weekly email, reconciliation UI.
- **One live payment per bill**: no partial or split payments (PRD v1, Q-08).
- **A draft's contents cannot be edited**: change the orders by discarding it and
  making a new one. Only the discount is editable, as FR-076 requires.
- **A bill covers one table.** Merging tables is not a v1 feature.
- **The financial-year series reset** is deferred (decision 5); `bill_series` exists
  in the schema so it can be added without a data change.
- **Currency** is frozen once a restaurant goes live (migration 004), which is
  stricter than design/02's "locked after the first bill". A restaurant still in
  `provisioning` could in principle change its currency after a test bill.
- **PDFs are generated per request** and not stored; the ledger records that one was
  made. A restaurant needing a long-term archive is a later feature.
