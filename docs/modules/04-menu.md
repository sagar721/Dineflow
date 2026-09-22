# Module 4 — Menu

What was built, how it is protected, and how to deploy it. Design sources: [design/01 §3.3, §6.3](../design/01-database.md), [design/00 §3.5](../design/00-architecture-and-decisions.md), PRD FR-020 … FR-028.

## Data

Migration `008_menu.sql` adds `menu_categories` and `menu_items`.

- **Tenancy.** Both carry `restaurant_id`. An item's category must belong to the same restaurant: a composite foreign key enforces it. RLS is enabled and forced on both tables.
- **Nothing is deleted** (FR-026). No role has `DELETE`: categories and items are archived instead. Orders will snapshot name and price when they are placed.
- **Prices** are `bigint` minor units, 0 … 10,00,000.00, checked in the database. They reach the API as decimal strings (`"249.50"`), never as floats.
- **Names** are unique among live rows, case-insensitively: categories per restaurant, items per category.
- **Image path** must match `restaurants/<own restaurant id>/menu/<32 hex>.webp`. This is a database check, so no row can point at another tenant's file.
- **Kitchen staff** may update `available` and nothing else. RLS lets them update the row; the trigger `app.menu_item_kitchen_limit` refuses any other column change.

| Role | Categories | Items | Public (QR token) |
|---|---|---|---|
| Owner, manager | read, create, update | read, create, update | — |
| Kitchen | read | read, availability only | — |
| Billing | read | read | — |
| Platform admin with a support grant | read | read | — |
| Customer | — | — | shown, live categories, and shown, live items in them; sold-out items included |

## API

No route accepts a restaurant id; the restaurant is taken from the session and RLS.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /restaurant/menu` | `menu.read` | Categories and items, archived ones flagged. Includes the currency. |
| `POST /restaurant/menu/categories` | `menu.write` | `{ name, visible? }` |
| `PATCH /restaurant/menu/categories/:id` | `menu.write` | `{ name?, visible?, archived?, version }` |
| `PUT /restaurant/menu/categories/order` | `menu.write` | `{ ids }`: every live category exactly once, or 409 |
| `POST /restaurant/menu/items` | `menu.write` | `{ categoryId, name, description?, price, diet?, visible?, available? }` |
| `PATCH /restaurant/menu/items/:id` | `menu.write` | Any of the above, plus `archived`, with `version` |
| `PATCH /restaurant/menu/items/:id/availability` | `menu.item.toggleAvailability` | `{ available }` only |
| `PUT /restaurant/menu/items/:id/image` | `menu.write` | `{ contentType, data }`, where `data` is base64 |
| `DELETE /restaurant/menu/items/:id/image` | `menu.write` | |
| `GET /public/tables/:token/menu` | none | Restaurant, table and menu. Same token rules, same generic 404 and same timing floor as `/public/tables/:token`. |

**Audit.** Each of these is recorded as its own entry:
- category created, renamed, hidden, shown, archived or restored;
- categories reordered;
- item created or updated;
- price change, with the old and new price;
- availability, visibility and archive changes;
- image added, replaced or removed.

**Freshness (FR-027).** The public menu is cached for 15 s per restaurant, and every staff change through the API clears that restaurant's entry. Customers see edits on their next scan, and never more than 15 s late.

## Image uploads (FR-023)

1. The file is sent as base64 inside JSON, so an upload passes the same CSRF checks as every other write. Only this route accepts a body larger than 100 kB (8 MB), and only when the request carries a session cookie.
2. The declared type must be JPEG, PNG or WebP, and must match the file's own signature bytes. File names are never accepted.
3. `sharp` decodes the file, refusing:
   - corrupt data;
   - anything over 40 megapixels, which stops decompression bombs before they are decoded;
   - a format that disagrees with the declared type.
4. The image is re-encoded as WebP of at most 1600 px. EXIF (including location), ICC, XMP and any trailing data are gone.
5. It is stored at `restaurants/<restaurant id>/menu/<random 128-bit name>.webp`. The old file is removed when a photo is replaced.

Limits: 5 MB decoded. Errors are 413 (too large) or 415 (type not allowed, contents don't match the type, or can't be read).

## Deploying

1. Migrations `006`, `007` and `008` are applied **locally only**. The API reads all three, so apply them together, once approved.
2. **Photos.** Create a **public** Supabase Storage bucket, for example `menu-images`, with a 5 MB limit and allowed types `image/webp`. Then set `MENU_IMAGE_BUCKET` on the API host.
   - Until then, photo upload answers 503 and the rest of the menu works.
   - The Storage calls are tested against an in-memory store. They have **not yet been exercised against the live bucket**.
3. Render installs `sharp`'s prebuilt Linux binary (`@img/sharp-linux-x64`), which is in the lockfile. No build step is needed.

### Rollback

Before any real menu is entered:
- drop `menu_items`, `menu_categories` and the `diet_type` type;
- drop the functions `app.menu_row_immutable` and `app.menu_item_kitchen_limit`;
- delete the `008_menu.sql` row from `schema_migrations`.

Once orders reference items, do not roll back.

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

- **Ordering** is now built in [module 5](05-ordering.md). The server refuses sold-out, hidden and archived items when an order is placed (FR-037), not only on the menu.
- **Historical snapshots** (an order keeping the name and price it was placed at) come with the orders table. Until then, "archived, never deleted" is what protects history.
- Item order within a category follows creation order. There are no move-up/down controls for items yet; category order is fully editable.
- Unreferenced photo files can remain if the server stops between storing a file and saving the row. They are harmless (random names) and can be swept by prefix later.
- No restaurant logo yet (FR-030 mentions one). It will use the same upload path.
