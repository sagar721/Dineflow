# DineFlow — Product Requirements Document (PRD)

| | |
|---|---|
| **Version** | 0.1 (Draft for approval) |
| **Date** | 2026-09-20 |
| **Status** | Awaiting owner approval — no code will be written until approved |
| **Owner** | Product Owner (you) |
| **Scope of this document** | Product definition only. Architecture, schema, API and threat model are Stage 2 deliverables. |

**Requirement priority key:** **M** = Must (v1 launch blocker) · **S** = Should (v1 if capacity allows, otherwise v1.1) · **C** = Could (post-v1)

---

## 1. Executive Summary

DineFlow is a cloud-hosted, multi-tenant restaurant and café ordering system. A customer scans a QR code on their table, browses the restaurant's digital menu on their phone, and places an order without installing an app or creating an account. The order appears instantly on the restaurant's dashboard, where staff move it through a simple status workflow (Pending → Accepted → Preparing → Ready → Served) and generate a printable/PDF bill with configurable taxes and a recorded payment.

One codebase and one deployment serve many restaurants, with strict data isolation between them. The product is sold to restaurants for a **one-time fee**, with 1–2 years of hosting included. The first target is about **10 restaurants**.

The v1 goal is a **small, polished, reliable and secure** product, not a full POS or accounting system. Priorities, in order: security, data integrity, reliability, correctness, UX, maintainability, scalability.

## 2. Problem Statement

Small and medium restaurants and cafés face:

1. **Slow, error-prone ordering.** Staff must take orders verbally or on paper, causing mistakes, waiting time and lost tickets, especially at peak hours.
2. **Printed menus that are costly to change.** Price changes and sold-out items mean reprinting or verbally correcting customers.
3. **No order/sales visibility.** Owners lack simple, trustworthy daily figures.
4. **Manual billing.** Handwritten or spreadsheet bills lead to arithmetic errors and inconsistent tax handling.
5. **Existing software is too heavy or too expensive.** Full POS suites and subscription-based ordering platforms are complex and carry recurring fees that small operators resist.

## 3. Business Objectives

| ID | Objective |
|---|---|
| BO-01 | Ship a sellable v1 that can be onboarded for a new restaurant in **≤ 1 working day** without developer involvement beyond account provisioning. |
| BO-02 | Onboard and operate ~10 restaurants on a single shared deployment. |
| BO-03 | Zero cross-tenant data exposure, verified by automated tests before every release. |
| BO-04 | Keep total infrastructure cost predictable and low enough to be covered by the 1–2 year hosting bundled in the one-time price (budget to be confirmed, see Q-03). |
| BO-05 | Keep ongoing maintenance for the owner to a minimum (managed services, automated backups, automated dependency checks, no bespoke per-tenant deployments). |
| BO-06 | Establish a clear commercial model (license, support, hosting, offboarding) that can be reviewed by a lawyer before the first sale. |

## 4. Target Audience and Personas

### 4.1 Target market
Small and medium single-outlet restaurants and cafés (roughly 5–40 tables), with owner-operators or a small management team, staff with limited technical skill, and reliable but not guaranteed internet. Primary geography assumed: **India** (see A-01).

### 4.2 Personas

| Persona | Role in system | Goals | Pain points / constraints |
|---|---|---|---|
| **Priya, Café Owner** | Restaurant Owner | See daily sales, control menu and prices, add/remove staff, avoid paying monthly SaaS fees. | Not technical. Wants setup done in a day. Worries about staff misuse and lost data. |
| **Rahul, Restaurant Manager** | Restaurant Manager | Run the floor, manage menu availability, handle cancellations and discounts. | Busy; needs fast, low-click workflows on a tablet or phone. |
| **Sunita, Kitchen Lead** | Kitchen Staff | See incoming orders clearly, mark progress, flag sold-out items. | Wet/greasy hands, small screen or wall-mounted tablet, noisy environment (needs audible alerts). |
| **Amit, Cashier** | Billing Staff | Produce accurate bills, record payments, print receipts quickly. | Must not be able to change menu/prices or view other admin areas. |
| **Neha, Customer** | Public user (no account) | Browse menu, order quickly, know the order was received and its status. | Uses own phone on mobile data; impatient; may have low-end device; privacy-sensitive about phone/email. |
| **You, Platform Super Admin** | Platform operator | Provision/suspend restaurants, support them, monitor health and cost. | Sole operator; needs minimal ongoing effort and strong safeguards against accidental tenant-data exposure. |

## 5. Product Scope

### 5.1 In scope (v1)
Restaurant onboarding and profile; table management with secure per-table QR codes; menu management; public mobile menu, cart and order placement; real-time order dashboard and kitchen screen; order status workflow; basic billing (tax, optional discount, printable bill, PDF, payment recording); admin dashboard with basic sales stats; five-role RBAC; staff management; audit log; multi-tenant isolation; automated backups; deployment, monitoring and documentation.

### 5.2 Out of scope (v1)
Online payment gateway integration (payments are *recorded*, not *processed*); customer accounts/loyalty/coupons; delivery/takeaway/pickup flows and third-party aggregator integration; inventory and recipe costing; full accounting/GST return filing/e-invoicing (IRN); split bills and partial payments (see Q-08); item variants/add-on modifiers (see Q-07); multi-outlet chains under one owner; native mobile apps; multi-language UI (single language in v1, see Q-11); kitchen printer (KOT) hardware integration; table reservations; waiter-call/request-bill buttons (see roadmap); white-label custom domains per restaurant; in-app subscription billing.

### 5.3 Explicitly not claimed
DineFlow v1 does **not** claim compliance with any country's tax, invoicing, data-protection or e-invoicing law. Tax and invoice fields are **configurable** and must be reviewed by the restaurant and its accountant before commercial use (see BR-BILL-08).

## 6. User Journeys

**J1 — Provision a restaurant (Super Admin → Owner).**
Super Admin creates the restaurant record and invites the owner by email → owner accepts invite, sets password (and MFA if enabled) → completes onboarding wizard (profile, logo, currency/tax settings, first tables, first categories/items) → downloads/prints QR codes → restaurant is switched to "Accepting orders".

**J2 — Customer orders.**
Customer scans QR → menu opens showing correct restaurant and table → browses categories → adds items, adjusts quantities, adds special instructions → enters contact details (if the restaurant requires/allows) → reviews server-priced total → places order → sees confirmation with order number and live status.

