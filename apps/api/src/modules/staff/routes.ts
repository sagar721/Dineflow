// Staff invitation management (design/02 §6.3, PRD FR-101, FR-108, FR-109).
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canManageRole } from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';
import type { Logger } from '../../lib/logger.ts';

export type StaffDeps = {
  db: Database;
  verify: Verifier;
  cookieSecure: boolean;
  appBaseUrl: string;
  logger: Logger;
  /** Sends the invitation email. Injectable so tests capture the link. */
  sendInvitationEmail?: (to: string, link: string) => Promise<void>;
};

const inviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(['owner', 'manager', 'kitchen', 'billing']),
    // 72 hours by default (FR-101); a caller may shorten it but not extend it.
    expiresInHours: z.number().int().min(1).max(72).default(72),
  })
  .strict();

const INVITATION_TOKEN_BYTES = 32; // 256 bits

export function staffRoutes(deps: StaffDeps): Router {
  const { db, verify, cookieSecure, appBaseUrl, logger, sendInvitationEmail } = deps;
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  // ------------------------------------------------------------- list invites
  router.get('/invitations', requirePermission('staff.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const rows = await db.asStaff(principal, async (client) => {
        // No token or token hash is ever selected: there is no legitimate reason to
        // read one back, and a response body is easy to leak.
        const result = await client.query(
          `select id, email, role, created_at, expires_at, accepted_at, revoked_at
             from invitations
            order by created_at desc
            limit 100`,
        );
        return result.rows;
      });
      res.status(200).json({ invitations: rows });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------ create invite
  router.post('/invitations', requirePermission('staff.invite'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const parsed = inviteBody.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          'VALIDATION_FAILED',
          'Please check the details you entered.',
          parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        );
      }
      const body = parsed.data;

      // Checked here and independently by the RLS policy, so a bug in either layer
      // alone cannot grant a role the inviter does not hold (FR-108, FR-109).
      if (!canManageRole(principal, body.role)) {
        throw forbidden('You cannot invite someone to that role.');
      }

      const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest();

      const invitation = await db.asStaff(principal, async (client) => {
        const existing = await client.query(
          `select id from restaurant_users where email = $1 and status = 'active'`,
          [body.email],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          throw conflict('ALREADY_STAFF', 'That person is already on your team.');
        }

        let created;
        try {
          created = await client.query<{ id: string; expires_at: Date }>(
            `insert into invitations (restaurant_id, email, role, token_hash, invited_by, expires_at)
             values ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
             returning id, expires_at`,
            [principal.restaurantId, body.email, body.role, tokenHash, principal.userId, body.expiresInHours],
          );
        } catch (error) {
          // The partial unique index guarantees one live invitation per address.
          if ((error as { code?: string }).code === '23505') {
            throw conflict('INVITE_EXISTS', 'That person already has a pending invitation.');
          }
          throw error;
        }

        const row = created.rows[0]!;
        await client.query(
          `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, user_agent, request_id)
           values ($1, $2, $3, 'auth.invitation.created', 'invitation', $4, $5, $6, $7, $8)`,
          [
            principal.restaurantId, principal.userId, principal.role, row.id,
            // The email is the subject of the action, so it belongs in the audit
            // record; the token never does.
            JSON.stringify({ email: body.email, role: body.role }),
            req.clientIp, (req.headers['user-agent'] ?? '').slice(0, 300), req.requestId,
          ],
        );
        return row;
      });

      // The token travels in the URL fragment, which browsers do not send to
      // servers and which never reaches an access log or a Referer header.
      const link = `${appBaseUrl}/accept-invite#token=${token}`;
      if (sendInvitationEmail) {
        await sendInvitationEmail(body.email, link);
      } else {
        // No email provider is configured yet (module 18). Saying so plainly beats
        // a silent no-op that looks like a delivered invitation.
        logger.warn({ invitationId: invitation.id }, 'no email provider configured; invitation link not sent');
      }

      res.status(201).json({
        id: invitation.id,
        expiresAt: invitation.expires_at,
        emailSent: Boolean(sendInvitationEmail),
      });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------ revoke invite
  router.delete('/invitations/:id', requirePermission('staff.invite'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) throw notFound();

      await db.asStaff(principal, async (client) => {
        const updated = await client.query(
          `update invitations set revoked_at = now(), revoked_by = $1
            where id = $2 and accepted_at is null and revoked_at is null
            returning id`,
          [principal.userId, id.data],
        );
        // RLS already scopes this to the caller's restaurant, so a wrong-tenant id
        // simply matches nothing and returns the same 404 as a missing one.
        if (updated.rowCount === 0) throw notFound();

        await client.query(
          `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, request_id)
           values ($1, $2, $3, 'auth.invitation.revoked', 'invitation', $4, $5)`,
          [principal.restaurantId, principal.userId, principal.role, id.data, req.requestId],
        );
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
