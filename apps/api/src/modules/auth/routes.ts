// Authentication routes (design/02 §6.1, PRD FR-100 … FR-105).
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { permissionsFor } from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import type { SupabaseAuth } from '../../auth/supabase.ts';
import type { RateLimiter } from '../../lib/rate-limit.ts';
import { LIMITS, LOCKOUT } from '../../lib/rate-limit.ts';
import { clearSessionCookies, refreshCookieName, setSessionCookies } from '../../lib/cookies.ts';
import { badRequest, INVALID_CREDENTIALS, unauthorized, AppError } from '../../lib/errors.ts';
import { rateLimit } from '../../middleware/security.ts';
import { authenticate, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';

export type AuthDeps = {
  db: Database;
  provider: SupabaseAuth;
  verify: Verifier;
  limiter: RateLimiter;
  cookieSecure: boolean;
  appBaseUrl: string;
};

// Email is normalised once, here, so the same address cannot occupy two lockout
// buckets by differing in case or surrounding space.
const email = z.string().trim().toLowerCase().email().max(254);
// Minimum 12 characters (design/02 §3.2). The provider owns strength beyond length.
const password = z.string().min(12).max(200);

const loginBody = z.object({ email, password }).strict();
const mfaBody = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict();
const forgotBody = z.object({ email }).strict();
const resetBody = z.object({ token: z.string().min(10).max(1024), password }).strict();
const acceptBody = z
  .object({ token: z.string().min(10).max(512), password, displayName: z.string().trim().min(1).max(120) })
  .strict();

/** Parses a body and turns a schema failure into our error shape. */
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Please check the details you entered.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Equal-length, constant-time comparison for anything secret. */
export function secretsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authRoutes(deps: AuthDeps): Router {
  const { db, provider, verify, limiter, cookieSecure, appBaseUrl } = deps;
  const router = Router();

  const audit = (req: Request, action: string, summary?: Record<string, unknown>, userId?: string | null) =>
    db
      .recordAuthEvent({
        action,
        userId: userId ?? null,
        summary,
        ip: req.clientIp,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: req.requestId,
      })
      .catch(() => {
        // An audit write must never break sign-in, but it must be visible: the
        // error handler logs it and the request continues.
      });

  const issueSession = (
    res: Response,
    session: { accessToken: string; refreshToken: string; expiresIn: number },
  ) =>
    setSessionCookies(res, session, {
      secure: cookieSecure,
      accessMaxAgeSeconds: session.expiresIn,
      // Absolute session lifetime (FR-104). The provider enforces its own; this
      // caps how long the browser will even offer the refresh token.
      refreshMaxAgeSeconds: 12 * 60 * 60,
    });

  // ------------------------------------------------------------------- login
  router.post(
    '/login',
    rateLimit(limiter, 'login-ip', LIMITS.login, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(loginBody, req.body);
        const accountKey = `login:${body.email}`;

        // Durable lockout is checked before the provider is called, so a locked
        // account costs an attacker nothing to discover and gains them nothing.
        const lockedUntil = await db.checkLock(accountKey);
        if (lockedUntil) {
          await audit(req, 'auth.login.blocked', { reason: 'locked' });
          // Deliberately the same message as a wrong password: a distinct "account
          // locked" reply would confirm the address exists (threat T-14).
          throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
        }

        const outcome = await provider.signInWithPassword(body.email, body.password);

        if (outcome.kind === 'invalid') {
          const until = await db.registerFailure(accountKey, 'account', LOCKOUT.threshold, LOCKOUT.windowMinutes);
          await audit(req, 'auth.login.failed', { locked: Boolean(until) });
          throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
        }

        if (outcome.kind === 'mfa_required') {
          const challenge = await provider.createMfaChallenge(outcome.ticket, outcome.factorId);
          if (!challenge) throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
          await audit(req, 'auth.mfa.challenged');
          // The half-finished session lives in a short-lived cookie, never in the
          // response body, so it cannot be captured from JavaScript.
          res.cookie(cookieSecure ? '__Host-df_mfa' : 'df_mfa',
            JSON.stringify({ t: outcome.ticket, f: outcome.factorId, c: challenge.challengeId }), {
              httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000,
            });
          res.status(200).json({ status: 'mfa_required' });
          return;
        }

        await db.clearFailures(accountKey);
        issueSession(res, outcome.session);
        await audit(req, 'auth.login.succeeded', undefined, outcome.session.userId);
        res.status(200).json({ status: 'ok' });
      } catch (error) {
        next(error);
      }
    },
  );

  // -------------------------------------------------------------- mfa verify
  router.post(
    '/mfa/verify',
    rateLimit(limiter, 'mfa-ip', LIMITS.mfa, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(mfaBody, req.body);
        const raw = req.cookiesParsed[cookieSecure ? '__Host-df_mfa' : 'df_mfa'];
        if (!raw) throw unauthorized('Your sign-in attempt expired. Please start again.');

        let pending: { t: string; f: string; c: string };
        try {
          pending = JSON.parse(raw);
        } catch {
          throw unauthorized('Your sign-in attempt expired. Please start again.');
        }

        const outcome = await provider.verifyMfa(pending.t, pending.f, pending.c, body.code);
        if (outcome.kind !== 'session') {
          await db.registerFailure(`mfa:${pending.f}`, 'account', LOCKOUT.threshold, LOCKOUT.windowMinutes);
          await audit(req, 'auth.mfa.failed');
          throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid.');
        }

        res.clearCookie(cookieSecure ? '__Host-df_mfa' : 'df_mfa', { path: '/' });
        issueSession(res, outcome.session);
        await audit(req, 'auth.mfa.succeeded', undefined, outcome.session.userId);
        res.status(200).json({ status: 'ok' });
      } catch (error) {
        next(error);
      }
    },
  );

  // ----------------------------------------------------------------- refresh
  router.post('/refresh', async (req, res, next) => {
    try {
      const token = req.cookiesParsed[refreshCookieName(cookieSecure)];
      if (!token) throw unauthorized();

      const session = await provider.refresh(token);
      if (!session) {
        // Refresh-token reuse or expiry: clear cookies so the browser stops
        // presenting a token the provider has already invalidated.
        clearSessionCookies(res, cookieSecure);
        throw unauthorized('Your session has expired. Please sign in again.');
      }

      issueSession(res, session);
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ logout
  // Logout deliberately does not require a valid session: if a token is already
  // expired the browser must still be able to clear its cookies.
  router.post('/logout', async (req, res, next) => {
    try {
      const token = req.cookiesParsed[refreshCookieName(cookieSecure)];
      const access = req.cookiesParsed[cookieSecure ? '__Host-df_at' : 'df_at'];
      clearSessionCookies(res, cookieSecure);
      if (access) {
        const verified = await verify(access);
        await provider.signOut(access, 'local').catch(() => undefined);
        if (verified) await audit(req, 'auth.logout', undefined, verified.userId);
      }
      void token;
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout-all', authenticate({ db, verify, cookieSecure }), async (req, res, next) => {
    try {
      const principal = req.principal!;
      // Uses the caller's own access token: the provider has no admin route for
      // revoking someone else's sessions (see SupabaseAuth.signOutEverywhere).
      await provider.signOutEverywhere(req.accessToken!);
      clearSessionCookies(res, cookieSecure);
      await audit(req, 'auth.logout_all', undefined, principal.userId);
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------- password recovery
  router.post(
    '/password/forgot',
    rateLimit(limiter, 'forgot-ip', LIMITS.passwordForgot, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(forgotBody, req.body);
        // Fire and forget, with the same 202 either way: whether the address exists
        // must not be observable in the status, the body or the timing (FR-102).
        void provider
          .sendPasswordReset(body.email, `${appBaseUrl}/reset-password`)
          .catch(() => undefined);
        await audit(req, 'auth.password.reset_requested');
        res.status(202).json({ status: 'accepted' });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/password/reset',
    rateLimit(limiter, 'reset-ip', LIMITS.passwordForgot, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(resetBody, req.body);
        const session = await provider.completePasswordReset(body.token, body.password);
        if (!session) {
          await audit(req, 'auth.password.reset_failed');
          throw badRequest('RESET_INVALID', 'That reset link is no longer valid. Please request a new one.');
        }
        // Changing a password ends every other session (design/02 §3.2). The
        // recovery exchange gave us a token for this user, so we can do it.
        await provider.signOutEverywhere(session.accessToken).catch(() => undefined);
        await audit(req, 'auth.password.reset_completed', undefined, session.userId);
        res.status(200).json({ status: 'ok' });
      } catch (error) {
        next(error);
      }
    },
  );

  // ------------------------------------------------------------- invitations
  /**
   * Tells the accept-invitation screen which restaurant and email the link is for,
   * so the person is not asked to type an address we already know. Unknown, expired,
   * revoked and already-used links are indistinguishable.
   */
  router.get('/invitations/check', async (req, res, next) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (token.length < 10) throw badRequest('INVITE_INVALID', 'This invitation link is not valid.');
      const invitation = await db.lookupInvitation(sha256(token));
      if (!invitation) throw badRequest('INVITE_INVALID', 'This invitation link is no longer valid.');
      res.status(200).json({ email: invitation.email, role: invitation.role });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/invitations/accept',
    rateLimit(limiter, 'accept-ip', LIMITS.invitationAccept, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(acceptBody, req.body);
        const tokenHash = sha256(body.token);

        const invitation = await db.lookupInvitation(tokenHash);
        if (!invitation) {
          await audit(req, 'auth.invitation.rejected', { reason: 'invalid_or_expired' });
          throw badRequest('INVITE_INVALID', 'This invitation link is no longer valid.');
        }

        // The account is created with the address from the invitation, never one
        // supplied by the caller, so a valid link cannot onboard a different person.
        const created = await provider.createUser(invitation.email, body.password);
        if ('conflict' in created) {
          await audit(req, 'auth.invitation.rejected', { reason: 'account_exists' });
          throw badRequest('INVITE_INVALID', 'This invitation link is no longer valid.');
        }

        const membershipId = await db.acceptInvitation(tokenHash, created.userId, body.displayName);
        if (!membershipId) {
          // Another request consumed the invitation between our check and this call.
          await audit(req, 'auth.invitation.rejected', { reason: 'race' }, created.userId);
          throw badRequest('INVITE_INVALID', 'This invitation link is no longer valid.');
        }

        const session = await provider.signInWithPassword(invitation.email, body.password);
        if (session.kind === 'session') issueSession(res, session.session);

        res.status(201).json({ status: 'ok', signedIn: session.kind === 'session' });
      } catch (error) {
        next(error);
      }
    },
  );

  // --------------------------------------------------------------------- me
  router.get('/me', authenticate({ db, verify, cookieSecure }), async (req, res, next) => {
    try {
      const principal = req.principal!;
      res.status(200).json({
        userId: principal.userId,
        kind: principal.kind,
        role: principal.kind === 'staff' ? principal.role : null,
        restaurantId: principal.kind === 'staff' ? principal.restaurantId : null,
        mfa: principal.aal === 'aal2',
        // Sent so the UI can hide controls. Cosmetic only: every one of these is
        // re-checked on the server for the request that uses it.
        permissions: permissionsFor(principal),
      });
    } catch (error) {
      next(error);
    }
  });

  void staffPrincipal;
  return router;
}
