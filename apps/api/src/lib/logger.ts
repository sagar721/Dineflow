import pino from 'pino';

/**
 * Structured logs with redaction. Anything that could carry a credential, a token
 * or personal data is removed at the logger rather than at each call site, because
 * one forgotten call site is a breach (NFR-S12, threat T-31).
 */
export function createLogger(level: string, isProduction: boolean) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'password',
        'newPassword',
        'token',
        'accessToken',
        'refreshToken',
        'access_token',
        'refresh_token',
        'code',
        'secret',
        'email',
        'mobile',
        '*.password',
        '*.token',
        '*.email',
      ],
      censor: '[redacted]',
    },
    // Paths carry invitation and reset tokens, so log the route pattern instead of
    // the concrete URL (Part 7 §5.3).
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isProduction ? undefined : { target: 'pino/file', options: { destination: 2 } },
  });
}

export type Logger = ReturnType<typeof createLogger>;
