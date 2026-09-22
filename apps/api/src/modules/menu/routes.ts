// Menu categories and items (PRD FR-020 … FR-028; design/01 §3.3).
//
// Tenant scope comes from the authenticated membership and RLS, never from the
// request: no route accepts a restaurant id. Owners and managers shape the menu;
// kitchen staff may only mark items sold out or back in stock, which the database
// enforces too (trigger app.menu_item_kitchen_limit).
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { MoneyError, parseMoney, type Currency } from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';
import type { Logger } from '../../lib/logger.ts';
import { menuImageKey, type ImageStore } from '../../lib/image-store.ts';
import { ImageRejected, MAX_UPLOAD_BYTES, processMenuImage } from '../../lib/menu-image.ts';

export type MenuDeps = {
  db: Database;
  verify: Verifier;
  cookieSecure: boolean;
  logger: Logger;
  /** Null when no bucket is configured: uploads answer 503, everything else works. */
  imageStore: ImageStore | null;
  /** Cleared on every change, so customers see edits on their next scan. */
  menuCache: { invalidate(restaurantId: string): void };
};

/** The highest price accepted, in major units; matches the database check. */
export const MAX_PRICE_MAJOR = 1_000_000;

const id = z.string().uuid();
const categoryName = z.string().trim().min(1).max(60);
const itemName = z.string().trim().min(1).max(120);
const description = z.string().trim().max(1000).transform((value) => value || null);
// A string, never a number: "249.50" arrives exactly as typed, with no float in between.
const price = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter a price such as 249 or 249.50, with no minus sign.');
const diet = z.enum(['veg', 'non_veg', 'egg', 'none']);
const version = z.number().int().min(1);

const createCategoryBody = z.object({ name: categoryName, visible: z.boolean().optional() }).strict();
const updateCategoryBody = z
  .object({ name: categoryName.optional(), visible: z.boolean().optional(), archived: z.boolean().optional(), version })
  .strict();
const orderBody = z.object({ ids: z.array(id).min(1).max(500) }).strict();

const createItemBody = z.object({
  categoryId: id, name: itemName, description: description.nullish(), price, diet: diet.optional(),
  visible: z.boolean().optional(), available: z.boolean().optional(),
}).strict();
const updateItemBody = z.object({
  categoryId: id.optional(), name: itemName.optional(), description: description.nullish(), price: price.optional(),
  diet: diet.optional(), visible: z.boolean().optional(), available: z.boolean().optional(),
  archived: z.boolean().optional(), version,
}).strict();
const availabilityBody = z.object({ available: z.boolean() }).strict();
// Base64 inside JSON, so an upload passes the same CSRF checks as every other write.
const imageBody = z.object({
  contentType: z.string().max(100),
  data: z.string().max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 1024),
}).strict();

const MAX_ITEMS_LISTED = 2000;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Please check the details you entered.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

const paramId = (req: Request): string => {
  const parsed = id.safeParse(req.params.id);
  // Malformed ids look like missing rows, so probing with junk learns nothing extra.
  if (!parsed.success) throw notFound();
  return parsed.data;
};

/** Unique-index violations become a clear 409 naming what clashed. */
const duplicate = (code: string, message: string) => (error: unknown): never => {
  if ((error as { code?: string }).code === '23505') throw conflict(code, message);
  throw error;
};

function toMinor(value: string, currency: Currency): number {
  try {
    const minor = parseMoney(value, currency);
    if (minor < 0 || minor > MAX_PRICE_MAJOR * 100) throw new MoneyError('out of range');
    return minor;
  } catch {
    throw badRequest('VALIDATION_FAILED', 'Please check the details you entered.',
      [{ field: 'price', message: `Enter a price from 0 to ${MAX_PRICE_MAJOR.toLocaleString('en-IN')}.` }]);
  }
}

type CategoryRow = {
  id: string; name: string; sort_order: number; visible: boolean; archived_at: Date | null;
  version: number; created_at: Date; updated_at: Date;
};
type ItemRow = {
  id: string; category_id: string; name: string; description: string | null; price_minor: string;
  image_path: string | null; diet: z.infer<typeof diet>; available: boolean; visible: boolean;
  sort_order: number; archived_at: Date | null; version: number; created_at: Date; updated_at: Date;
};

