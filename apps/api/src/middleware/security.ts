// Transport-level protections: security headers, CORS and the CSRF defence.
import type { NextFunction, Request, Response } from 'express';
import { AppError, forbidden, tooManyRequests } from '../lib/errors.ts';
import type { RateLimiter } from '../lib/rate-limit.ts';
import type { Logger } from '../lib/logger.ts';

/**
 * Written by hand rather than pulled from a dependency: this API serves JSON only,
 * so the useful set is short and worth being able to read at a glance.
 */
export function securityHeaders() {
  return function headers(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('cross-origin-resource-policy', 'same-site');
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // Responses carry session state and personal data; no shared cache may keep them.
    res.setHeader('cache-control', 'no-store');
    res.removeHeader('x-powered-by');
    next();
  };
}

/** A single allow-listed origin with credentials. No wildcard, ever. */
export function cors(allowedOrigin: string) {
  return function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    if (origin && origin === allowedOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,x-dineflow-client');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      // An unrecognised origin gets no CORS headers, so the browser blocks the call.
      res.status(origin === allowedOrigin ? 204 : 403).end();
      return;
    }
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated writes (design/02 §3.4).
 *
 * Three independent conditions, any one of which a cross-site attacker fails: a
 * custom header they cannot set without a preflight we would deny, a JSON content
 * type, and an Origin that matches the allow-list.
 */
export function csrfGuard(allowedOrigin: string) {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return function csrf(req: Request, _res: Response, next: NextFunction): void {
    if (SAFE.has(req.method)) return next();

    if (req.headers['x-dineflow-client'] !== 'web') {
      return next(forbidden('This request could not be verified. Please reload the page and try again.'));
    }

    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
    if (contentType && contentType !== 'application/json') {
      return next(forbidden('This request could not be verified. Please reload the page and try again.'));
    }

    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      return next(forbidden('This request could not be verified. Please reload the page and try again.'));
    }

    next();
  };
}

/** Applies a named rate limit, keyed by whatever identifies the caller best. */
export function rateLimit(
  limiter: RateLimiter,
  name: string,
  config: { limit: number; windowSeconds: number },
  keyOf: (req: Request) => string,
) {
  return function limit(req: Request, res: Response, next: NextFunction): void {
    const result = limiter.consume(`${name}:${keyOf(req)}`, config.limit, config.windowSeconds);
    if (!result.allowed) {
      res.setHeader('retry-after', String(result.retryAfterSeconds));
      return next(tooManyRequests('Too many attempts. Please wait a moment and try again.', result.retryAfterSeconds));
    }
    next();
  };
}

/**
 * The single place an error becomes a response. Known errors keep their message;
 * anything else becomes a generic 500 with the request id, because an unexpected
 * error's message may contain SQL, a file path or a token (NFR-S09).
 */
export function errorHandler(logger: Logger) {
  return function handle(error: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (error instanceof AppError) {
      if (error.status >= 500) {
        logger.error({ requestId: req.requestId, code: error.code, cause: error.cause }, 'request failed');
      }
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    logger.error(
      { requestId: req.requestId, route: req.route?.path ?? req.path, err: error },
      'unhandled error',
    );
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        requestId: req.requestId,
      },
    });
  };
}
