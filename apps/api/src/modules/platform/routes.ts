// Platform routes: provisioning restaurants and managing their lifecycle.
// Design: docs/design/02-api-auth-tenancy.md §6.2; PRD FR-001, FR-002, FR-007, FR-009.
//
// A platform admin is not a super-powerful staff member. These routes deal in
// tenant *metadata* — status, counts, who was invited — and never in a restaurant's
// business data, which needs an audited support grant instead (FR-009).
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../lib/db.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';
import type { Logger } from '../../lib/logger.ts';

export type PlatformDeps = {
  db: Database;
  verify: Verifier;
  cookieSecure: boolean;
  appBaseUrl: string;
  logger: Logger;
  sendInvitationEmail?: (to: string, link: string) => Promise<void>;
  /**
   * When no email provider is configured, returning the invitation link lets the
   * operator deliver it by hand. It puts a live token in a response body, so it is
   * off unless explicitly enabled and never on in production.
   */
  revealInvitationLink?: boolean;
};

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    // The slug appears in URLs and cannot be changed later, so it is validated
    // strictly rather than derived silently from a name someone may retype.
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
      'Use lowercase letters, numbers and hyphens.'),
    ownerEmail: z.string().trim().toLowerCase().email().max(254),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('INR'),
    timezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(['provisioning', 'active', 'suspended', 'closed']),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

const INVITATION_TOKEN_BYTES = 32;
const OWNER_INVITE_HOURS = 72;

export function platformRoutes(deps: PlatformDeps): Router {
  const { db, verify, cookieSecure, appBaseUrl, logger, sendInvitationEmail, revealInvitationLink } = deps;
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  // Every route here needs a platform admin *with* a second factor: `can()` returns
  // false for a platform permission at aal1, so this one check covers both.
  router.use(requirePermission('platform.restaurant.read'));

  // --------------------------------------------------------------------- list
  router.get('/restaurants', async (req, res, next) => {
    try {
      const principal = req.principal!;
      const restaurants = await db.listRestaurants(principal.userId);
      res.status(200).json({ restaurants });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- create
  router.post('/restaurants', async (req, res, next) => {
    try {
      const principal = req.principal!;
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          'VALIDATION_FAILED',
          'Please check the details you entered.',
          parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        );
      }
      const body = parsed.data;

      if (!isKnownTimezone(body.timezone)) {
        throw badRequest('VALIDATION_FAILED', 'That time zone is not recognised.', [
          { field: 'timezone', message: 'Use an IANA name such as Asia/Kolkata.' },
        ]);
      }

      const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(Date.now() + OWNER_INVITE_HOURS * 60 * 60 * 1000);

      let created;
      try {
        created = await db.createRestaurant({
          adminUserId: principal.userId,
          slug: body.slug,
          name: body.name,
          ownerEmail: body.ownerEmail,
          tokenHash: createHash('sha256').update(token).digest(),
          expiresAt,
          currency: body.currency,
          timezone: body.timezone,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('SLUG_TAKEN', 'That address is already in use. Choose another.');
        }
        throw error;
      }

      const link = `${appBaseUrl}/accept-invite#token=${token}`;
      if (sendInvitationEmail) {
        await sendInvitationEmail(body.ownerEmail, link);
      } else {
        logger.warn({ restaurantId: created.restaurantId }, 'no email provider configured; owner invitation not sent');
      }

      res.status(201).json({
        id: created.restaurantId,
        slug: body.slug,
        invitationId: created.invitationId,
        expiresAt,
        emailSent: Boolean(sendInvitationEmail),
        // Present only when the operator has to deliver the link themselves.
        ...(revealInvitationLink && !sendInvitationEmail ? { invitationLink: link } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- status
  router.patch('/restaurants/:id/status', async (req, res, next) => {
    try {
      const principal = req.principal!;
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) throw notFound();

      const parsed = statusBody.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          'VALIDATION_FAILED',
          // A reason is required because suspending someone's business is the kind
          // of action that has to be explainable months later.
          'A reason of at least 10 characters is required.',
          parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        );
      }

      const previous = await db.setRestaurantStatus(
        principal.userId, id.data, parsed.data.status, parsed.data.reason,
      );
      if (previous === null) throw notFound();

      res.status(200).json({ id: id.data, from: previous, to: parsed.data.status });
    } catch (error) {
      next(error);
    }
  });

  void forbidden;
  return router;
}

/** Rejects a timezone the runtime cannot resolve, before it is stored. */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
