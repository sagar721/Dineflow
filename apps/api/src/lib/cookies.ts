import type { Response } from 'express';

/**
 * Session cookies (D-04).
 *
 * `__Host-` prefix means the browser accepts them only when they are Secure,
 * host-only and Path=/ — an attacker on a sibling subdomain cannot set or overwrite
 * them. HttpOnly keeps them out of JavaScript, so an XSS bug cannot read a session.
 */
export const ACCESS_COOKIE = '__Host-df_at';
export const REFRESH_COOKIE = '__Host-df_rt';

// Development over plain HTTP cannot use __Host-, which requires Secure.
const name = (base: string, secure: boolean) => (secure ? base : base.replace('__Host-', ''));

export function accessCookieName(secure: boolean) { return name(ACCESS_COOKIE, secure); }
export function refreshCookieName(secure: boolean) { return name(REFRESH_COOKIE, secure); }

type SetOptions = { secure: boolean; accessMaxAgeSeconds: number; refreshMaxAgeSeconds: number };

export function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  { secure, accessMaxAgeSeconds, refreshMaxAgeSeconds }: SetOptions,
): void {
  const common = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  res.cookie(accessCookieName(secure), tokens.accessToken, { ...common, maxAge: accessMaxAgeSeconds * 1000 });
  res.cookie(refreshCookieName(secure), tokens.refreshToken, { ...common, maxAge: refreshMaxAgeSeconds * 1000 });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  const common = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  res.clearCookie(accessCookieName(secure), common);
  res.clearCookie(refreshCookieName(secure), common);
}

/** Minimal cookie parsing: avoids a dependency and never throws on malformed input. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}