**J3 — Kitchen fulfils.**
New-order alert sounds/flashes on kitchen screen → Kitchen accepts → marks Preparing → marks Ready → floor staff/manager marks Served.

**J4 — Billing.**
Billing staff opens a served (or any active) order → system generates a draft bill → optional discount (if permitted) → finalize (amounts locked) → print/PDF → record payment method and mark paid.

**J5 — Owner manages the business.**
Owner views today's orders/sales → edits prices, marks an item unavailable → adds a Manager and Kitchen staff → reviews audit log.

**J6 — Restaurant offboarding.**
Restaurant requests data export → Super Admin (or Owner, self-service) generates export → restaurant suspended/closed → data retained or deleted per policy.

## 7. Functional Requirements

### 7.1 Restaurant Management (RM)

| ID | Requirement | Pri |
|---|---|---|
| FR-001 | Super Admin can create a restaurant (tenant) with a unique system-generated restaurant ID and invite its Owner by email. | M |
| FR-002 | Public self-service restaurant signup is **not** available in v1; onboarding is invite-based (see Q-01). | M |
| FR-003 | Owner can complete an onboarding wizard: name, address, phone, email, logo, currency, timezone, tax settings, contact-collection policy. | M |
| FR-004 | Owner/Manager can edit restaurant profile (name, logo, address, contact details, opening hours text). | M |
| FR-005 | Restaurant branding: logo and one primary accent colour applied to the public menu and printed bill. | M |
| FR-006 | "Accepting orders" toggle: when off, the public menu remains viewable but ordering is disabled with a clear message. | M |
| FR-007 | Restaurant lifecycle states: *Provisioning, Active, Suspended, Closed*. Suspended restaurants cannot log in staff or accept orders; data is preserved. | M |
| FR-008 | Restaurant settings: currency (single per restaurant), timezone, tax configuration, bill footer text, order-numbering prefix, customer-contact policy (off / optional / required mobile / required email). | M |
| FR-009 | Super Admin can view the list of restaurants with status and basic usage metadata; access to a tenant's business data (orders, customers) is **not** part of default Super Admin views (see FR-121). | M |

### 7.2 Table Management (TM)

| ID | Requirement | Pri |
|---|---|---|
| FR-010 | Owner/Manager can create a table with a label (e.g., "12", "Patio 3"), unique within the restaurant. | M |
| FR-011 | Owner/Manager can edit a table's label/notes and activate/deactivate it. | M |
| FR-012 | Deleting a table with any order history is **not allowed**; it is soft-deactivated (archived) instead. A table with zero order history may be permanently deleted. | M |
| FR-013 | Table status displayed on dashboard: *Vacant* (no active orders), *Occupied* (≥1 active order), *Awaiting bill* (served, unpaid). | M |
| FR-014 | Each table has a unique QR code encoding a **secure, unguessable, revocable token** that resolves server-side to (restaurant, table). The QR must not encode raw sequential IDs or trust client-supplied restaurant IDs. | M |
| FR-015 | Owner/Manager can view, download (PNG/SVG) and print QR codes individually and as a printable sheet (A4, multiple per page, with table label and restaurant name). | M |
| FR-016 | Owner/Manager can **regenerate** (rotate) a table's QR token; the old token stops working immediately. | M |
| FR-017 | QR for a deactivated table or non-active restaurant shows a friendly "not available" page, never revealing other data. | M |
| FR-018 | Bulk table creation (e.g., "create tables 1–20"). | S |

### 7.3 Menu Management (MM)

| ID | Requirement | Pri |
|---|---|---|
| FR-020 | Owner/Manager can create, rename, reorder, hide/show and archive menu categories. | M |
| FR-021 | Owner/Manager can create and edit menu items: name, description, price, category, image, veg/non-veg indicator, availability, visibility. | M |
| FR-022 | Prices are stored with exact decimal precision in the restaurant's currency; non-negative; sane upper bound enforced. | M |
| FR-023 | Item image upload with server-side validation (type by content, size limit, re-encoding, metadata stripping) and per-tenant storage isolation. | M |
| FR-024 | Kitchen Staff and above can toggle an item **Available/Unavailable** quickly (sold out) without editing other fields. | M |
| FR-025 | Hidden items and hidden categories never appear on the public menu; unavailable items appear as "Sold out" and cannot be added to cart. | M |
| FR-026 | Items referenced by past orders cannot be hard-deleted; "remove" archives the item. Historical orders keep the name/price captured at order time. | M |
| FR-027 | Menu changes take effect on the public menu within 30 seconds. | M |
| FR-028 | Item search/filter on the admin menu editor; text search on public menu. | S |
| FR-029 | Item variants/add-ons (e.g., size, extra cheese) with price impact. | C (see Q-07) |

### 7.4 Public QR Menu and Ordering (PO)

| ID | Requirement | Pri |
|---|---|---|
| FR-030 | Scanning a table QR opens the public menu for the correct restaurant and table, showing restaurant name, logo and table label. | M |
| FR-031 | Menu displays categories and items with name, description, price and image; mobile-first and usable one-handed. | M |
| FR-032 | Customer can add/remove items and change quantities (integer, min 1, max per-line limit configurable, default 20). | M |
| FR-033 | Customer can add optional special instructions per order (and/or per item); length-limited and rendered as plain text everywhere. | M |
| FR-034 | Contact fields (mobile, email) displayed/required per restaurant policy (FR-008), with format validation and a visible privacy notice describing use of the data. | M |
| FR-035 | Cart persists across page refresh on the same device (locally), and is cleared after successful order. | M |
| FR-036 | Review screen shows line items and a total **computed by the server**; the client displays but never dictates prices. | M |
| FR-037 | On submit, the server re-validates every item (exists, belongs to this restaurant, available, visible), quantities, restaurant "accepting orders" status and table validity, and computes prices and totals from database values only. Any mismatch returns a clear, friendly message (e.g., "Paneer Tikka is now unavailable"). | M |
| FR-038 | Each order submission carries an **idempotency key**; repeated submissions with the same key (double tap, retry, refresh) create exactly one order. | M |
| FR-039 | Order creation is atomic (order + order items + number allocation in one transaction); failure leaves no partial data. | M |
| FR-040 | Each order gets a unique, human-readable order number, unique per restaurant (e.g., prefix + sequence, resettable daily is optional). | M |
| FR-041 | Confirmation screen shows order number, table, items, total and current status; page auto-updates status. | M |
| FR-042 | Customer can view their order status later on the same device via an unguessable order-status link (no login). The link exposes only that order's non-sensitive data. | M |
| FR-043 | Customers can place **additional orders** from the same table during a visit; each is a separate order. | M |
| FR-044 | Rate limiting and abuse controls on the public ordering endpoint (per IP, per table token, per restaurant), plus bot protection (e.g., CAPTCHA/Turnstile) that activates on suspicious traffic. | M |
| FR-045 | Customer can cancel their own order only while it is still *Pending*, subject to restaurant setting. | S |
| FR-046 | Public menu loads within performance targets (NFR-P01) and works with images lazy-loaded. | M |

