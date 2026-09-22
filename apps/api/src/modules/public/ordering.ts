// Customer ordering (PRD FR-032 … FR-042; design/02 §8, the placement algorithm).
//
// The browser sends only what the customer chose: item ids, quantities, notes and
// optional contact details. Everything else — which restaurant and table, whether
// each item is on the menu and in stock, every price and total, the order number —
// comes from the database, inside one transaction, as the customer role scoped by
// RLS to the restaurant the QR resolved to.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { sumMinor, type Currency } from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { AppError, badRequest } from '../../lib/errors.ts';
import type { QrKeyring } from '../../lib/qr-token.ts';
import { deriveStatusToken, statusTokenHash } from '../../lib/order-token.ts';

/** More lines than any real table orders; the per-restaurant item limit is lower. */
export const MAX_LINES = 200;

const line = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  note: z.string().trim().max(200).optional(),
}).strict();

export const quoteBody = z.object({ items: z.array(line).min(1).max(MAX_LINES) }).strict();

export const orderBody = z.object({
  items: z.array(line).min(1).max(MAX_LINES),
  specialInstructions: z.string().trim().max(500).optional(),
  contact: z.object({
    mobile: z.string().max(32).optional(),
    email: z.string().max(254).optional(),
  }).strict().optional(),
}).strict();

export type CartLine = z.infer<typeof line>;
export type OrderBody = z.infer<typeof orderBody>;

type ContactPolicy = 'off' | 'optional' | 'require_mobile' | 'require_email' | 'require_both';

type Setup = {
  accepting_orders: boolean; currency: Currency; contact_policy: ContactPolicy;
  max_qty_per_line: number; max_items_per_order: number; order_prefix: string;
};

export type PricedLine = {
  menuItemId: string; position: number; name: string; unitPriceMinor: number; quantity: number;
  lineTotalMinor: number; note: string | null;
};

