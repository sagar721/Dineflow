// Public, unauthenticated routes reached by customers (design/02 §6.6).
//
// A customer holds exactly one capability: the token in the QR on their table.
// Everything here is derived from that token, verified before the database is
// touched, and answers with the minimum a customer needs to see.
import { Router } from 'express';
import type { Database } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { rateLimit } from '../../middleware/security.ts';
import type { RateLimiter } from '../../lib/rate-limit.ts';
import { verifyQrToken, type QrKeyring } from '../../lib/qr-token.ts';

export type PublicDeps = { db: Database; limiter: RateLimiter; qrKeys: QrKeyring };

// One answer for every way a table can be unavailable — unknown, forged, revoked,
// table out of service, restaurant not live. Telling them apart would let someone
// probe which restaurants exist and which tables are live (FR-017).
const unavailable = () =>
  new AppError(404, 'TABLE_UNAVAILABLE', "This QR code isn't active. Please ask a member of staff for help.");

export function publicRoutes({ db, limiter, qrKeys }: PublicDeps): Router {
  const router = Router();

  router.get(
    '/tables/:token',
    rateLimit(limiter, 'public-table', { limit: 120, windowSeconds: 60 }, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        // Verified in memory first: a forged or random token costs one HMAC and
        // never reaches the database.
        const verified = verifyQrToken(qrKeys, req.params.token);
        if (!verified) throw unavailable();

        const resolved = await db.resolveTableQr(verified.qrId);
        // The token must have been signed with the key recorded for this QR. Without
        // this check, a key kept only for old cards could mint new ones for any qr_id.
        if (!resolved || resolved.keyId !== verified.kid) throw unavailable();

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
        next(error);
      }
    },
  );

  return router;
}