### 7.5 Order Management and Kitchen (OM)

| ID | Requirement | Pri |
|---|---|---|
| FR-050 | New orders appear on the order dashboard in real time (target ≤ 5 s) with a visual and audible alert; falls back to polling if realtime connection drops, and the UI shows connection state. | M |
| FR-051 | Order card/detail shows: order number, table, items, quantities, special instructions, customer contact (only to roles permitted), total, placed time (restaurant timezone), status. | M |
| FR-052 | Statuses: **Pending, Accepted, Preparing, Ready, Served, Cancelled.** | M |
| FR-053 | Allowed transitions (server-enforced): Pending→Accepted; Accepted→Preparing; Preparing→Ready; Ready→Served; Pending/Accepted/Preparing→Cancelled. Served and Cancelled are terminal. No skipping or backward transitions except by Owner/Manager "revert one step" (audited) (see Q-09). | M |
| FR-054 | Cancelling an order requires a reason; the reason is stored and shown to the customer's status page in generic form. | M |
| FR-055 | Every status change records who, when, from-status, to-status (order status history). | M |
| FR-056 | Kitchen screen: a focused, large-type view showing active orders (Pending→Ready) grouped by status, sorted oldest first, with elapsed-time indicator. | M |
| FR-057 | Order list with filters (status, table, date range), search by order number, pagination. | M |
| FR-058 | Concurrent updates are handled safely (optimistic concurrency): if two staff act on the same order, the second sees a clear conflict message rather than silently overwriting. | M |
| FR-059 | Staff can add an internal staff note to an order (not visible to customers). | S |
| FR-060 | Staff/manager can edit an order's items after placement (add/remove item) while Pending/Accepted, with full audit; otherwise cancel and re-create. | C |

### 7.6 Billing (BL)

