// Request context, authentication and authorization middleware.
//
// Order matters and is enforced by how these compose (design/02 §2): a request is
// authenticated (who are you), then given tenant context from the database (which
// restaurant, which role — never from the token or the client), then authorized.
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { can, type AnyPermissionKey, type Principal } from '@dineflow/shared';
import type { Database } from '../lib/db.ts';
import type { Verifier } from '../auth/jwt.ts';
import { accessCookieName, parseCookies } from '../lib/cookies.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      clientIp: string;
      cookiesParsed: Record<string, string>;
      accessToken?: string;
      principal?: Principal;
    }
  }
}

export function requestContext(trustProxyHops: number) {
  return function attach(req: Request, res: Response, next: NextFunction): void {
    req.requestId = randomUUID();
    req.clientIp = resolveClientIp(req, trustProxyHops);
    req.cookiesParsed = parseCookies(req.headers.cookie);
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}

/**
 * Takes the client IP from exactly the configured number of proxy hops. Reading the
 * whole `X-Forwarded-For` chain would let a caller prepend any address and evade
 * per-IP limits (design/02 §7).
 */
function resolveClientIp(req: Request, hops: number): string {
  if (hops <= 0) return req.socket.remoteAddress ?? 'unknown';
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length === 0) return req.socket.remoteAddress ?? 'unknown';
  const index = Math.max(0, chain.length - hops);
  return chain[index] ?? req.socket.remoteAddress ?? 'unknown';
}

type AuthDeps = { db: Database; verify: Verifier; cookieSecure: boolean };

/**
 * Establishes the principal for staff routes.
 *
 * The token proves identity only. Role, restaurant and whether the account is still
 * usable are read from the database on **every** request, so deactivating a user or
 * suspending a restaurant takes effect immediately even though their token is still
 * cryptographically valid (FR-104, FR-106).
 */
export function authenticate({ db, verify, cookieSecure }: AuthDeps) {
  return async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const token = req.cookiesParsed[accessCookieName(cookieSecure)];
      if (!token) return next(unauthorized());

      const verified = await verify(token);
      if (!verified) return next(unauthorized('Your session has expired. Please sign in again.'));

      const membership = await db.lookupMembership(verified.userId);
      if (!membership) return next(unauthorized());

      if (membership.isPlatformAdmin) {
        req.accessToken = token;
        req.principal = { kind: 'platform_admin', userId: verified.userId, aal: verified.aal };
        return next();
      }

      // Each of these is a deliberate, separate denial; none of them leaks which
      // one applied, because the message is the same.
      if (membership.staffStatus !== 'active') return next(unauthorized());
      if (membership.restaurantStatus !== 'active') return next(unauthorized());
      if (!membership.restaurantId || !membership.role) return next(unauthorized());

      req.accessToken = token;
      req.principal = {
        kind: 'staff',
        role: membership.role,
        restaurantId: membership.restaurantId,
        userId: verified.userId,
        aal: verified.aal,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Requires one permission from the shared matrix. Routes declare theirs explicitly. */
export function requirePermission(key: AnyPermissionKey) {
  return function authorize(req: Request, _res: Response, next: NextFunction): void {
    const principal = req.principal;
    if (!principal) return next(unauthorized());
    if (!can(principal, key)) return next(forbidden());
    next();
  };
}

/** Narrows a request to a staff principal, for handlers that need the tenant. */
export function staffPrincipal(req: Request): Extract<Principal, { kind: 'staff' }> {
  const principal = req.principal;
  if (!principal || principal.kind !== 'staff') throw forbidden();
  return principal;
}
