// Access-token verification.
//
// The cookie the browser sends is a bearer token; it is worth exactly as much as our
// verification of it. Signature, expiry, issuer and audience are all checked, and a
// token that fails any of them is treated as absent rather than as a hint.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type VerifiedToken = {
  userId: string;
  /** Authentication assurance level: aal2 means a second factor was presented. */
  aal: 'aal1' | 'aal2';
  sessionId?: string;
  expiresAt: number;
  /**
   * How this session was authenticated ("password", "totp", "recovery", ...), from
   * the token's `amr` claim. Used to insist that a password is only ever set from
   * a genuine recovery link, not from an ordinary session.
   */
  methods: string[];
  /** When each method was used, in seconds since the epoch, where the token says. */
  amr: { method: string; at: number | null }[];
};

export type Verifier = (token: string) => Promise<VerifiedToken | null>;

type VerifierOptions = {
  supabaseUrl: string;
  /** Legacy HS256 projects only. When absent, JWKS is used. */
  jwtSecret?: string;
  /** Injectable clock skew tolerance, in seconds. */
  clockToleranceSeconds?: number;
};

export function createVerifier({ supabaseUrl, jwtSecret, clockToleranceSeconds = 5 }: VerifierOptions): Verifier {
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;

  const key = jwtSecret
    ? new TextEncoder().encode(jwtSecret)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async function verify(token: string): Promise<VerifiedToken | null> {
    if (!token || token.length > 8192) return null;
    try {
      const { payload } = await jwtVerify(token, key as never, {
        issuer,
        audience: 'authenticated',
        clockTolerance: clockToleranceSeconds,
        // HS256 for legacy projects, asymmetric for current ones. Listing the
        // algorithms stops an attacker choosing "none" or swapping families.
        algorithms: jwtSecret ? ['HS256'] : ['ES256', 'RS256'],
      });
      return toVerified(payload);
    } catch {
      // Expired, tampered, wrong issuer, wrong audience — all the same to a caller.
      return null;
    }
  };
}

function toVerified(payload: JWTPayload): VerifiedToken | null {
  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) return null;

  // Anything other than an explicit aal2 is treated as aal1. A missing or unknown
  // value must never be read as "second factor satisfied".
  const rawAal = (payload as { aal?: unknown }).aal;
  const aal: 'aal1' | 'aal2' = rawAal === 'aal2' ? 'aal2' : 'aal1';

  const sessionId = typeof (payload as { session_id?: unknown }).session_id === 'string'
    ? (payload as { session_id: string }).session_id
    : undefined;

  const rawAmr = (payload as { amr?: unknown }).amr;
  const amr = Array.isArray(rawAmr)
    ? rawAmr.flatMap((entry) => {
        if (typeof entry === 'string') return [{ method: entry, at: null }];
        const method = (entry as { method?: unknown })?.method;
        const at = (entry as { timestamp?: unknown })?.timestamp;
        return typeof method === 'string' ? [{ method, at: typeof at === 'number' ? at : null }] : [];
      })
    : [];

  return {
    userId, aal, sessionId, expiresAt: typeof payload.exp === 'number' ? payload.exp : 0,
    methods: amr.map((entry) => entry.method), amr,
  };
}
