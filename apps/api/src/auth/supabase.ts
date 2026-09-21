// Supabase Auth (GoTrue) client — the identity provider (D-04, FR-100).
//
// Called **only** from the API server. The service key lives in this process's
// environment and never reaches the browser; the browser never talks to Supabase.
//
// Passwords pass through this module to the provider and are never stored, hashed
// or logged by us: hashing, breach checks and reset tokens are the provider's job.
import { AppError } from '../lib/errors.ts';

export type SupabaseConfig = {
  url: string;
  anonKey: string;
  serviceKey: string;
  /** Injectable for tests, which point it at a stub GoTrue server. */
  fetchImpl?: typeof fetch;
};

export type ProviderSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
};

export type LoginOutcome =
  | { kind: 'session'; session: ProviderSession }
  | { kind: 'mfa_required'; factorId: string; ticket: string }
  | { kind: 'invalid' };

/** Provider failures we can act on, separated from failures we can only report. */
export class ProviderUnavailable extends AppError {
  constructor(detail: string) {
    super(503, 'PROVIDER_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again shortly.');
    this.details = undefined;
    this.cause = detail;
  }
}

export class SupabaseAuth {
  #url: string;
  #anonKey: string;
  #serviceKey: string;
  #fetch: typeof fetch;

  constructor(config: SupabaseConfig) {
    this.#url = config.url.replace(/\/$/, '');
    this.#anonKey = config.anonKey;
    this.#serviceKey = config.serviceKey;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async #call(
    path: string,
    init: {
      method: string; body?: unknown; bearer?: string; useServiceKey?: boolean;
      /**
       * For calls on a specific factor, a 404 is a real answer — "no such factor for
       * this user" — not a missing endpoint. Only those calls set this.
       */
      notFoundIsAnswer?: boolean;
    },
  ): Promise<{ status: number; body: any }> {
    const apikey = init.useServiceKey ? this.#serviceKey : this.#anonKey;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/auth/v1${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          apikey,
          authorization: `Bearer ${init.bearer ?? apikey}`,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // A network failure must not look like a wrong password, or staff will keep
      // retyping a correct one while the provider is down.
      throw new ProviderUnavailable((error as Error).message);
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 200) };
      }
    }
    if (response.status >= 500) throw new ProviderUnavailable(`provider returned ${response.status}`);
    // A 404 or 405 means we called an endpoint the provider does not have. Left
    // unchecked that looks exactly like success to a caller that ignores the
    // status, which is how a revocation call silently did nothing until a live
    // test caught it. Fail loudly instead.
    if ((response.status === 404 && !init.notFoundIsAnswer) || response.status === 405) {
      throw new ProviderUnavailable(`provider has no endpoint ${init.method} ${path}`);
    }
    return { status: response.status, body };
  }

  /** Exchanges credentials for a session, or reports that MFA is required. */
  async signInWithPassword(email: string, password: string): Promise<LoginOutcome> {
    const { status, body } = await this.#call('/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });

    if (status === 400 || status === 401) return { kind: 'invalid' };
    if (status !== 200) throw new ProviderUnavailable(`unexpected login status ${status}`);

    // A session at aal1 for an account that has a verified factor is not a completed
    // sign-in: the second factor must be presented before we issue our cookies.
    const factors: { id: string; status: string }[] = body?.user?.factors ?? [];
    const verified = factors.find((factor) => factor.status === 'verified');
    if (verified && body?.access_token) {
      return { kind: 'mfa_required', factorId: verified.id, ticket: body.access_token };
    }

    return { kind: 'session', session: toSession(body) };
  }

  /** Completes an MFA challenge, returning an aal2 session. */
  async verifyMfa(ticket: string, factorId: string, challengeId: string, code: string): Promise<LoginOutcome> {
    const { status, body } = await this.#call(`/factors/${encodeURIComponent(factorId)}/verify`, {
      method: 'POST',
      bearer: ticket,
      body: { challenge_id: challengeId, code },
      notFoundIsAnswer: true,
    });
    if (status === 400 || status === 401 || status === 404 || status === 422) return { kind: 'invalid' };
    if (status !== 200) throw new ProviderUnavailable(`unexpected mfa status ${status}`);
    return { kind: 'session', session: toSession(body) };
  }

  async createMfaChallenge(ticket: string, factorId: string): Promise<{ challengeId: string } | null> {
    const { status, body } = await this.#call(`/factors/${encodeURIComponent(factorId)}/challenge`, {
      method: 'POST',
      bearer: ticket,
      notFoundIsAnswer: true,
    });
    if (status !== 200) return null;
    return { challengeId: body.id };
  }

  async refresh(refreshToken: string): Promise<ProviderSession | null> {
    const { status, body } = await this.#call('/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    if (status !== 200) return null;
    return toSession(body);
  }

  /** Revokes the session behind this access token. */
  async signOut(accessToken: string, scope: 'local' | 'global' = 'local'): Promise<void> {
    await this.#call(`/logout?scope=${scope}`, { method: 'POST', bearer: accessToken });
  }

  /**
   * Revokes every session belonging to the holder of this access token.
   *
   * GoTrue has no admin endpoint for revoking another user's sessions — verified
   * against a live project, where `DELETE /admin/users/{id}/sessions` returns 404 —
   * so this needs the user's own token. Locking out *another* user (deactivation)
   * is handled by the membership check that runs on every request, which denies
   * them at our API even though their token is still valid.
   */
  async signOutEverywhere(accessToken: string): Promise<void> {
    await this.#call('/logout?scope=global', { method: 'POST', bearer: accessToken });
  }

  /**
   * Creates a confirmed user. Used when an invitation is accepted: the emailed link
   * already proves the person controls the address, so a second confirmation email
   * would only add a step.
   */
  async createUser(email: string, password: string): Promise<{ userId: string } | { conflict: true }> {
    const { status, body } = await this.#call('/admin/users', {
      method: 'POST',
      useServiceKey: true,
      bearer: this.#serviceKey,
      body: { email, password, email_confirm: true },
    });
    if (status === 409 || status === 422) return { conflict: true };
    if (status !== 200 && status !== 201) throw new ProviderUnavailable(`unexpected create-user status ${status}`);
    return { userId: body.id };
  }

  // ------------------------------------------------------------------ MFA setup

  /** The user's second factors. Secrets are never part of this listing. */
  async listFactors(accessToken: string): Promise<{ id: string; type: string; status: string; createdAt: string }[]> {
    const { status, body } = await this.#call('/user', { method: 'GET', bearer: accessToken });
    if (status !== 200) return [];
    return (body?.factors ?? []).map((factor: any) => ({
      id: String(factor.id),
      type: String(factor.factor_type ?? factor.type ?? 'totp'),
      status: String(factor.status),
      createdAt: String(factor.created_at ?? ''),
    }));
  }

  /**
   * Starts enrolling an authenticator app. The QR code and secret in the result
   * are shown to the user once, to scan; they are never stored or logged by us.
   */
  async enrollTotp(accessToken: string, issuer: string): Promise<{ factorId: string; uri: string; secret: string } | null> {
    const { status, body } = await this.#call('/factors', {
      method: 'POST',
      bearer: accessToken,
      // A distinct friendly name each time: the provider refuses a duplicate name,
      // and an abandoned earlier attempt must not block a new one.
      body: { factor_type: 'totp', issuer, friendly_name: `Authenticator ${new Date().toISOString()}` },
    });
    if (status !== 200 && status !== 201) return null;
    // Supabase also returns a QR drawing, but as raw SVG of several hundred KB.
    // The standard otpauth:// URI carries the same information; we draw a compact
    // QR from it instead.
    const uri = body?.totp?.uri;
    const secret = body?.totp?.secret;
    if (typeof body?.id !== 'string' || typeof uri !== 'string' || !uri.startsWith('otpauth://totp/')
        || typeof secret !== 'string') return null;
    return { factorId: body.id, uri, secret };
  }

  /** Removes a factor. Used to clear setups that were started and never finished. */
  async deleteFactor(accessToken: string, factorId: string): Promise<boolean> {
    const { status } = await this.#call(`/factors/${encodeURIComponent(factorId)}`, {
      method: 'DELETE',
      bearer: accessToken,
      notFoundIsAnswer: true,
    });
    return status === 200 || status === 204;
  }

  /**
   * Sets a new password using the session a recovery link produced. The caller
   * must have checked that the token really came from a recovery link.
   */
  async setPasswordWithRecoverySession(accessToken: string, newPassword: string): Promise<boolean> {
    const { status } = await this.#call('/user', {
      method: 'PUT',
      bearer: accessToken,
      body: { password: newPassword },
    });
    return status === 200;
  }

  /**
   * Creates an account with no password and a confirmed email. The owner sets the
   * password themselves from a recovery email, so it never passes through anyone
   * else's hands.
   */
  async createUserWithoutPassword(email: string): Promise<{ userId: string } | { conflict: true }> {
    const { status, body } = await this.#call('/admin/users', {
      method: 'POST',
      useServiceKey: true,
      bearer: this.#serviceKey,
      body: { email, email_confirm: true },
    });
    if (status === 409 || status === 422) return { conflict: true };
    if (status !== 200 && status !== 201) throw new ProviderUnavailable(`unexpected create-user status ${status}`);
    return { userId: body.id };
  }

  /** Sends a password-reset email. The response never reveals whether it existed. */
  async sendPasswordReset(email: string, redirectTo: string): Promise<void> {
    await this.#call(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      body: { email },
    });
  }

  /** Applies a new password using the one-time token from the reset email. */
  async completePasswordReset(recoveryToken: string, newPassword: string): Promise<ProviderSession | null> {
    const verified = await this.#call('/verify', {
      method: 'POST',
      body: { type: 'recovery', token: recoveryToken },
    });
    if (verified.status !== 200 || !verified.body?.access_token) return null;

    const updated = await this.#call('/user', {
      method: 'PUT',
      bearer: verified.body.access_token,
      body: { password: newPassword },
    });
    if (updated.status !== 200) return null;
    return toSession(verified.body);
  }
}

function toSession(body: any): ProviderSession {
  if (!body?.access_token || !body?.refresh_token || !body?.user?.id) {
    throw new ProviderUnavailable('provider returned an incomplete session');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in ?? 900),
    userId: body.user.id,
  };
}