const CATEGORY_COLUMNS = 'id, name, sort_order, visible, archived_at, version, created_at, updated_at';
const ITEM_COLUMNS = `id, category_id, name, description, price_minor, image_path, diet, available, visible,
                      sort_order, archived_at, version, created_at, updated_at`;

const presentCategory = (row: CategoryRow) => ({
  id: row.id, name: row.name, sortOrder: row.sort_order, visible: row.visible,
  archived: row.archived_at !== null, version: row.version, updatedAt: row.updated_at,
});

export function menuRoutes(deps: MenuDeps): Router {
  const { db, verify, cookieSecure, logger, imageStore, menuCache } = deps;
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  // bigint arrives from pg as a string; menu prices sit far inside the safe range.
  const presentItem = (row: ItemRow) => ({
    id: row.id, categoryId: row.category_id, name: row.name, description: row.description,
    priceMinor: Number(row.price_minor), imageUrl: row.image_path && imageStore ? imageStore.publicUrl(row.image_path) : null,
    diet: row.diet, available: row.available, visible: row.visible, archived: row.archived_at !== null,
    sortOrder: row.sort_order, version: row.version, updatedAt: row.updated_at,
  });

  const audit = async (
    client: pg.PoolClient, req: Request, action: string, entityType: 'menu_category' | 'menu_item',
    entityId: string | null, summary: Record<string, unknown>,
  ) => {
    const principal = staffPrincipal(req);
    await client.query(
      `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [principal.restaurantId, principal.userId, principal.role, action, entityType, entityId,
       JSON.stringify(summary), req.clientIp, req.requestId]);
  };

  const currencyOf = async (client: pg.PoolClient, restaurantId: string): Promise<Currency> =>
    (await client.query<{ currency: Currency }>('select currency from restaurants where id = $1', [restaurantId]))
      .rows[0]!.currency;

  /** Answers 404 for a row RLS hides or that does not exist, 409 for a stale version. */
  const missingOrStale = async (client: pg.PoolClient, table: 'menu_categories' | 'menu_items', rowId: string): Promise<never> => {
    const exists = await client.query(`select 1 from ${table} where id = $1`, [rowId]);
    if (exists.rowCount === 0) throw notFound();
    throw conflict('STALE_VERSION', 'Someone else changed this. Reload and try again.');
  };

  /** The category must be this restaurant's (RLS) and not archived. */
  const assertLiveCategory = async (client: pg.PoolClient, categoryId: string) => {
    const found = await client.query<{ archived_at: Date | null }>(
      'select archived_at from menu_categories where id = $1', [categoryId]);
    if (found.rowCount === 0 || found.rows[0]!.archived_at !== null) {
      throw badRequest('VALIDATION_FAILED', 'Please check the details you entered.',
        [{ field: 'categoryId', message: 'Choose a category that is not archived.' }]);
    }
  };

  const changed = (req: Request) => menuCache.invalidate(staffPrincipal(req).restaurantId);

  // -------------------------------------------------------------------- read
  /** The whole menu for the editor, archived rows included and flagged. */
  router.get('/', requirePermission('menu.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const data = await db.asStaff(principal, async (client) => {
        const currency = await currencyOf(client, principal.restaurantId);
        const categories = await client.query<CategoryRow>(
          `select ${CATEGORY_COLUMNS} from menu_categories order by sort_order, lower(name), id`);
        const items = await client.query<ItemRow>(
          `select ${ITEM_COLUMNS} from menu_items order by sort_order, lower(name), id limit $1`, [MAX_ITEMS_LISTED + 1]);
        return { currency, categories: categories.rows, items: items.rows };
      });
      res.status(200).json({
        currency: data.currency,
        categories: data.categories.map(presentCategory),
        items: data.items.slice(0, MAX_ITEMS_LISTED).map(presentItem),
        truncated: data.items.length > MAX_ITEMS_LISTED,
      });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------- categories
  router.post('/categories', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(createCategoryBody, req.body);
      const row = await db.asStaff(principal, async (client) => {
        const result = await client
          .query<CategoryRow>(
            `insert into menu_categories (restaurant_id, name, visible, sort_order)
             values ($1, $2, $3, (select coalesce(max(sort_order), 0) + 1 from menu_categories))
             returning ${CATEGORY_COLUMNS}`,
            [principal.restaurantId, body.name, body.visible ?? true])
          .catch(duplicate('CATEGORY_NAME_TAKEN', 'Another category already has that name.'));
        const created = result.rows[0]!;
        await audit(client, req, 'menu.category.created', 'menu_category', created.id,
          { name: created.name, visible: created.visible });
        return created;
      });
      changed(req);
      res.status(201).json({ category: presentCategory(row) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/categories/:id', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const categoryId = paramId(req);
      const body = parse(updateCategoryBody, req.body);
      const row = await db.asStaff(principal, async (client) => {
        const before = (await client.query<CategoryRow>(
          `select ${CATEGORY_COLUMNS} from menu_categories where id = $1`, [categoryId])).rows[0];
        if (!before) throw notFound();

        const result = await client
          .query<CategoryRow>(
            `update menu_categories set
               name = coalesce($2, name),
               visible = coalesce($3, visible),
               archived_at = case when $4::boolean is null then archived_at
                                  when $4 then coalesce(archived_at, now()) else null end,
               version = version + 1
             where id = $1 and version = $5
             returning ${CATEGORY_COLUMNS}`,
            [categoryId, body.name ?? null, body.visible ?? null, body.archived ?? null, body.version])
          // Restoring can clash too: a new category may have taken the name meanwhile.
          .catch(duplicate('CATEGORY_NAME_TAKEN', 'Another category already has that name.'));
        if (result.rowCount === 0) await missingOrStale(client, 'menu_categories', categoryId);
        const after = result.rows[0]!;

        if (after.name !== before.name) {
          await audit(client, req, 'menu.category.renamed', 'menu_category', categoryId, { from: before.name, to: after.name });
        }
        if (after.visible !== before.visible) {
          await audit(client, req, after.visible ? 'menu.category.shown' : 'menu.category.hidden', 'menu_category',
            categoryId, { name: after.name });
        }
        if ((after.archived_at === null) !== (before.archived_at === null)) {
          await audit(client, req, after.archived_at ? 'menu.category.archived' : 'menu.category.restored',
            'menu_category', categoryId, { name: after.name });
        }
        return after;
      });
      changed(req);
      res.status(200).json({ category: presentCategory(row) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Sets the order of the live categories. The list must name every live category
   * exactly once, so a stale screen cannot silently drop one to the bottom.
   */
  router.put('/categories/order', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(orderBody, req.body);
      const rows = await db.asStaff(principal, async (client) => {
        const live = await client.query<{ id: string }>(
          'select id from menu_categories where archived_at is null for update');
        const liveIds = new Set(live.rows.map((row) => row.id));
        const sent = new Set(body.ids);
        if (sent.size !== body.ids.length || sent.size !== liveIds.size || body.ids.some((each) => !liveIds.has(each))) {
          throw conflict('STALE_ORDER', 'The category list has changed. Reload and try again.');
        }
        await client.query(
          `update menu_categories c set sort_order = o.position, version = c.version + 1
             from unnest($1::uuid[]) with ordinality as o(id, position)
            where c.id = o.id and c.sort_order is distinct from o.position`,
          [body.ids]);
        await audit(client, req, 'menu.categories.reordered', 'menu_category', null, { count: body.ids.length });
        return (await client.query<CategoryRow>(
          `select ${CATEGORY_COLUMNS} from menu_categories order by sort_order, lower(name), id`)).rows;
      });
      changed(req);
      res.status(200).json({ categories: rows.map(presentCategory) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- items
  router.post('/items', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(createItemBody, req.body);
      const row = await db.asStaff(principal, async (client) => {
        const priceMinor = toMinor(body.price, await currencyOf(client, principal.restaurantId));
        await assertLiveCategory(client, body.categoryId);
        const result = await client
          .query<ItemRow>(
            `insert into menu_items (restaurant_id, category_id, name, description, price_minor, diet, visible, available, sort_order)
             values ($1, $2, $3, $4, $5, $6, $7, $8,
                     (select coalesce(max(sort_order), 0) + 1 from menu_items where category_id = $2))
             returning ${ITEM_COLUMNS}`,
            [principal.restaurantId, body.categoryId, body.name, body.description ?? null, priceMinor,
             body.diet ?? 'none', body.visible ?? true, body.available ?? true])
          .catch(duplicate('ITEM_NAME_TAKEN', 'This category already has an item with that name.'));
        const created = result.rows[0]!;
        await audit(client, req, 'menu.item.created', 'menu_item', created.id,
          { name: created.name, priceMinor, categoryId: created.category_id });
        return created;
      });
      changed(req);
      res.status(201).json({ item: presentItem(row) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/items/:id', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const itemId = paramId(req);
      const body = parse(updateItemBody, req.body);
      const row = await db.asStaff(principal, async (client) => {
        const before = (await client.query<ItemRow>(`select ${ITEM_COLUMNS} from menu_items where id = $1`, [itemId])).rows[0];
        if (!before) throw notFound();
        const priceMinor = body.price !== undefined
          ? toMinor(body.price, await currencyOf(client, principal.restaurantId)) : null;
        if (body.categoryId && body.categoryId !== before.category_id) await assertLiveCategory(client, body.categoryId);

        const result = await client
          .query<ItemRow>(
            `update menu_items set
               category_id = coalesce($2, category_id),
               name = coalesce($3, name),
               description = case when $4::boolean then $5 else description end,
               price_minor = coalesce($6, price_minor),
               diet = coalesce($7::diet_type, diet),
               visible = coalesce($8, visible),
               available = coalesce($9, available),
               archived_at = case when $10::boolean is null then archived_at
                                  when $10 then coalesce(archived_at, now()) else null end,
               version = version + 1
             where id = $1 and version = $11
             returning ${ITEM_COLUMNS}`,
            [itemId, body.categoryId ?? null, body.name ?? null, body.description !== undefined, body.description ?? null,
             priceMinor, body.diet ?? null, body.visible ?? null, body.available ?? null, body.archived ?? null, body.version])
          .catch(duplicate('ITEM_NAME_TAKEN', 'This category already has an item with that name.'));
        if (result.rowCount === 0) await missingOrStale(client, 'menu_items', itemId);
        const after = result.rows[0]!;

        // Price, availability, visibility and archiving each get their own entry,
        // so the audit log answers "who changed the price of X?" directly.
        if (after.price_minor !== before.price_minor) {
          await audit(client, req, 'menu.item.price_changed', 'menu_item', itemId,
            { name: after.name, fromMinor: Number(before.price_minor), toMinor: Number(after.price_minor) });
        }
        if (after.available !== before.available) {
          await audit(client, req, 'menu.item.availability_changed', 'menu_item', itemId,
            { name: after.name, available: after.available });
        }
        if (after.visible !== before.visible) {
          await audit(client, req, 'menu.item.visibility_changed', 'menu_item', itemId,
            { name: after.name, visible: after.visible });
        }
        if ((after.archived_at === null) !== (before.archived_at === null)) {
          await audit(client, req, after.archived_at ? 'menu.item.archived' : 'menu.item.restored', 'menu_item',
            itemId, { name: after.name });
        }
        const other = (['category_id', 'name', 'description', 'diet'] as const)
          .filter((key) => after[key] !== before[key]);
        if (other.length) {
          await audit(client, req, 'menu.item.updated', 'menu_item', itemId, { name: after.name, fields: other });
        }
        return after;
      });
      changed(req);
      res.status(200).json({ item: presentItem(row) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Sold out / back in stock (FR-024). The one change kitchen staff may make. No
   * version: it sets an explicit value, so two people pressing it agree.
   */
  router.patch('/items/:id/availability', requirePermission('menu.item.toggleAvailability'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const itemId = paramId(req);
      const body = parse(availabilityBody, req.body);
      const row = await db.asStaff(principal, async (client) => {
        const before = await client.query<{ available: boolean }>(
          'select available from menu_items where id = $1 for update', [itemId]);
        if (before.rowCount === 0) throw notFound();
        const result = await client.query<ItemRow>(
          `update menu_items set available = $2, version = version + 1 where id = $1 returning ${ITEM_COLUMNS}`,
          [itemId, body.available]);
        const after = result.rows[0]!;
        if (before.rows[0]!.available !== after.available) {
          await audit(client, req, 'menu.item.availability_changed', 'menu_item', itemId,
            { name: after.name, available: after.available });
        }
        return after;
      });
      changed(req);
      res.status(200).json({ item: presentItem(row) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- images
  router.put('/items/:id/image', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const itemId = paramId(req);
      if (!imageStore) {
        throw new AppError(503, 'IMAGES_NOT_CONFIGURED', 'Image uploads are not set up yet. Everything else on the menu works.');
      }
      const body = parse(imageBody, req.body);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
        throw badRequest('IMAGE_INVALID', 'That image could not be read. Try choosing it again.');
      }

      // The item is checked before any work on the image, so an upload aimed at
      // another restaurant's item is refused without touching storage.
      const exists = await db.asStaff(principal, async (client) =>
        (await client.query('select 1 from menu_items where id = $1', [itemId])).rowCount);
      if (!exists) throw notFound();

      let webp: Buffer;
      try {
        webp = await processMenuImage(Buffer.from(body.data, 'base64'), body.contentType);
      } catch (error) {
        if (error instanceof ImageRejected) {
          throw new AppError(error.code === 'IMAGE_TOO_LARGE' ? 413 : 415, error.code, error.message);
        }
        throw error;
      }

      // Stored first under a fresh random key; the database row then points at it.
      // A failure after the upload leaves an unreferenced file, never a broken image.
      const key = menuImageKey(principal.restaurantId);
      await imageStore.put(key, webp, 'image/webp');

      const { row, previous } = await db.asStaff(principal, async (client) => {
        const before = await client.query<{ image_path: string | null }>(
          'select image_path from menu_items where id = $1 for update', [itemId]);
        if (before.rowCount === 0) throw notFound();
        const result = await client.query<ItemRow>(
          `update menu_items set image_path = $2, version = version + 1 where id = $1 returning ${ITEM_COLUMNS}`,
          [itemId, key]);
        await audit(client, req, before.rows[0]!.image_path ? 'menu.item.image_replaced' : 'menu.item.image_added',
          'menu_item', itemId, { name: result.rows[0]!.name, bytes: webp.length });
        return { row: result.rows[0]!, previous: before.rows[0]!.image_path };
      }).catch(async (error) => {
        await imageStore.remove(key).catch(() => undefined);
        throw error;
      });

      if (previous) await imageStore.remove(previous).catch((error) => logger.warn({ err: error }, 'old menu image not removed'));
      changed(req);
      res.status(200).json({ item: presentItem(row) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/items/:id/image', requirePermission('menu.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const itemId = paramId(req);
      const { row, previous } = await db.asStaff(principal, async (client) => {
        const before = await client.query<{ image_path: string | null }>(
          'select image_path from menu_items where id = $1 for update', [itemId]);
        if (before.rowCount === 0) throw notFound();
        const result = await client.query<ItemRow>(
          `update menu_items set image_path = null, version = version + 1 where id = $1 returning ${ITEM_COLUMNS}`,
          [itemId]);
        if (before.rows[0]!.image_path) {
          await audit(client, req, 'menu.item.image_removed', 'menu_item', itemId, { name: result.rows[0]!.name });
        }
        return { row: result.rows[0]!, previous: before.rows[0]!.image_path };
      });
      if (previous && imageStore) {
        await imageStore.remove(previous).catch((error) => logger.warn({ err: error }, 'menu image not removed'));
      }
      changed(req);
      res.status(200).json({ item: presentItem(row) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

