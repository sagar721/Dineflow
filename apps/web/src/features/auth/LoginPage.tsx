import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Wordmark } from '@/brand/Logo.tsx';
import { Button, Card, CardBody, Field, Input } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { useSession } from './SessionProvider.tsx';

type Step = 'credentials' | 'mfa';

/**
 * Where to go after signing in. A platform administrator without two-step
 * verification can do nothing until it is set up, so they go straight there.
 */
async function landingFor(): Promise<string> {
  try {
    const me = await apiFetch<{ kind: string; mfa: boolean }>('/auth/me');
    return me.kind === 'platform_admin' && !me.mfa ? '/security' : '/';
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ status: 'ok' | 'mfa_required' }>('/auth/login', {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      if (result.status === 'mfa_required') {
        setStep('mfa');
        setPassword('');
        return;
      }
      await refresh();
      navigate(await landingFor(), { replace: true });
    } catch (caught) {
      // The API deliberately returns one message for every failure, so there is
      // nothing here to expand on: guessing would leak what it withholds.
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/mfa/verify', { method: 'POST', body: { code: code.trim() } });
      await refresh();
      navigate(await landingFor(), { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Wordmark size={32} />
        </div>

        <Card>
          <CardBody className="space-y-5">
            <div>
              <h1 className="text-xl font-semibold text-text">
                {step === 'credentials' ? 'Sign in' : 'Enter your code'}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {step === 'credentials'
                  ? 'Use the email address your restaurant invited.'
                  : 'Open your authenticator app and enter the six-digit code.'}
              </p>
            </div>

            {/* Announced to screen readers when it appears, not only shown in red. */}
            {error ? (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">
                {error}
              </p>
            ) : null}

            {step === 'credentials' ? (
              <form onSubmit={submitCredentials} className="space-y-4" noValidate>
                <Field label="Email address" required>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="email"
                      name="email"
                      autoComplete="username"
                      autoFocus
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  )}
                </Field>

                <Field label="Password" required>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="password"
                      name="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  )}
                </Field>

                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                  Sign in
                </Button>
              </form>
            ) : (
              <form onSubmit={submitCode} className="space-y-4" noValidate>
                <Field label="Six-digit code" required>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\d{6}"
                      maxLength={6}
                      autoFocus
                      required
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      className="tabular tracking-[0.4em]"
                    />
                  )}
                </Field>

                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                  Verify
                </Button>
                <Button type="button" className="w-full" onClick={() => { setStep('credentials'); setError(null); }}>
                  Back
                </Button>
              </form>
            )}
          </CardBody>
        </Card>

        <p className="mt-4 text-center text-sm">
          <Link to="/reset-password" className="font-medium text-brand hover:underline">Forgot your password?</Link>
        </p>
      </div>
    </main>
  );
}