| ID | Requirement | Pri |
|---|---|---|
| FR-070 | Authorized staff can generate a bill for an order (or for all non-cancelled orders of a table's current sitting, see Q-06). | M |
| FR-071 | A bill shows: restaurant name/logo/address/contact, tax registration number (if configured), bill number, order number(s), table, date/time, itemised lines (name, qty, unit price, line total), subtotal, discount, each tax line, service charge (if enabled), rounding adjustment, grand total, payment status. | M |
| FR-072 | Bill numbers are unique and **sequential without gaps per restaurant** (per configured financial-year/series), allocated only at finalization. | M |
| FR-073 | Tax configuration per restaurant: one or more named tax components (name, rate %), inclusive or exclusive pricing mode, optional tax-registration number, optional service charge %. Rates are configurable, never hardcoded. | M |
| FR-074 | Line-item prices and tax rates are **snapshotted** onto the bill at generation, so later menu or tax changes never alter existing bills. | M |
| FR-075 | Optional discount (fixed amount or %) with mandatory reason, applied only to a **Draft** bill by roles permitted (default: Owner, Manager); capped so total ≥ 0; audited. | M |
| FR-076 | Bill lifecycle: **Draft → Finalized → Void**. Draft is editable (discount only); Finalized amounts are immutable at the application **and** database level. | M |
| FR-077 | Correcting a Finalized bill is done only by voiding it (Owner/Manager, mandatory reason, audited, bill number retained and shown as VOID) and issuing a new bill. Nothing is deleted. | M |
| FR-078 | Printable bill view (browser print, thermal-width 80 mm and A4 friendly CSS). | M |
| FR-079 | Downloadable PDF invoice, generated server-side from the finalized snapshot; regenerating gives identical amounts. | M |
| FR-080 | Payment record: method (Cash, Card, UPI, Other), amount, optional reference note, who recorded it, timestamp. Payment status: **Unpaid, Paid** (v1 requires paid amount = bill total; no partial payments). | M |
| FR-081 | Recording payment requires a Finalized bill; a bill cannot be paid twice; payments are append-only, corrections via audited reversal by Owner/Manager. | M |
| FR-082 | Money arithmetic uses exact decimal or integer minor units, never floating point; rounding rule configurable (none / nearest 0.50 / nearest 1) with the adjustment shown on the bill. | M |
| FR-083 | Bill/invoice emailed or shared to customer (link/WhatsApp/email). | C |
| FR-084 | Sales-by-day and sales-by-payment-method report (CSV export). | S |

### 7.7 Admin Dashboard (AD)

| ID | Requirement | Pri |
|---|---|---|
| FR-090 | Dashboard summary for Owner/Manager: total orders, pending orders, today's order count, today's sales (finalized+paid bills, reported separately from unpaid), active tables, recent orders. "Today" uses the restaurant's timezone. | M |
| FR-091 | Navigation sections: Dashboard, Orders, Kitchen, Tables & QR, Menu, Billing, Staff, Settings, Audit log (visibility by role). | M |
| FR-092 | Dashboard numbers exclude Cancelled orders and Void bills; definitions documented in-app (tooltip/help). | M |
| FR-093 | Responsive layout usable on phone, tablet and desktop. | M |
| FR-094 | Empty, loading and error states for every list and screen. | M |

### 7.8 Authentication, Roles and Staff (AU)

| ID | Requirement | Pri |
|---|---|---|
| FR-100 | Staff authenticate with email + password through a trusted managed auth provider; passwords are never handled/stored by custom code. | M |
| FR-101 | Invite-based staff creation; invite links are single-use and expire (default 72 h). | M |
| FR-102 | Password reset via emailed one-time link with expiry; no account-existence disclosure on login/reset forms. | M |
| FR-103 | Brute-force protection: rate limiting and temporary lockout/back-off on login and reset. | M |
| FR-104 | Sessions expire (idle and absolute), can be revoked; staff can sign out everywhere; deactivating a user revokes access immediately. | M |
| FR-105 | Multi-factor authentication available (TOTP); **mandatory for Super Admin**, recommended for Owner. | M (SA) / S (Owner) |
| FR-106 | Roles: Platform Super Admin, Restaurant Owner, Restaurant Manager, Kitchen Staff, Billing Staff, with permissions per §8. Roles are determined **server-side**; client-sent role data is never trusted. | M |
| FR-107 | A user belongs to exactly one restaurant in v1 (Super Admin belongs to none). | M |
| FR-108 | Owner can create, edit role of, deactivate and reactivate staff of their own restaurant; cannot elevate anyone above Owner, cannot remove the last active Owner. | M |
| FR-109 | Managers can manage Kitchen and Billing staff only (not other Managers/Owners) (see Q-10). | S |
| FR-110 | Users never hard-deleted while they appear in audit/financial records; deactivation is used. | M |

### 7.9 Audit Logging and Super Admin (AL)

| ID | Requirement | Pri |
|---|---|---|
| FR-120 | Append-only audit log records: actor, role, restaurant, action, target entity + ID, before/after summary (no secrets), timestamp, IP/user-agent where appropriate. | M |
| FR-121 | Audited events include: login success/failure/lockout, password/MFA changes, staff and role changes, menu price changes, availability changes, table and QR rotation, order cancellation/revert, discount application, bill finalize/void, payment record/reversal, settings/tax changes, data exports, Super Admin tenant actions. | M |
| FR-122 | Owner/Manager can view their own restaurant's audit log (Manager: limited event types); nobody can edit or delete entries via the application. | M |
| FR-123 | Any Super Admin access to a specific restaurant's business data must be explicit, time-limited, reason-recorded and audited ("support access"), and visible to the Owner. | S |
| FR-124 | Super Admin can suspend/reactivate a restaurant and trigger a data export. | M |

### 7.10 Data Export and Offboarding (DX)

| ID | Requirement | Pri |
|---|---|---|
| FR-130 | Owner (or Super Admin on request) can export all restaurant data (menu, tables, orders, bills, payments, customers' contact fields) in open formats (CSV/JSON) plus PDFs of finalized bills. | M |
| FR-131 | Offboarding procedure: suspend → export delivered → retention period → deletion/anonymisation of personal data, while financial records follow the retention policy agreed contractually. | M |
| FR-132 | Customer-contact data retention setting (e.g., auto-anonymise after N days; default to be decided, Q-05). | S |

## 8. Role Permission Matrix (v1 proposal)

Legend: **C**reate · **R**ead · **U**pdate · **D**elete/archive · — none. "Own" = own restaurant only. Super Admin has *no default access to tenant business data* (only platform metadata).

| Capability | Super Admin | Owner | Manager | Kitchen | Billing |
|---|---|---|---|---|---|
| Restaurants (create/suspend/list) | CRUD | — | — | — | — |
| Restaurant profile & settings | R (metadata) | R U | R (no tax/billing settings U) | — | R (bill header only) |
| Tax / currency / bill numbering settings | — | R U | R | — | R |
| Staff & roles | — | C R U D(deactivate) all roles | C R U D Kitchen/Billing only* | — | — |
| Tables | — | C R U D | C R U D | R | R |
| QR codes (view/print/rotate) | — | R + rotate | R + rotate | — | — |
| Menu categories & items | — | C R U D | C R U D | R + toggle availability | R |
| Orders — view | — | R | R | R (no customer contact) | R |
| Orders — status changes | — | Any allowed transition + cancel + revert | Any allowed transition + cancel + revert | Accept, Preparing, Ready; cancel Pending/Accepted with reason | Mark Served |
| Bills — create draft / finalize | — | C R | C R | — | C R U(finalize) |
| Bills — apply discount | — | Yes | Yes (limit configurable*) | — | No (unless granted*) |
| Bills — void | — | Yes | Yes | — | No |
| Payments — record | — | Yes | Yes | — | Yes |
| Payments — reverse | — | Yes | Yes | — | No |
| Dashboard/sales summary | Platform-level counts only | R | R | Order counts only | Sales of billed orders |
| Customer contact details | — | R | R | — | R (for bill delivery) |
| Audit log | Platform events | R (all) | R (limited) | — | — |
| Data export | Trigger on request | Yes | — | — | — |

\* Items marked with an asterisk are open decisions (Q-10, Q-12). The definitive matrix will be encoded once and enforced identically in API and database policies (Stage 2), with automated tests per cell.

## 9. Non-Functional Requirements

### 9.1 Security (NFR-S)

| ID | Requirement |
|---|---|
| NFR-S01 | **Tenant isolation is enforced in both the application layer and the database** (row-level security or equivalent). A bug in one layer must not by itself cause a cross-tenant leak. |
| NFR-S02 | Every non-public API request authenticates the caller and authorizes (role + tenant + object ownership) server-side. Restaurant ID supplied by a client is never a source of authority. |
| NFR-S03 | All input validated against schemas server-side; all DB access via parameterized queries/ORM. |
| NFR-S04 | All user-generated text (item names, instructions, restaurant name, contact fields) is treated as untrusted: output-encoded in UI, safely escaped in PDFs/CSV (formula-injection safe). |
| NFR-S05 | HTTPS everywhere with HSTS; secure headers (CSP, X-Content-Type-Options, frame-ancestors, Referrer-Policy); strict CORS allow-list; secure, HttpOnly, SameSite cookies where cookies are used; CSRF protection where cookie auth is used. |
| NFR-S06 | Rate limiting on: login, reset, invite acceptance, public order endpoint, public menu endpoint, uploads. |
| NFR-S07 | File uploads: allow-listed content types verified by content, size cap, re-encoded, random storage names, per-tenant paths, no executable content served from the app origin. |
| NFR-S08 | No secrets in source control or the frontend bundle; separate secrets per environment; documented rotation. |
| NFR-S09 | Error responses do not leak stack traces, SQL or internal identifiers. |
| NFR-S10 | Finalized bills, payments and audit logs are protected from modification at the database level (constraints/triggers/permissions), not only in code. |
| NFR-S11 | Automated dependency vulnerability scanning in CI; critical/high findings block release. |
| NFR-S12 | Personal data minimisation: collect only fields the restaurant enables; do not log full contact details; encrypt in transit and at rest (provider-managed). |
| NFR-S13 | QR tokens are cryptographically random, ≥128 bits, stored hashed where feasible, and revocable. |

### 9.2 Data Integrity and Reliability (NFR-D / NFR-R)

| ID | Requirement |
|---|---|
| NFR-D01 | Money uses exact decimal/minor-unit types end to end. |
| NFR-D02 | Order creation, bill finalization and payment recording are transactional and idempotent. |
| NFR-D03 | Referential integrity via foreign keys; uniqueness via constraints (per-restaurant table label, order number, bill number). |
| NFR-D04 | Financial-history records are never physically deleted by application code. |
| NFR-D05 | Timestamps stored in UTC and shown in the restaurant's timezone. |
| NFR-D06 | Migrations are versioned, reviewed, tested on staging, and reversible or accompanied by a documented rollback. |
| NFR-R01 | Availability target (best-effort, not contractual SLA): **99.5 %** monthly for customer ordering and dashboards. |
| NFR-R02 | Automated daily backups with **RPO ≤ 24 h** (target ≤ 1 h if point-in-time recovery is affordable) and **RTO ≤ 4 h**; restore is **tested** before go-live and at least quarterly. |
| NFR-R03 | Graceful degradation: if realtime fails, polling takes over; if image storage fails, the menu still works without images. |
| NFR-R04 | Health checks, uptime monitoring, error tracking and alerting to the operator on outage, error spikes and approaching quota/cost limits. |

### 9.3 Performance and Capacity (NFR-P)

Initial sizing assumption: 10 restaurants × up to 40 tables; peak ≈ 100 concurrent menu viewers and ≈ 10 orders/minute per restaurant at busiest; ≈ 1,000 concurrent viewers platform-wide worst case.

| ID | Requirement |
|---|---|
| NFR-P01 | Public menu: Largest Contentful Paint ≤ 2.5 s and interactive ≤ 3.5 s on a mid-range phone over 4G; initial JS for the public menu route ≤ ~150 KB gzipped (target, to be validated). |
| NFR-P02 | API p95 latency ≤ 300 ms (excluding image upload and PDF generation) under the sizing load. |
| NFR-P03 | Order placement end-to-end ≤ 2 s at p95. |
| NFR-P04 | New order visible on dashboard ≤ 5 s at p95. |
| NFR-P05 | PDF invoice generation ≤ 3 s. |
| NFR-P06 | Uploaded images are resized/compressed and served in modern formats with caching. |
| NFR-P07 | System handles 3× sizing load in load tests without errors or data inconsistency. |

### 9.4 Usability and Accessibility (NFR-U)

| ID | Requirement |
|---|---|
| NFR-U01 | Meets WCAG 2.1 AA for customer and staff screens (contrast, focus, labels, keyboard, screen reader basics). |
| NFR-U02 | Touch targets ≥ 44 px; kitchen screen legible at arm's length. |
| NFR-U03 | Supports latest two versions of Chrome, Safari (iOS), Firefox, Edge, and Android Chrome; degrades gracefully on older browsers. |
| NFR-U04 | A new restaurant owner completes onboarding (profile, 1 table, 1 category, 1 item, QR print) in ≤ 30 minutes unassisted (usability target). |
| NFR-U05 | Clear plain-language errors; destructive actions require confirmation. |

### 9.5 Maintainability and Operations (NFR-M / NFR-O)

| ID | Requirement |
|---|---|
| NFR-M01 | TypeScript throughout; strict mode; linting and formatting enforced in CI. |
| NFR-M02 | Automated test suites (unit, integration, API, DB/RLS, E2E) run in CI; release blocked on failures. |
| NFR-M03 | Separate development, staging and production environments with separate credentials and data. |
| NFR-M04 | One-command local setup documented; documentation kept in sync with code. |
| NFR-O01 | Structured logging with correlation IDs; no secrets or full personal data in logs. |
| NFR-O02 | Documented deployment, rollback, backup/restore, incident and offboarding runbooks. |
| NFR-O03 | Cost dashboard/alerts against a monthly hosting budget. |

### 9.6 Privacy and Compliance-Readiness (NFR-C)

| ID | Requirement |
|---|---|
| NFR-C01 | Customer contact data collected only with a visible purpose notice; no marketing use in v1. |
| NFR-C02 | Configurable retention/anonymisation and per-customer deletion on request (by restaurant Owner). |
| NFR-C03 | Designed to *support* a data-protection review (e.g., India DPDP Act, GDPR if applicable); **legal review required** before commercial launch; no compliance claim is made. |

## 10. Business Rules

| ID | Rule |
|---|---|
| BR-TEN-01 | Every restaurant-owned record carries the restaurant ID; cross-restaurant references are impossible by constraint. |
| BR-TEN-02 | A staff user acts only within their own restaurant; Super Admin does not operate restaurant business workflows. |
| BR-ORD-01 | Prices/totals on an order are computed server-side from database state at placement time and snapshotted on order lines. |
| BR-ORD-02 | An order cannot be placed for an inactive table, unavailable/hidden/archived item, or when the restaurant is not accepting orders. |
| BR-ORD-03 | Order status follows the transitions in FR-053; terminal states cannot be changed except by audited Owner/Manager "revert one step" from *Served* only if unbilled (see Q-09). |
| BR-ORD-04 | An order cannot be cancelled once a Finalized, non-void bill references it. |
| BR-ORD-05 | Order number is unique per restaurant, immutable and never reused. |
| BR-ORD-06 | A maximum items-per-order and quantity-per-line limit applies to limit abuse (defaults configurable). |
| BR-TBL-01 | Table labels are unique per restaurant (case-insensitive). |
| BR-TBL-02 | Tables/menu items/categories/users with history are archived, never hard-deleted. |
| BR-BILL-01 | A bill covers only non-cancelled orders of one restaurant. An order can belong to at most one non-void bill. |
| BR-BILL-02 | Finalized bill amounts, lines, taxes and numbers are immutable; only status transitions to Void and payment recording are allowed. |
| BR-BILL-03 | Bill numbers are gap-free and never reused, including voided ones. |
| BR-BILL-04 | Tax = computed per configured components on the post-discount taxable amount using inclusive/exclusive mode; rounding rules applied consistently and shown. |
| BR-BILL-05 | Discount cannot exceed the bill subtotal; requires reason and permission. |
| BR-BILL-06 | Payment recorded must equal the bill total (v1); a Void bill cannot receive payment; a Paid bill cannot be voided without first reversing the payment (Owner/Manager, audited). |
| BR-BILL-07 | Customers never have access to bill mutation; they may only view/download their own bill if sharing is enabled (C-priority). |
| BR-BILL-08 | Tax names, rates, registration numbers and invoice wording are the **restaurant's responsibility** to configure correctly; DineFlow ships neutral defaults and a "verify with your accountant" notice. |
| BR-USR-01 | A restaurant must always have at least one active Owner. |
| BR-USR-02 | Deactivated users lose access immediately but remain in historical records. |
| BR-QR-01 | Rotating a QR token invalidates the previous token immediately; an already-placed order is unaffected. |
| BR-DATA-01 | Audit log entries are append-only. |
| BR-DATA-02 | Financial records (orders, bills, payments) are retained for the contractually agreed period (to be decided with legal advice), even after suspension. |

## 11. User Stories and Acceptance Criteria

Acceptance criteria use Given/When/Then. Each story maps to requirement IDs.

### Restaurant & Onboarding
**US-01** As a Super Admin, I want to provision a restaurant and invite its owner so that I can onboard a customer quickly. *(FR-001, 002, 007, 009)*
- Given I am a Super Admin with MFA, when I create a restaurant with name and owner email, then a restaurant with unique ID is created in *Provisioning* state and an invite email is sent.
- Given an invite older than 72 h or already used, when opened, then it is rejected with a generic message.
- Given anyone not a Super Admin, when calling the create-restaurant API, then it returns 403 and creates nothing.

**US-02** As an Owner, I want a guided setup so that I can be ready to take orders without help. *(FR-003–008)*
- Given a new Owner, when they finish the wizard with valid data, then the restaurant becomes *Active* and the checklist shows tables/menu/QR status.
- Given required fields missing/invalid, then inline errors appear and nothing partial is saved incorrectly.

### Tables & QR
**US-03** As a Manager, I want to create tables and print QR codes. *(FR-010–017)*
- Given table label "12" exists, when I create another "12" (any case), then I see a duplicate-label error.
- Given a table with orders, when I try to delete it, then it is archived instead and its history is intact.
- Given I rotate a QR, when the old QR is scanned, then a friendly "QR no longer valid" page appears and no data is leaked; the new QR works.
- Given Restaurant A's QR token, when tampered with or replaced with a token/ID from B, then only B's valid token shows B's menu; guessed/invalid tokens show "not found" with identical response timing/shape.

### Menu
**US-04** As an Owner, I want to manage categories and items so customers see accurate menus. *(FR-020–028)*
- Given I set price 249.00, when saved, then the public menu shows 249.00 within 30 s.
- Given a negative or non-numeric price, then save is rejected.
- Given I upload a `.exe` renamed `.jpg`, or an oversize image, then upload is rejected; a valid image is stored re-encoded under my restaurant's path only.
- Given an item is Unavailable, then it shows "Sold out" and the order API rejects it even if the client tries.
- Given an item used in past orders, when I remove it, then it is archived and old orders/bills still show the original name/price.

**US-05** As Kitchen Staff, I want to mark an item sold out quickly. *(FR-024)*
- Given Kitchen role, when toggling availability, then only availability changes; attempts to change price return 403.

### Customer ordering
**US-06** As a customer, I want to scan and order without an account. *(FR-030–042)*
- Given a valid QR, when scanned, then I see the correct restaurant/table and menu on mobile.
- Given I add 2 items and place the order, then I get an order number, a server-computed total and a live status.
- Given I tamper with the request (changed price/total, another restaurant's item ID, negative quantity, quantity 10,000), then the server ignores/rejects it and creates no incorrect order.
- Given I double-tap Place Order or resubmit on a flaky network, then exactly one order exists.
- Given an item became unavailable after I added it, when I submit, then the order is rejected with a clear message and my cart remains.
- Given restaurant "not accepting orders", then Place Order is disabled and the API rejects submissions.
- Given a mobile number is required by policy, when I enter an invalid number, then I see an inline error.
- Given >N submissions/minute from one IP/table, then further requests are throttled with a friendly message.

### Orders & Kitchen
**US-07** As a Kitchen Staff member, I want to see and progress orders. *(FR-050–058)*
- Given a customer places an order, then it appears on my screen ≤ 5 s with sound; if the connection drops, the UI shows "reconnecting" and recovers without missing orders.
- Given a Pending order, when I click *Accepted → Preparing → Ready*, then each change is recorded with my identity and time.
- Given I try Pending→Served or Ready→Pending via API, then 409/403 is returned.
- Given two staff act on the same order simultaneously, then one succeeds and the other sees a conflict message.
- Given Restaurant A staff request an order ID from Restaurant B, then the response is 404/403 with no data.

### Billing
**US-08** As Billing Staff, I want to produce an accurate bill and record payment. *(FR-070–082)*
- Given an order of 2×₹100 and 1×₹50 with 5 % tax exclusive and no discount, then subtotal 250.00, tax 12.50, total 262.50 (rounding per setting), all shown consistently on screen, print and PDF.
- Given I finalize, then the bill number is assigned (gap-free) and amounts cannot be changed via UI, API or direct DB update by the application role.
- Given a menu price changes after finalization, then the finalized bill is unchanged.
- Given I record Cash payment for the total, then status becomes Paid; a second payment attempt is rejected.
- Given Billing role attempts a discount or void without permission, then 403.
- Given two people finalize the same order simultaneously, then only one bill is created.
- Given PDF is downloaded twice, then both show identical amounts and bill number.

### Dashboard
**US-09** As an Owner, I want a simple daily overview. *(FR-090–094)*
- Given 5 orders today (1 cancelled) and 3 paid bills, then total orders/today count/sales figures match documented definitions and exclude cancelled/void.
- Given midnight in the restaurant's timezone passes, then "today" resets accordingly.

### Users & roles
**US-10** As an Owner, I want to manage staff roles. *(FR-100–110)*
- Given I deactivate a staff member, then their active sessions stop working immediately.
- Given I try to demote/remove the only Owner, then it is rejected.
- Given a Manager tries to create an Owner via API, then 403.
- Given a user edits client-side role data, then server permissions remain unchanged.

### Audit
**US-11** As an Owner, I want an audit trail. *(FR-120–122)*
- Given any listed sensitive action, then an audit entry with actor/time/target exists.
- Given any user (including Owner) attempts to modify or delete an audit entry via API/DB application role, then it is denied.

### Security
**US-12** As the platform operator, I want isolation guarantees I can verify. *(NFR-S01–S03)*
- Given automated cross-tenant tests (per endpoint × role × object type), then 100 % return no foreign data.
- Given direct database access using an ordinary tenant user's credentials, then row-level security prevents reading/writing other tenants' rows.

### Offboarding
**US-13** As an Owner, I want to export my data. *(FR-130–131)*
- Given I request an export, then I receive a file containing only my restaurant's data, and the request is audited.

## 12. Assumptions

| ID | Assumption |
|---|---|
| A-01 | Primary market is **India**: default currency INR, timezone Asia/Kolkata, payment methods Cash/Card/UPI, tax component labelled generically (GST-style configuration possible). All are configurable per restaurant. |
| A-02 | Each restaurant is a **single outlet**; one Owner-level account owns it. |
| A-03 | Customers order **dine-in only**; they are physically at the table. |
| A-04 | Restaurants have at least one device (phone/tablet/PC) with internet at the counter/kitchen. |
| A-05 | English-only UI in v1. |
| A-06 | Payment is collected outside the system (cash counter, card machine, UPI QR); DineFlow only **records** it. |
| A-07 | Staff acceptance of an order (Pending→Accepted) is the safeguard against fake or prank orders placed by someone not actually at the table. |
| A-08 | A bill can cover **one or more orders from the same table** (recommended because customers often order in rounds); to be confirmed (Q-06). |
| A-09 | Menu items have no variants/add-ons in v1; customisation is via special instructions. |
| A-10 | Restaurants are responsible for correct tax configuration and invoice content in their jurisdiction. |
| A-11 | Volume: ≤ ~10 restaurants, ≤ ~40 tables each, ≤ ~500 orders/day each. |
| A-12 | Managed services (e.g., Supabase, Vercel or equivalent) will be used; final selection happens in Stage 2 with cost/trade-off analysis. |
| A-13 | You (Super Admin) operate the platform alone and provide first-line support. |
| A-14 | Owner retains ownership of the source code; restaurants receive a perpetual right to use the hosted service/software (to be legally defined, see §17 Q-14). |
| A-15 | Customer contact details are collected only for order follow-up/bill delivery, not marketing. |

## 13. Risks

| ID | Risk | Impact | Mitigation (planned) |
|---|---|---|---|
| R-01 | **Cross-tenant data leak** through a coding error. | Critical | Defence in depth: server checks + database RLS; automated isolation tests in CI; code review checklist. |
| R-02 | **Prank/abusive orders** via QR photographed and used remotely, or bots flooding orders. | High | Opaque revocable QR tokens, rate limits, bot challenge, staff acceptance step, restaurant "pause ordering" switch, optional table-session code (Stage 2 decision). |
| R-03 | Price manipulation/order tampering. | High | Server-side pricing only; negative tests. |
| R-04 | Duplicate orders on flaky mobile networks. | High | Idempotency keys + unique constraints. |
| R-05 | **Tax/legal non-compliance** of bills in a restaurant's jurisdiction. | High | Configurable tax model, clear disclaimers, legal/accountant review, no compliance claims. |
| R-06 | **One-time revenue vs. recurring cost** — hosting/support costs outlive the 1–2 year bundle or exceed budget. | High | Cost model and caps in Stage 2; hosting term and renewal terms in the license; low-cost managed services; usage alerts. |
| R-07 | Free-tier limitations (e.g., projects pausing when idle, no backups, storage/bandwidth caps) unsuitable for production. | High | Choose paid tiers where required for backups/uptime; budget them; document. |
| R-08 | Data loss / failed backup restore. | Critical | Automated backups, tested restores, PITR if affordable, export procedure. |
| R-09 | Restaurant internet outage (orders not visible). | Medium | Connection-state indicator, polling fallback, fallback procedure documented (staff take orders manually). No offline mode in v1. |
| R-10 | Personal-data regulations (DPDP/GDPR) for customer phone/email. | Medium–High | Data minimisation, consent notice, retention/erasure, legal review. |
| R-11 | Sole-operator dependency (support, incidents). | Medium | Runbooks, monitoring/alerts, simple architecture, documented support hours in license. |
| R-12 | Scope creep toward full POS/accounting. | Medium | Strict out-of-scope list; change control through paid customisation. |
| R-13 | Malicious uploads/XSS via menu content. | Medium | Upload validation/re-encoding, output encoding, CSP. |
| R-14 | Staff misuse (discounting, voiding to pocket cash). | Medium | RBAC, mandatory reasons, immutable finalized bills, audit log, void visibility. |
| R-15 | Third-party service outage or pricing/terms change. | Medium | Standard tech (PostgreSQL) to allow migration; export tooling; minimal vendor-specific lock-in. |
| R-16 | Weak restaurant staff devices/browsers. | Low–Med | Broad browser support, lightweight kitchen screen. |

## 14. Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| Managed PostgreSQL + auth provider (candidate: Supabase) | Data, auth, storage, realtime | Tier/cost/backups decided in Stage 2. |
| Frontend hosting (candidate: Vercel or equivalent) | React app delivery, HTTPS | Stage 2. |
| Backend hosting (candidate: Render/Railway/Fly or equivalent) | Express API | Only if a separate API is chosen; trade-offs in Stage 2. |
| Domain name and DNS | Product URL, QR codes encode this domain | QR codes printed and laminated → domain must be stable long-term. **Decide domain early.** |
| Transactional email provider | Invites, password reset | Deliverability (SPF/DKIM). |
| Error tracking and uptime monitoring | Operations | Low-cost tiers. |
| Bot-protection service (e.g., Turnstile) | Abuse control | Free tier likely. |
| Legal professional | License, privacy notice, T&Cs | Before first sale. |
| Accountant / tax adviser (per restaurant) | Tax configuration review | Restaurant responsibility. |
| Pilot restaurant(s) | UAT and feedback | Recommend 1–2 friendly pilots before wider rollout. |

## 15. Success Metrics

| Metric | Target |
|---|---|
| Onboarding time (provision → first live order) | ≤ 1 working day |
| Order placement success rate (valid requests) | ≥ 99 % |
| Duplicate orders from double submits | 0 in tests and pilot |
| Cross-tenant leakage findings (tests, review) | 0 |
| Public menu LCP on 4G mid-range phone | ≤ 2.5 s |
| New-order-to-dashboard latency (p95) | ≤ 5 s |
| Bill arithmetic mismatches (screen vs PDF vs stored) | 0 |
| Monthly availability | ≥ 99.5 % |
| Restore drill | Successful within RTO before go-live and quarterly |
| Pilot restaurant satisfaction (simple survey) | ≥ 4/5 |
| Support tickets per restaurant per month after month 2 | ≤ 2 |
| Monthly hosting cost per restaurant | Within budget (Q-03) |
| Open critical/high defects at release | 0 |

## 16. Future Roadmap (post-v1, indicative)

- **v1.1:** item variants/add-ons; partial/split payments; bill sharing via link/WhatsApp/email; customer self-cancel; sales reports and CSV export; multi-language menu.
- **v1.2:** online payments (UPI/gateway) with reconciliation; waiter call / request-bill; kitchen-printer (KOT) support; inventory-lite (stock counts).
- **v2:** takeaway/delivery ordering; multi-outlet chains; customer accounts/loyalty/coupons; analytics; POS hardware integration; white-label custom domains; automated tenant self-signup with subscription billing; e-invoicing integrations where required.

## 17. Unresolved Questions

**Product and commercial**
- **Q-01 Onboarding model:** Invite-only (you provision each restaurant) — my recommendation for 10 sales — or public self-signup?
- **Q-02 Country/currency/tax:** Confirm India-first (INR, GST-style configurable tax). Are any restaurants outside India? Any need for GSTIN display, HSN/SAC codes, or e-invoicing in v1?
- **Q-03 Budget:** What is your maximum monthly infrastructure budget in total and per restaurant? Are you willing to pay for a paid database tier (needed for reliable backups and no idle-pause)?
- **Q-04 Domain and brand:** Do you already own a domain? QR codes are printed, so the domain must be permanent. Will each restaurant use `dineflow.example/r/<slug>` (shared domain) or want its own domain later?
- **Q-05 Customer data:** Should contact info be mandatory per restaurant setting, and what default retention period for customer phone/email (e.g., 90 days, 1 year, until deleted)?
- **Q-14 Licensing:** Is the intent that restaurants get a *right to use* the hosted service while you retain code ownership (recommended), or do any expect source-code delivery/self-hosting? This drives licensing and architecture (single shared deployment vs. per-customer deployments).

**Functional**
- **Q-06 Billing unit:** May one bill cover multiple orders from the same table visit (recommended), or strictly one bill per order as literally stated?
- **Q-07 Variants/add-ons:** Is "special instructions" text enough for v1, or do target restaurants need sizes/add-ons with price changes?
- **Q-08 Payments:** Are partial payments, split bills or tips required in v1? (Assumed no.)
- **Q-09 Order corrections:** May Owner/Manager revert a status by one step? May staff edit items after placement? (Assumed: revert allowed, item edits deferred.)
- **Q-10 Role details:** Can Managers manage staff? Can Billing Staff apply discounts? Should there be a separate **Waiter/Floor Staff** role to mark orders Served (currently Manager/Billing do it)?
- **Q-11 Language:** English only, or must the customer menu support Hindi/regional languages at launch?
- **Q-12 Discount policy:** Percentage cap for Manager-applied discounts? Need Owner approval above a threshold?
- **Q-13 Order numbering:** Continuous sequence per restaurant, or reset daily (e.g., #001 each day)? Financial-year bill series reset?
- **Q-15 Fake-order defence:** Is staff acceptance a sufficient safeguard, or do you also want a per-table short code/PIN shown on the table for customers to enter before ordering?
- **Q-16 Operating hours:** Should the menu auto-disable ordering outside configured hours, or only the manual toggle?
- **Q-17 Kitchen alerts:** Is an audible alert in the browser acceptable (requires a user tap to enable audio on some browsers), or is push/notification hardware expected?
- **Q-18 Veg/non-veg and allergen info:** Include veg/non-veg icon (assumed yes) and allergen tags (assumed no)?

**Operational**
- **Q-19 Support:** What support hours, response times and duration will you promise in the license? Who handles restaurant staff training?
- **Q-20 After the bundled hosting period:** Renewal price/terms, or migration/hand-over?
- **Q-21 Pilot:** Do you have 1–2 restaurants available for a supervised pilot before full rollout?

## 18. Proposed Development Sequence

| Stage | Deliverable | Gate |
|---|---|---|
| 1 | This PRD | **Your approval** |
| 2 | Technical design: architecture options and trade-offs (Supabase-only vs. Express API + Supabase vs. Edge Functions), database schema + ERD + RLS design, API design, auth/RBAC and tenant isolation design, threat model, test strategy, folder structure, hosting/cost model, licensing framework draft | **Your approval** |
| 3 | UI/UX design system, base layout, reusable components, accessibility checks | Approval |
| 4 | Modules, each with Plan → Implement → Test → Review, and approval between modules: (1) project foundation & CI, (2) authentication, (3) restaurant onboarding, (4) database integration & migrations, (5) tenant isolation + isolation test suite, (6) dashboard shell, (7) tables, (8) QR generation, (9) menu management, (10) public QR menu, (11) cart & ordering, (12) order dashboard, (13) kitchen workflow, (14) billing & PDF, (15) staff roles & permissions, (16) audit logs, (17) error handling & performance, (18) deployment config | Per-module approval |
| 5 | Release readiness: full regression, security review, load test, backup/restore drill, deployment/rollback rehearsal, documentation, pilot | Go/no-go |

**Recommended adjustments to your module order (for Stage 2 discussion):** do tenant isolation and the RLS test harness *together with* the first database migration (not after authentication and onboarding), and add CI/test scaffolding in module 1, so every later module inherits the isolation tests from day one.

## 19. Traceability Note

Requirement IDs (FR-, NFR-, BR-, US-, R-, A-, Q-) will be referenced in the technical design, test cases and release checklist to show that every requirement has a design element and at least one test.

---

**Approval request:** Please review this PRD, answer or delegate the open questions in §17 (or confirm the stated assumptions in §12), and reply **"PRD approved"** (with any changes). Work on Stage 2 (technical design) will not begin until then, and no application code will be written before that.
