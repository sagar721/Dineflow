import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Wordmark } from '@/brand/Logo.tsx';
import { Button, Card, CardBody, Field, Input } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';

type Mode =
  | { kind: 'request' }                              // no link: ask for an email
  | { kind: 'requested' }                            // email sent (or not — we never say)
  | { kind: 'set'; accessToken: string }             // arrived from the email link
  | { kind: 'link-error'; message: string }
  | { kind: 'done' };

/**
 * Reads what the email link brought, then removes it from the address bar at once.
 *
 * Supabase delivers the link's session in the URL fragment, which browsers never
 * send to any server. It is kept only in memory here and sent once, to our API.
 */
function readLink(): Mode {
  if (typeof window === 'undefined') return { kind: 'request' };
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const error = fragment.get('error_code') ?? query.get('error_code') ?? fragment.get('error');
  const accessToken = fragment.get('access_token');

  if (error || accessToken) window.history.replaceState(null, '', window.location.pathname);
  if (error) {
    return {
      kind: 'link-error',
      message: error === 'otp_expired'
        ? 'That link has expired. Links work once, for a limited time. Request a new one below.'
        : 'That link is not valid any more. Request a new one below.',
    };
  }
  return accessToken ? { kind: 'set', accessToken } : { kind: 'request' };
}

export function ResetPasswordPage() {
  const [mode, setMode] = useState<Mode>({ kind: 'request' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setMode(readLink()); }, []);

  async function requestLink(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/password/forgot', { method: 'POST', body: { email: email.trim() } });
      setMode({ kind: 'requested' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function setNewPassword(event: FormEvent) {
    event.preventDefault();
    if (mode.kind !== 'set') return;
    if (password.length < 12) return setError('Use at least 12 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    if (needsCode && !/^\d{6}$/.test(code.trim())) return setError('Enter the six-digit code from your authenticator app.');

    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/password/recovery', {
        method: 'POST',
        body: { accessToken: mode.accessToken, password, ...(needsCode ? { code: code.trim() } : {}) },
      });
      setPassword('');
      setConfirm('');
      setMode({ kind: 'done' });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'MFA_REQUIRED') {
        setNeedsCode(true);
        setError(null);
      } else if (caught instanceof ApiError && caught.code === 'RESET_INVALID') {
        setMode({ kind: 'link-error', message: caught.message });
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  const heading = mode.kind === 'set' ? 'Choose your password'
    : mode.kind === 'done' ? 'Password set'
    : 'Reset your password';

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center"><Wordmark size={32} /></div>
        <Card>
          <CardBody className="space-y-5">
            <h1 className="text-xl font-semibold text-text">{heading}</h1>

            {error ? (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p>
            ) : null}

            {mode.kind === 'link-error' ? (
              <p role="alert" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">{mode.message}</p>
            ) : null}

            {mode.kind === 'request' || mode.kind === 'link-error' ? (
              <form onSubmit={requestLink} className="space-y-4" noValidate>
                <p className="text-sm text-muted">We will email you a link to set a new password.</p>
                <Field label="Email address" required>
                  {({ id }) => (
                    <Input id={id} type="email" autoComplete="username" required value={email}
                      onChange={(event) => setEmail(event.target.value)} />
                  )}
                </Field>
                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Send link</Button>
              </form>
            ) : null}

            {mode.kind === 'requested' ? (
              // Deliberately the same whether or not the address has an account.
              <p role="status" className="text-sm text-muted">
                If an account uses that address, a link is on its way. It works once and expires after a
                short time. Check your spam folder if it does not arrive.
              </p>
            ) : null}

            {mode.kind === 'set' ? (
              <form onSubmit={setNewPassword} className="space-y-4" noValidate>
                <Field label="New password" required hint="At least 12 characters.">
                  {({ id, describedBy }) => (
                    <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
                      required autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
                  )}
                </Field>
                <Field label="Confirm new password" required>
                  {({ id }) => (
                    <Input id={id} type="password" autoComplete="new-password" required value={confirm}
                      onChange={(event) => setConfirm(event.target.value)} />
                  )}
                </Field>
                {needsCode ? (
                  <Field label="Code from your authenticator app" required
                    hint="Your account has two-step verification, so the link alone is not enough.">
                    {({ id, describedBy }) => (
                      <Input id={id} aria-describedby={describedBy} inputMode="numeric" autoComplete="one-time-code"
                        maxLength={6} autoFocus className="tabular tracking-[0.4em]" value={code}
                        onChange={(event) => setCode(event.target.value)} />
                    )}
                  </Field>
                ) : null}
                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Set password</Button>
              </form>
            ) : null}

            {mode.kind === 'done' ? (
              <div className="space-y-4">
                <p role="status" className="text-sm text-muted">
                  Your password is set, and you have been signed out everywhere else. Sign in with it now.
                </p>
                <Link to="/login" className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand px-5 text-base font-medium text-inverse hover:bg-brand-hover">
                  Go to sign in
                </Link>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
