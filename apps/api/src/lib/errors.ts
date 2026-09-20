/**
 * One error shape for the whole API (design/02 §1).
 *
 * The message is written for the person reading it and must never contain SQL, a
 * stack trace, an internal identifier, or anything that tells an attacker whether
 * an account or another tenant's object exists.
 */
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'FORBIDDEN', message);
/** Used for wrong-tenant objects too: existence itself is sensitive. */
export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (message: string, retryAfterSeconds?: number) => {
  const error = new AppError(429, 'RATE_LIMITED', message);
  error.details = retryAfterSeconds ? { retryAfterSeconds } : undefined;
  return error;
};

/** The one message every failed sign-in gets, whatever actually went wrong. */
export const INVALID_CREDENTIALS = 'Invalid email or password.';