/** An empty cart gets its own answer rather than a generic validation error. */
export function parseCart<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
      && (body as { items: unknown[] }).items.length === 0) {
    throw badRequest('CART_EMPTY', 'Your cart is empty. Add something from the menu first.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Please check your order and try again.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

/** The restaurant's ordering state and limits, as the customer role may see them. */
async function loadSetup(client: pg.PoolClient): Promise<Setup> {
  const { rows } = await client.query<Setup>(
    `select r.accepting_orders, r.currency, s.contact_policy, s.max_qty_per_line, s.max_items_per_order, s.order_prefix
       from restaurants r join restaurant_settings s on s.restaurant_id = r.id`);
  // RLS shows exactly one row: the resolved, active restaurant. Anything else means
  // it stopped being available since the QR was resolved.
  if (rows.length !== 1) throw new AppError(404, 'TABLE_UNAVAILABLE', "This QR code isn't active. Please ask a member of staff for help.");
  return rows[0]!;
}

/**
 * Prices a cart from database values only (FR-036, FR-037). Items are loaded in one
 * query; RLS already hides anything not on this restaurant's live menu, so an id
 * from another restaurant, a hidden item and a deleted one all look the same.
 */
async function priceCart(client: pg.PoolClient, lines: CartLine[], setup: Setup) {
  const seen = new Set<string>();
  for (const each of lines) {
    const id = each.menuItemId.toLowerCase();
    if (seen.has(id)) {
      throw badRequest('DUPLICATE_ITEM', 'An item appears twice in your cart. Please refresh and try again.');
    }
    seen.add(id);
  }
  const overLimit = lines.filter((each) => each.quantity > setup.max_qty_per_line);
  if (overLimit.length) {
    throw new AppError(422, 'QUANTITY_LIMIT', `You can order up to ${setup.max_qty_per_line} of each item.`,
      overLimit.map((each) => ({ menuItemId: each.menuItemId, max: setup.max_qty_per_line })));
  }
  const totalQuantity = lines.reduce((total, each) => total + each.quantity, 0);
  if (totalQuantity > setup.max_items_per_order) {
    throw new AppError(422, 'ORDER_TOO_LARGE',
      `One order can have up to ${setup.max_items_per_order} items. Please split it into two orders.`);
  }

  const { rows } = await client.query<{ id: string; name: string; price_minor: string; available: boolean }>(
    'select id, name, price_minor, available from menu_items where id = any($1::uuid[])',
    [lines.map((each) => each.menuItemId)]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const problems: { menuItemId: string; reason: 'not_on_menu' | 'sold_out'; name?: string }[] = [];
  for (const each of lines) {
    const item = byId.get(each.menuItemId.toLowerCase());
    if (!item) problems.push({ menuItemId: each.menuItemId, reason: 'not_on_menu' });
    else if (!item.available) problems.push({ menuItemId: each.menuItemId, reason: 'sold_out', name: item.name });
  }
  if (problems.length) {
    const soldOut = problems.filter((problem) => problem.reason === 'sold_out');
    const message = problems.length === 1 && soldOut.length === 1
      ? `${soldOut[0]!.name} is sold out. Remove it to continue.`
      : soldOut.length === problems.length
        ? 'Some items in your cart are sold out. Remove them to continue.'
        : 'Some items in your cart are no longer on the menu. Remove them to continue.';
    throw new AppError(422, 'ORDER_ITEM_UNAVAILABLE', message, problems);
  }

  const priced: PricedLine[] = lines.map((each, index) => {
    const item = byId.get(each.menuItemId.toLowerCase())!;
    const unit = Number(item.price_minor);
    return {
      menuItemId: item.id, position: index + 1, name: item.name, unitPriceMinor: unit, quantity: each.quantity,
      lineTotalMinor: unit * each.quantity, note: each.note || null,
    };
  });
  return { lines: priced, subtotalMinor: sumMinor(priced.map((each) => each.lineTotalMinor)) };
}

/** Applies the restaurant's contact policy (FR-034) and normalises what is kept. */
function checkContact(policy: ContactPolicy, contact: OrderBody['contact']) {
  const mobileRaw = contact?.mobile?.trim() ?? '';
  const emailRaw = contact?.email?.trim() ?? '';
  const fields: { field: string; message: string }[] = [];

  if (policy === 'off') {
    if (mobileRaw || emailRaw) {
      throw badRequest('CONTACT_NOT_COLLECTED', 'This restaurant does not ask for contact details. Please remove them.');
    }
    return null;
  }
  const mobile = mobileRaw.replace(/[\s()-]/g, '');
  const email = emailRaw.toLowerCase();
  if (mobile && !/^\+?[0-9]{10,15}$/.test(mobile)) fields.push({ field: 'contact.mobile', message: 'Enter a valid mobile number.' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fields.push({ field: 'contact.email', message: 'Enter a valid email address.' });
  if ((policy === 'require_mobile' || policy === 'require_both') && !mobile) {
    fields.push({ field: 'contact.mobile', message: 'Enter your mobile number.' });
  }
  if ((policy === 'require_email' || policy === 'require_both') && !email) {
    fields.push({ field: 'contact.email', message: 'Enter your email address.' });
  }
  if (fields.length) throw badRequest('VALIDATION_FAILED', 'Please check your contact details.', fields);
  return mobile || email ? { mobile: mobile || null, email: email || null } : null;
}

/**
 * A stable fingerprint of what was asked for, so a reused idempotency key with a
 * different cart (or from a different table) is refused instead of answered with
 * someone else's order.
 */
function requestHash(tableId: string, body: OrderBody, contact: ReturnType<typeof checkContact>): Buffer {
  const canonical = JSON.stringify({
    table: tableId,
    items: [...body.items]
      .map((each) => [each.menuItemId.toLowerCase(), each.quantity, each.note || null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    instructions: body.specialInstructions || null,
    contact,
  });
  return createHash('sha256').update(canonical).digest();
}

// ---------------------------------------------------------------------- quote
/** The review screen's server-computed prices and subtotal (FR-036). Writes nothing. */
export async function quoteCart(db: Database, restaurantId: string, lines: CartLine[]) {
  return db.asPublic(restaurantId, async (client) => {
    const setup = await loadSetup(client);
    const priced = await priceCart(client, lines, setup);
    return { currency: setup.currency, acceptingOrders: setup.accepting_orders, ...priced };
  });
}

// ---------------------------------------------------------------------- place
export type PlaceResult = { created: boolean; statusToken: string };

/**
 * Places an order atomically (FR-037 … FR-040). Every step runs in one transaction;
 * any failure — a sold-out item, a limit, a constraint, the commit-time total check
 * — rolls back all of it, including the order number.
 */
export async function placeOrder(
  db: Database, keys: QrKeyring,
  table: { restaurantId: string; tableId: string },
  idempotencyKey: string, body: OrderBody,
): Promise<PlaceResult> {
  const statusToken = deriveStatusToken(keys, table.restaurantId, idempotencyKey);
  const tokenHash = statusTokenHash(statusToken);

  const attempt = () => db.asPublic(table.restaurantId, async (client) => {
    // Lets RLS show this order back to us, and only this one.
    await client.query(`select set_config('app.public_order_token_hash', $1, true)`, [tokenHash.toString('hex')]);
    const setup = await loadSetup(client);
    const contact = checkContact(setup.contact_policy, body.contact);
    const fingerprint = requestHash(table.tableId, body, contact);

    // An idempotent replay returns the order already placed with this key.
    const existing = await client.query<{ request_hash: Buffer }>(
      'select request_hash from orders where idempotency_key = $1', [idempotencyKey]);
    if (existing.rowCount) {
      if (!existing.rows[0]!.request_hash.equals(fingerprint)) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED',
          'This order request was already used for a different order. Please review your cart and try again.');
      }
      return false;
    }

    if (!setup.accepting_orders) {
      throw new AppError(422, 'ORDERING_PAUSED', 'This restaurant is not taking orders here right now. Please ask a member of staff.');
    }
    const priced = await priceCart(client, body.items, setup);

    const orderNo = (await client.query<{ n: number }>('select app.next_order_no() as n')).rows[0]!.n;
    const orderRef = setup.order_prefix ? `${setup.order_prefix}-${orderNo}` : String(orderNo);

    const order = await client.query<{ id: string }>(
      `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor, special_instructions,
                           public_token_hash, idempotency_key, request_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [table.restaurantId, table.tableId, orderNo, orderRef, priced.subtotalMinor,
       body.specialInstructions || null, tokenHash, idempotencyKey, fingerprint]);
    const orderId = order.rows[0]!.id;

    // All lines in one statement: the name and price are snapshots taken now.
    await client.query(
      `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity, item_note)
       select $1, $2, l.menu_item_id, l.position, l.name, l.price, l.quantity, l.note
         from unnest($3::uuid[], $4::smallint[], $5::text[], $6::bigint[], $7::int[], $8::text[])
              as l(menu_item_id, position, name, price, quantity, note)`,
      [table.restaurantId, orderId, priced.lines.map((l) => l.menuItemId), priced.lines.map((l) => l.position),
       priced.lines.map((l) => l.name), priced.lines.map((l) => l.unitPriceMinor),
       priced.lines.map((l) => l.quantity), priced.lines.map((l) => l.note)]);

    if (contact) {
      await client.query(
        'insert into order_customers (order_id, restaurant_id, mobile, email) values ($1, $2, $3, $4)',
        [orderId, table.restaurantId, contact.mobile, contact.email]);
    }
    return true;
  });

  try {
    return { created: await attempt(), statusToken };
  } catch (error) {
    // Two identical requests at once: one commits, the other hits the unique key.
    // Asking again finds the committed order and answers as a replay.
    if ((error as { code?: string; constraint?: string }).code === '23505'
        && (error as { constraint?: string }).constraint === 'orders_restaurant_id_idempotency_key_key') {
      return { created: await attempt(), statusToken };
    }
    throw error;
  }
}

// ----------------------------------------------------------------------- view
export type OrderView = {
  ref: string; number: number; status: string; placedAt: Date;
  restaurant: { name: string | null; currency: string | null };
  items: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; note: string | null }[];
  subtotalMinor: number; specialInstructions: string | null;
};

/**
 * One order, as its status-token holder may see it (FR-041, FR-042): the order and
 * its lines, never who placed it, never another order.
 */
export async function viewOrder(db: Database, statusToken: string): Promise<OrderView | null> {
  const tokenHash = statusTokenHash(statusToken);
  return db.asOrderViewer(tokenHash, async (client) => {
    const order = (await client.query<{
      id: string; restaurant_id: string; order_ref: string; order_no: number; status: string; placed_at: Date;
      subtotal_minor: string; special_instructions: string | null;
    }>(`select id, restaurant_id, order_ref, order_no, status, placed_at, subtotal_minor, special_instructions
          from orders where public_token_hash = $1`, [tokenHash])).rows;
    if (order.length !== 1) return null;
    const found = order[0]!;
    const items = await client.query<{
      name_snapshot: string; quantity: number; unit_price_minor: string; line_total_minor: string; item_note: string | null;
    }>(`select name_snapshot, quantity, unit_price_minor, line_total_minor, item_note
          from order_items where order_id = $1 order by position`, [found.id]);
    // The restaurant's public details, for the header; absent if it is no longer live.
    await client.query(`select set_config('app.public_restaurant_id', $1, true)`, [found.restaurant_id]);
    const restaurant = (await client.query<{ name: string; currency: string }>(
      'select name, currency from restaurants')).rows[0];
    return {
      ref: found.order_ref, number: found.order_no, status: found.status, placedAt: found.placed_at,
      restaurant: { name: restaurant?.name ?? null, currency: restaurant?.currency ?? null },
      items: items.rows.map((row) => ({
        name: row.name_snapshot, quantity: row.quantity, unitPriceMinor: Number(row.unit_price_minor),
        lineTotalMinor: Number(row.line_total_minor), note: row.item_note,
      })),
      subtotalMinor: Number(found.subtotal_minor), specialInstructions: found.special_instructions,
    };
  });
}
