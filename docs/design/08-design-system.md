# DineFlow — Stage 3: UI/UX Design System

| | |
|---|---|
| **Version** | 0.1 (for approval) |
| **Scope** | The design language and component contract. Implementation lands with the web scaffold in module 5; nothing here has been rendered or tested yet. |
| **Constraint** | Three audiences with different physical conditions: a customer on their own phone, staff on a counter tablet, and a kitchen screen read from arm's length with wet hands. One token set, three densities. |

---

## 1. Principles

1. **Legible before pretty.** The kitchen screen is read across a room; the bill is read by someone checking money. Contrast and size win over decoration.
2. **One obvious action per screen.** Staff use this during a rush. The primary action is visually unmistakable and never adjacent to a destructive one.
3. **Show system state honestly.** Live/reconnecting, saved/unsaved, draft/finalized, online/offline. Never a spinner with no explanation.
4. **Destructive and financial actions ask.** Cancel, void, discount and delete require confirmation and a reason where the rules demand one.
5. **Money is typeset, not styled.** Tabular figures, right-aligned, one currency format per restaurant, identical on screen, print and PDF.
6. **Accessible by construction.** Components ship with labels, focus states and roles; a component that cannot be operated by keyboard is not done.
7. **Restaurant branding is a accent, not a theme.** Their logo and one accent colour appear on the customer menu and bill. Contrast is enforced by the system, so a bad brand colour cannot make text unreadable.

## 2. Tokens

Tokens are CSS custom properties on `:root`, consumed by Tailwind through its theme config. Nothing in a component references a raw hex value.

### 2.1 Colour

Neutrals carry the interface; one brand hue carries identity; status colours are reserved for status.

```css
:root {
  /* neutrals (slate-based, warm-neutral) */
  --df-bg:            #f7f8fa;   --df-surface:      #ffffff;
  --df-surface-2:     #f1f3f7;   --df-border:       #dfe3ea;
  --df-text:          #11151c;   --df-text-muted:   #5a6474;
  --df-text-inverse:  #ffffff;

  /* brand (product default; per-restaurant accent overrides --df-accent only) */
  --df-brand:         #1f6f5c;   --df-brand-hover:  #185a4a;
  --df-brand-subtle:  #e6f2ee;
  --df-accent:        var(--df-brand);

  /* status */
  --df-success:       #17683f;   --df-success-bg:   #e6f4ec;
  --df-warning:       #8a5a00;   --df-warning-bg:   #fdf2dc;
  --df-danger:        #a3231f;   --df-danger-bg:    #fbeae9;
  --df-info:          #1b5a97;   --df-info-bg:      #e7f0f9;

  /* order status — deliberately distinct in hue AND shape/label, never colour alone */
  --df-status-pending:   var(--df-warning);
  --df-status-accepted:  var(--df-info);
  --df-status-preparing: #6a4bab;
  --df-status-ready:     var(--df-success);
  --df-status-served:    var(--df-text-muted);
  --df-status-cancelled: var(--df-danger);

  --df-focus:         #1b5a97;   /* 3:1 against every surface it sits on */
}
```

Dark mode is defined for the **kitchen screen only** in v1 (it often runs in a dim corner and all night). Admin and customer screens are light. Dark tokens redefine surfaces and text under `[data-theme="dark"]`, never the semantics.

**Contrast rules (enforced, not aspirational):** body text ≥ 4.5:1, large text and icons ≥ 3:1, focus ring ≥ 3:1 against the adjacent surface. A restaurant's accent colour is passed through a contrast check on save; if text on it would fail, the system uses the accent for borders and fills only and keeps text at `--df-text`. Colour never carries meaning alone — every status has a label, and order-status chips differ in text as well as hue.

### 2.2 Typography

