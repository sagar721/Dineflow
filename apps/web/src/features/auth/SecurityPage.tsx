import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck, Smartphone } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { useSession } from './SessionProvider.tsx';

type Status = { enabled: boolean; factors: { id: string; createdAt: string }[] };
type Setup = { factorId: string; qrCode: string; secret: string };

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'off' }
  | { kind: 'setting-up'; setup: Setup }
  | { kind: 'on'; since?: string; justEnabled: boolean };

/**
 * Two-step verification with an authenticator app.
 *
 * The key shown during setup exists only in this component's memory and the
 * person's app: it is never stored, logged or sent anywhere else, and it is dropped
 * the moment setup finishes or the page is left.
 */
export function SecurityPage() {
  const { state: session, refresh } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPlatformAdmin = session.status === 'signed-in' && session.session.kind === 'platform_admin';

  useEffect(() => {
    apiFetch<Status>('/auth/mfa/factors')
      .then((status) => setState(status.enabled
        ? { kind: 'on', since: status.factors[0]?.createdAt, justEnabled: false }
        : { kind: 'off' }))
      .catch((caught) => setState({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load your security settings.' }));
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const setup = await apiFetch<Setup>('/auth/mfa/enroll', { method: 'POST' });
      setCode('');
      setShowKey(false);
      setState({ kind: 'setting-up', setup });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (state.kind !== 'setting-up' || busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the six-digit code shown in your app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/mfa/enroll/verify', {
        method: 'POST', body: { factorId: state.setup.factorId, code: code.trim() },
      });
      // Drop the key from memory straight away; it is not needed again.
      setState({ kind: 'on', justEnabled: true });
      setCode('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code did not work.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Account security" description="Protect your account with a code from your phone.">
      <div className="max-w-2xl">
        {isPlatformAdmin && state.kind !== 'on' ? (
          <p role="note" className="mb-4 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
            Platform administrator actions stay locked until two-step verification is on.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p>
        ) : null}

        <Card>
          <CardHeader
            title="Two-step verification"
            description="After your password, you also enter a code from an authenticator app."
            actions={state.kind === 'on' ? <Badge tone="success">On</Badge> : state.kind === 'loading' ? undefined : <Badge>Off</Badge>}
          />
          <CardBody>
            {state.kind === 'loading' ? (
              <div aria-busy="true" className="space-y-2">
                <span className="sr-only">Checking your security settings</span>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-11 w-40" />
              </div>
            ) : null}

            {state.kind === 'error' ? (
              <p role="alert" className="text-sm font-medium text-danger">{state.message}</p>
            ) : null}

            {state.kind === 'off' ? (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  You will need an authenticator app on your phone, such as Google Authenticator, Microsoft
                  Authenticator or 1Password.
                </p>
                <Button variant="primary" iconLeft={<Smartphone className="size-4" />} loading={busy} onClick={start}>
                  Set up an authenticator app
                </Button>
              </div>
            ) : null}

            {state.kind === 'setting-up' ? (
              <form onSubmit={confirm} className="space-y-5" noValidate>
                <ol className="list-decimal space-y-4 pl-5 text-sm text-text">
                  <li>
                    <p>Open your authenticator app and scan this code.</p>
                    <img
                      src={state.setup.qrCode}
                      alt="QR code to add DineFlow to your authenticator app"
                      className="mt-3 size-48 rounded-md border border-border bg-white p-2"
                    />
                    <div className="mt-3">
                      {showKey ? (
                        <>
                          <p className="text-xs text-muted">Or type this key into the app:</p>
                          <code className="mt-1 block break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-sm tracking-wider text-text">
                            {state.setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                          </code>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setShowKey(true)}>
                          Can't scan? Show the key to type in
                        </Button>
                      )}
                    </div>
                  </li>
                  <li>
                    <Field label="Enter the six-digit code from the app" required>
                      {({ id }) => (
                        <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                          className="w-40 tabular tracking-[0.4em]" value={code}
                          onChange={(event) => setCode(event.target.value)} />
                      )}
                    </Field>
                  </li>
                </ol>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="primary" loading={busy}>Turn on two-step verification</Button>
                  <Button onClick={() => { setState({ kind: 'off' }); setError(null); }} disabled={busy}>Cancel</Button>
                </div>
                <p className="text-xs text-muted">
                  Keep your phone safe. If you lose it, you will need another administrator's help to get back in.
                </p>
              </form>
            ) : null}

            {state.kind === 'on' ? (
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
                <div className="text-sm">
                  <p className="font-medium text-text" role={state.justEnabled ? 'status' : undefined}>
                    {state.justEnabled ? 'Two-step verification is now on.' : 'Two-step verification is on.'}
                  </p>
                  <p className="mt-1 text-muted">
                    You will be asked for a code from your authenticator app each time you sign in.
                  </p>
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </Page>
  );
}
