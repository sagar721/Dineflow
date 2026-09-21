// Authentication routes (design/02 §6.1, PRD FR-100 … FR-105).
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
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
const enrollVerifyBody = z
  .object({ factorId: z.string().uuid(), code: z.string().trim().regex(/^\d{6}$/) })
  .strict();
// The access token a recovery link delivers in its URL fragment. Bounded, like any
// other bearer token the API accepts.
const recoveryBody = z
  .object({
    accessToken: z.string().min(20).max(8192),
    password,
    // Required only when the account has an authenticator: the provider refuses to
    // change such an account's password without the second factor (verified live).
    code: z.string().trim().regex(/^\d{6}$/).optional(),
  })
  .strict();

/**
 * Sessions that may set a password without knowing the old one. Supabase marks a
 * session from a recovery link as "otp" (verified live), the same method as an
 * emailed one-time code: both prove control of the inbox, which is what a reset
 * rests on. "recovery" is accepted for providers that label it that way.
 */
const RECOVERY_METHODS = new Set(['recovery', 'otp']);
/** How recently that proof must have happened: long enough to open the email and type a password. */
const RECOVERY_WINDOW_SECONDS = 15 * 60;
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

        // Failed codes were always counted, but until now never checked: a six-digit
        // code could be guessed without limit beyond the per-IP throttle.
        if (await db.checkLock(`mfa:${pending.f}`)) {
          await audit(req, 'auth.mfa.blocked', { reason: 'locked' });
          throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid.');
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

  // ------------------------------------------------------- authenticator setup
  /** Whether the signed-in user has an authenticator. Never includes a secret. */
  router.get('/mfa/factors', authenticate({ db, verify, cookieSecure }), async (req, res, next) => {
    try {
      const factors = await provider.listFactors(req.accessToken!);
      const verified = factors.filter((factor) => factor.status === 'verified');
      res.status(200).json({
        enabled: verified.length > 0,
        factors: verified.map((factor) => ({ id: factor.id, type: factor.type, createdAt: factor.createdAt })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Starts setting up an authenticator app. Returns the QR code and the key to type
   * in by hand, once: they exist only in this response and the user's app, and are
   * never stored or logged here. Responses are `no-store`, so no cache keeps them.
   */
  router.post(
    '/mfa/enroll',
    rateLimit(limiter, 'mfa-enroll-ip', LIMITS.mfa, (req) => req.clientIp),
    authenticate({ db, verify, cookieSecure }),
    async (req, res, next) => {
      try {
        const principal = req.principal!;
        const factors = await provider.listFactors(req.accessToken!);

        // One authenticator per account in v1. Replacing it is a recovery process,
        // not something a session that might be stolen should be able to do.
        if (factors.some((factor) => factor.status === 'verified')) {
          throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already on for this account.');
        }
        // A setup started and abandoned earlier leaves an unverified factor behind;
        // clear it so it cannot linger or block this attempt.
        for (const factor of factors.filter((f) => f.status !== 'verified')) {
          await provider.deleteFactor(req.accessToken!, factor.id);
        }

        const enrolled = await provider.enrollTotp(req.accessToken!, 'DineFlow');
        if (!enrolled) throw new AppError(502, 'MFA_SETUP_FAILED', 'Could not start the setup. Please try again.');

        const svg = await QRCode.toString(enrolled.uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
        const qrCode = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

        await audit(req, 'auth.mfa.enroll_started', undefined, principal.userId);
        res.status(200).json({ factorId: enrolled.factorId, qrCode, secret: enrolled.secret });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * Confirms the setup with the first code from the app. Success upgrades this
   * session to aal2 on the spot, so a platform admin can act immediately.
   */
  router.post(
    '/mfa/enroll/verify',
    rateLimit(limiter, 'mfa-enroll-verify-ip', LIMITS.mfa, (req) => req.clientIp),
    authenticate({ db, verify, cookieSecure }),
    async (req, res, next) => {
      try {
        const principal = req.principal!;
        const body = parse(enrollVerifyBody, req.body);
        const lockKey = `mfa:${body.factorId}`;

        if (await db.checkLock(lockKey)) {
          await audit(req, 'auth.mfa.blocked', { reason: 'locked', during: 'enrollment' }, principal.userId);
          throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid.');
        }

        // The provider ties the factor to the token's user, so another account's
        // factor id cannot be confirmed from this session.
        const challenge = await provider.createMfaChallenge(req.accessToken!, body.factorId);
        const outcome = challenge
          ? await provider.verifyMfa(req.accessToken!, body.factorId, challenge.challengeId, body.code)
          : ({ kind: 'invalid' } as const);

        if (outcome.kind !== 'session') {
          await db.registerFailure(lockKey, 'account', LOCKOUT.threshold, LOCKOUT.windowMinutes);
          await audit(req, 'auth.mfa.enroll_failed', undefined, principal.userId);
          throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid. Check the time on your phone and try the newest code.');
        }

        await db.clearFailures(lockKey);
        issueSession(res, outcome.session);
        await audit(req, 'auth.mfa.enrolled', undefined, principal.userId);
        res.status(200).json({ status: 'ok' });
      } catch (error) {
        next(error);
      }
    },
  );

  // ---------------------------------------------------- set password from link
  /**
   * Sets a password from a recovery (or first-time setup) email. The link's session
   * reaches the browser in the URL fragment — never sent to any server — and is
   * handed to us once, here. It must genuinely be a recovery session: an ordinary
   * session cannot be used to change a password without the old one.
   */
  router.post(
    '/password/recovery',
    rateLimit(limiter, 'recovery-ip', LIMITS.passwordForgot, (req) => req.clientIp),
    async (req, res, next) => {
      try {
        const body = parse(recoveryBody, req.body);
        const verified = await verify(body.accessToken);
        const now = Math.floor(Date.now() / 1000);
        // A proof of inbox control, and a recent one: an old one-time-code session
        // cannot be kept and used later to change the password.
        const isRecovery = verified?.amr.some((entry) => RECOVERY_METHODS.has(entry.method)
          && entry.at !== null && now - entry.at <= RECOVERY_WINDOW_SECONDS) ?? false;
        if (!verified || !isRecovery) {
          await audit(req, 'auth.password.reset_failed', { reason: verified ? 'not_a_recovery_session' : 'invalid_link' });
          throw badRequest('RESET_INVALID', 'That link is no longer valid. Please request a new one.');
        }

        // An account with an authenticator needs its code too. Supabase enforces this
        // (it refuses a password change at aal1), and it is the right rule: control
        // of the inbox alone must not be enough to take over a protected account.
        let sessionToken = body.accessToken;
        const factor = (await provider.listFactors(body.accessToken)).find((f) => f.status === 'verified');
        if (factor) {
          if (!body.code) {
            throw new AppError(401, 'MFA_REQUIRED', 'Enter the code from your authenticator app to set a new password.');
          }
          const lockKey = `mfa:${factor.id}`;
          if (await db.checkLock(lockKey)) {
            await audit(req, 'auth.mfa.blocked', { reason: 'locked', during: 'password_reset' }, verified.userId);
            throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid.');
          }
          const challenge = await provider.createMfaChallenge(body.accessToken, factor.id);
          const upgraded = challenge
            ? await provider.verifyMfa(body.accessToken, factor.id, challenge.challengeId, body.code)
            : ({ kind: 'invalid' } as const);
          if (upgraded.kind !== 'session') {
            await db.registerFailure(lockKey, 'account', LOCKOUT.threshold, LOCKOUT.windowMinutes);
            await audit(req, 'auth.password.reset_failed', { reason: 'bad_second_factor' }, verified.userId);
            throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was not valid.');
          }
          await db.clearFailures(lockKey);
          sessionToken = upgraded.session.accessToken;
        }

        const changed = await provider.setPasswordWithRecoverySession(sessionToken, body.password);
        if (!changed) {
          await audit(req, 'auth.password.reset_failed', { reason: 'provider_refused' }, verified.userId);
          throw badRequest('RESET_REFUSED', 'That password could not be used. Try a longer one that you have not used before.');
        }

        // Ends every session, including the one the link created: the person signs
        // in afresh with the new password (and their authenticator, if they have one).
        await provider.signOutEverywhere(sessionToken).catch(() => undefined);
        await audit(req, 'auth.password.reset_completed', { withSecondFactor: Boolean(factor) }, verified.userId);
        res.status(200).json({ status: 'ok' });
      } catch (error) {
        next(error);
      }
    },
  );

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