| Role | Token | Value |
|---|---|---|
| Family | `--df-font-sans` | `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numerals | `--df-font-numeric` | same family, `font-variant-numeric: tabular-nums` — mandatory for every money and quantity value |
| Print | `--df-font-print` | system sans at 11–12 pt, no webfont dependency |

Scale (rem, 16 px base): `xs .75 · sm .875 · base 1 · lg 1.125 · xl 1.25 · 2xl 1.5 · 3xl 1.875 · 4xl 2.25`.
Line height: 1.5 body, 1.25 headings. Weights: 400 body, 500 labels, 600 headings. Maximum measure 70 characters.

**Density variants:** `compact` (admin tables), `default` (forms, customer menu), `kitchen` (one step larger throughout, minimum 18 px body, 24 px order numbers).

### 2.3 Space, radius, elevation, motion

- Space scale (4 px base): `1=4 · 2=8 · 3=12 · 4=16 · 5=20 · 6=24 · 8=32 · 10=40 · 12=48`.
- Radius: `sm 4 · md 8 · lg 12 · full 9999`. Cards `lg`, controls `md`, chips `full`.
- Elevation: three levels only (`raised`, `overlay`, `modal`) as soft shadows; no shadow on printed output.
- Motion: 120 ms for state, 200 ms for entrances, ease-out; all animation disabled under `prefers-reduced-motion`. Nothing that blinks or flashes, with one exception: the new-order alert pulses twice at ≤ 2 Hz, which stays below the photosensitivity threshold.

### 2.4 Layout and breakpoints

| Breakpoint | Width | Primary use |
|---|---|---|
| `base` | < 640 px | Customer phone, staff phone |
| `sm` | ≥ 640 px | Large phone |
| `md` | ≥ 768 px | Tablet (counter, kitchen) |
| `lg` | ≥ 1024 px | Laptop admin |
| `xl` | ≥ 1280 px | Desktop admin |

Admin shell: sidebar on `lg+`, bottom tab bar below. Content max width 1200 px; forms max 640 px; the customer menu is a single column with a sticky cart bar. Side gutter 16 px on phones, never a horizontal scrollbar.

## 3. Component inventory

Every component ships with: all states (default, hover, focus-visible, active, disabled, loading, error, read-only), keyboard operation, an accessible name, and a documented prop contract. "Done" means all of those, not just the default state.

| Group | Components |
|---|---|
| **Primitives** | Button (primary/secondary/ghost/danger, sizes sm–lg, loading state that keeps width), IconButton, Input, NumberInput (quantity stepper with ± targets ≥ 44 px), Textarea, Select, Combobox, Checkbox, Radio, Switch, Label, FieldError, Hint, Currency input (minor-unit safe), Badge, Chip, Avatar, Spinner, Skeleton |
| **Layout** | AppShell (sidebar + topbar + content), Page (title, description, actions), Card, Section, Toolbar, Divider, Grid, Stack |
| **Data** | DataTable (sortable, sticky header, empty/loading/error states, mobile card fallback), DefinitionList, StatTile, Pagination, FilterBar, SearchInput |
| **Feedback** | Toast, InlineAlert, EmptyState (icon + explanation + primary action), ErrorState (with retry and request ID), ConfirmDialog, ReasonDialog (confirmation that requires a typed reason — used by cancel, void, discount) |
| **Domain** | OrderCard, OrderStatusChip, OrderTimeline, KitchenTicket, TableTile, MenuItemRow, MenuItemCard, CartLine, CartSummary, MoneyText, TaxBreakdown, BillDocument (screen + print), QrCard, QrSheet, RoleBadge, AuditRow, LiveIndicator |

### 3.1 Components that carry a rule, not just a look

- **MoneyText** — the only way money is rendered. Takes minor units plus currency; never a pre-formatted string. Tabular numerals, right-aligned in tables.
- **OrderStatusChip** — renders label + hue from one map, so a status can never be shown with the wrong colour in one place and the right one elsewhere.
- **ReasonDialog** — cancel, void and discount cannot be confirmed without a reason of a minimum length, mirroring the database rules.
- **LiveIndicator** — shows Live / Reconnecting / Offline with the time of the last successful update. Staff must be able to tell "no new orders" from "not receiving orders".
- **BillDocument** — one component renders the screen view, the print view and the data that goes to the PDF, so the three cannot disagree.

## 4. Key screen patterns

**Customer menu (phone).** Restaurant header (logo, name, table label), category strip that sticks on scroll, item rows with image thumbnail, name, description, price and veg/non-veg marker. Sold-out items are visibly disabled with a "Sold out" label, not merely faded. A sticky bar shows item count and estimated total and opens the cart. Every price comes from the server; the estimate is labelled as an estimate.

**Cart and checkout.** Editable quantities, per-item notes, order-level instructions, contact fields per restaurant policy with a short privacy line, server-computed totals, and one primary "Place order" button that becomes a loading state and cannot be double-tapped.

**Order confirmation.** Large order number, current status with a timeline, table label, and what to do if something is wrong ("speak to staff"). Polls quietly.

**Kitchen screen.** Dark, `kitchen` density, three columns (Pending, Preparing, Ready) or a single stacked list on a phone. Each ticket shows order number, table, items with quantities, notes, and an elapsed timer that changes colour at configurable thresholds. One primary action per ticket. New orders arrive with a sound and a brief pulse, and a banner appears if the connection drops.

**Order dashboard.** Filterable table on desktop, cards on mobile, with status chips, table, total, time and quick actions.

**Billing.** Order selection for a table, live totals panel showing subtotal, discount, service charge, each tax line and rounding, then finalize. After finalizing, the bill is visibly locked: fields become read-only text and the only actions are print, PDF, record payment and void.

**Printable bill.** 80 mm thermal and A4 stylesheets. Black on white, no shadows or background images, logo optional, tabular figures, bill number and content-hash short form in the footer, "DUPLICATE COPY" banner on reprints.

**QR sheet.** One card per table with the QR, table label and restaurant name, sized for laminating, with crop guides. While the domain is provisional, the sheet carries a "PROVISIONAL — DO NOT PRINT" watermark and printing is disabled (Q-04).

## 5. Accessibility contract (WCAG 2.1 AA target)

| Area | Rule |
|---|---|
| Keyboard | Every action reachable and operable; visible `focus-visible` ring; logical order; no keyboard traps; Escape closes overlays; focus returns to the trigger. |
| Targets | ≥ 44 × 44 px on touch, ≥ 24 px minimum spacing between adjacent destructive and primary actions. |
| Labels | Every input has a programmatic label; errors are associated via `aria-describedby`; required fields are marked in text, not by colour. |
| Status | Live regions announce new orders, save results and errors; `aria-live="polite"` for routine updates, `assertive` only for failures. |
| Colour | Never the sole carrier of meaning; contrast ratios per §2.1. |
| Motion | Honours `prefers-reduced-motion`; no flashing above 2 Hz. |
| Zoom | Usable at 200 % zoom and at 320 px width without horizontal scrolling. |
| Images | Menu photos are decorative and get empty alt text; the item name is the label. Logos carry the restaurant name. |
| Language | `lang` attribute set; the customer menu inherits the restaurant's language setting when multi-language arrives. |

**Verification:** axe-core on every screen in CI, a manual keyboard pass per module, and a screen-reader spot check (VoiceOver) before release. Automated checks catch perhaps half of real problems, so the manual passes are not optional.

## 6. Theming per restaurant

A restaurant supplies a logo and one accent colour. The system derives hover and subtle variants, runs the contrast check described in §2.1, and applies the accent to: the customer menu header, primary buttons on customer screens, and the bill header rule. Admin screens stay on the product palette so staff moving between restaurants (support) always see the same interface. There is no per-restaurant typography or layout in v1; that would multiply the testing surface for no operational gain.

## 7. Implementation notes (module 5)

- Tailwind configured to read the tokens; no arbitrary colour values allowed in components (lint rule).
- Components built on Radix primitives for dialog, popover, select, tooltip and switch (keyboard and ARIA behaviour comes for free and is tested upstream), styled by us and living in our repository.
- The customer menu route is bundled separately from the admin app so a phone on mobile data does not download admin code (NFR-P01).
- Icons from one set (Lucide), tree-shaken, always paired with text or an `aria-label`.
- A `/design` route renders every component in every state as a living reference and is the target for axe and visual checks.

## 8. What still needs your input

1. **Product palette.** The green above is a placeholder chosen for contrast and neutrality. If DineFlow has brand colours, say so now — changing them later is cheap, but printed material is not.
2. **Kitchen dark mode:** confirmed as the only dark surface in v1?
3. **Logo and product name treatment** for the landing page and bills.
