// Public, unauthenticated routes reached by customers (design/02 §6.6).
//
// A customer holds exactly one capability: the token in the QR on their table.
// Everything here is derived from that token, verified before the database is
// touched, and answers with the minimum a customer needs to see.
import { Router, type Request } from 'express';
import type { Database } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { rateLimit } from '../../middleware/security.ts';
import type { RateLimiter } from '../../lib/rate-limit.ts';
import { verifyQrToken, type QrKeyring } from '../../lib/qr-token.ts';
import type { ImageStore } from '../../lib/image-store.ts';
import type { MenuCache } from '../../lib/menu-cache.ts';

export type PublicMenu = {
  restaurant: { name: string; brandColor: string | null; acceptingOrders: boolean; currency: string };
  categories: {
    id: string;
    name: string;
    items: {
      id: string; name: string; description: string | null; priceMinor: number;
      imageUrl: string | null; diet: string; available: boolean;
    }[];
  }[];
};

export type PublicDeps = {
  db: Database;
  limiter: RateLimiter;
  qrKeys: QrKeyring;
  imageStore: ImageStore | null;
  menuCache: MenuCache<PublicMenu>;
};

// One answer for every way a table can be unavailable — unknown, forged, revoked,
// table out of service, restaurant not live. Telling them apart would let someone
// probe which restaurants exist and which tables are live (FR-017).
const unavailable = () =>
  new AppError(404, 'TABLE_UNAVAILABLE', "This QR code isn't active. Please ask a member of staff for help.");

/**
 * Every "not available" answer takes at least this long (US-03: identical timing).
 * A forged token is rejected in memory in microseconds, a revoked one after a
 * database round trip; without a floor the difference tells a prober which tokens
 * were once real. Set well above a production database round trip.
 */
export const UNAVAILABLE_FLOOR_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function publicRoutes({ db, limiter, qrKeys, imageStore, menuCache }: PublicDeps): Router {
  const router = Router();

  /** The table a token names, or the one generic "unavailable" answer. */
  const resolve = async (req: Request) => {
    // Verified in memory first: a forged or random token costs one HMAC and
    // never reaches the database.
    const verified = verifyQrToken(qrKeys, String(req.params.token));
    if (!verified) throw unavailable();
    const resolved = await db.resolveTableQr(verified.qrId);
    // The token must have been signed with the key recorded for this QR. Without
    // this check, a key kept only for old cards could mint new ones for any qr_id.
    if (!resolved || resolved.keyId !== verified.kid) throw unavailable();
    return resolved;
  };

  /**
   * What the customer may see of the menu. RLS does the filtering (shown, live
   * categories and items of this one restaurant); sold-out items are included so
   * they can be shown as sold out (FR-025).
   */
  const loadMenu = async (restaurantId: string): Promise<PublicMenu | null> => {
    const cached = menuCache.get(restaurantId);
    if (cached) return cached;
    const menu = await db.asPublic(restaurantId, async (client) => {
      const restaurant = (await client.query<{
        name: string; brand_color: string | null; accepting_orders: boolean; currency: string;
      }>('select name, brand_color, accepting_orders, currency from restaurants')).rows[0];
      if (!restaurant) return null;
      const categories = await client.query<{ id: string; name: string }>(
        'select id, name from menu_categories order by sort_order, lower(name), id');
      const items = await client.query<{
        id: string; category_id: string; name: string; description: string | null; price_minor: string;
        image_path: string | null; diet: string; available: boolean;
      }>(`select id, category_id, name, description, price_minor, image_path, diet, available
            from menu_items order by sort_order, lower(name), id`);
      return {
        restaurant: {
          name: restaurant.name, brandColor: restaurant.brand_color,
          acceptingOrders: restaurant.accepting_orders, currency: restaurant.currency,
        },
        categories: categories.rows
          .map((category) => ({
            id: category.id,
            name: category.name,
            items: items.rows.filter((item) => item.category_id === category.id).map((item) => ({
              id: item.id, name: item.name, description: item.description, priceMinor: Number(item.price_minor),
              imageUrl: item.image_path && imageStore ? imageStore.publicUrl(item.image_path) : null,
              diet: item.diet, available: item.available,
            })),
          }))
          // An empty section is noise on a phone.
          .filter((category) => category.items.length > 0),
      };
    });
    if (menu) menuCache.set(restaurantId, menu);
    return menu;
  };

  router.get(
    '/tables/:token',
    rateLimit(limiter, 'public-table', { limit: 120, windowSeconds: 60 }, (req) => req.clientIp),
    async (req, res, next) => {
      const started = performance.now();
      try {
        const resolved = await resolve(req);

        const restaurant = await db.asPublic(resolved.restaurantId, async (client) => {
          const result = await client.query<{ name: string; brand_color: string | null; accepting_orders: boolean }>(
            `select name, brand_color, accepting_orders from restaurants`);
          return result.rows[0];
        });
        if (!restaurant) throw unavailable();

        // No ids: the token already identifies the table, and an internal id handed
        // to the public is one more thing that can be correlated or guessed at.
        res.status(200).json({
          restaurant: {
            name: restaurant.name,
            brandColor: restaurant.brand_color,
            acceptingOrders: restaurant.accepting_orders,
          },
          table: { tableNumber: resolved.tableNumber, name: resolved.tableName },
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'TABLE_UNAVAILABLE') {
          await sleep(Math.max(0, UNAVAILABLE_FLOOR_MS - (performance.now() - started)));
        }
        next(error);
      }
    },
  );

  /** The table's menu (FR-030 … FR-032, FR-025). Same token rules and answers as above. */
  router.get(
    '/tables/:token/menu',
    rateLimit(limiter, 'public-menu', { limit: 120, windowSeconds: 60 }, (req) => req.clientIp),
    async (req, res, next) => {
      const started = performance.now();
      try {
        const resolved = await resolve(req);
        const menu = await loadMenu(resolved.restaurantId);
        if (!menu) throw unavailable();
        res.status(200).json({ ...menu, table: { tableNumber: resolved.tableNumber, name: resolved.tableName } });
      } catch (error) {
        if (error instanceof AppError && error.code === 'TABLE_UNAVAILABLE') {
          await sleep(Math.max(0, UNAVAILABLE_FLOOR_MS - (performance.now() - started)));
        }
        next(error);
      }
    },
  );

  return router;
}
