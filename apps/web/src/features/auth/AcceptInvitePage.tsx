import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Wordmark } from '@/brand/Logo.tsx';
import { Button, Card, CardBody, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { useSession } from './SessionProvider.tsx';

type Invitation = { email: string; role: string };

/**
 * The token arrives in the URL fragment, which the browser never sends to a server
 * and which stays out of access logs and Referer headers.
 */
function tokenFromHash(): string {
  // Guarded so the component can also be rendered without a DOM (the render smoke
  // test, and any future prerendering).
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('token') ?? '';
}

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [token] = useState(tokenFromHash);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [checking, setChecking] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This invitation link is not valid.');
      setChecking(false);
      return;
    }
    apiFetch<Invitation>(`/auth/invitations/check?token=${encodeURIComponent(token)}`)
      .then(setInvitation)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'This invitation link is not valid.'))
      .finally(() => setChecking(false));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) {
      setError('Please choose a password of at least 12 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/invitations/accept', {
        method: 'POST',
        body: { token, password, displayName: displayName.trim() },
      });
      // Clear the token from the address bar before the next screen renders.
      if (typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname);
      await refresh();
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center"><Wordmark size={32} /></div>
        <Card>
          <CardBody className="space-y-5">
            <h1 className="text-xl font-semibold text-text">Set up your account</h1>

            {checking ? (
              <div aria-busy="true" className="space-y-2">
                <span className="sr-only">Checking your invitation</span>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">
                {error}
              </p>
            ) : null}

            {invitation ? (
              <form onSubmit={submit} className="space-y-4" noValidate>
                <p className="text-sm text-muted">
                  You have been invited as <span className="font-medium text-text">{invitation.role}</span> for{' '}
                  <span className="font-medium text-text">{invitation.email}</span>.
                </p>

                <Field label="Your name" required>
                  {({ id }) => (
                    <Input id={id} required autoFocus value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)} />
                  )}
                </Field>

                <Field label="Choose a password" required hint="At least 12 characters.">
                  {({ id, describedBy }) => (
                    <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
                      required value={password} onChange={(event) => setPassword(event.target.value)} />
                  )}
                </Field>

                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                  Create my account
                </Button>
              </form>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
