import { useEffect, useState } from 'react';
import { Button, Dialog, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { QrCard, type QrPayload } from './QrCard.tsx';
import { tablesApi, type DiningTable } from './api.ts';

type Props = {
  open: boolean;
  table: DiningTable | null;
  restaurantName: string;
  onClose: () => void;
  /** Called after a change, so the list can refresh its QR column. */
  onChanged: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'ready'; qr: QrPayload }
  | { kind: 'error'; message: string };

type Confirming = 'regenerate' | 'revoke' | null;

export function QrDialog({ open, table, restaurantName, onClose, onChanged }: Props) {
  const { may } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !table) return;
    setConfirming(null);
    setState({ kind: 'loading' });
    tablesApi.getQr(table.id)
      .then(({ qr }) => setState({ kind: 'ready', qr }))
      .catch((caught) => {
        if (caught instanceof ApiError && caught.status === 404) setState({ kind: 'none' });
        else setState({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load the QR code.' });
      });
  }, [open, table]);

  async function act(action: () => Promise<QrPayload | null>) {
    setBusy(true);
    try {
      const qr = await action();
      setState(qr ? { kind: 'ready', qr } : { kind: 'none' });
      setConfirming(null);
      onChanged();
    } catch (caught) {
      setState({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  }

  const canRotate = may('qr.rotate');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={table ? `QR code for table ${table.tableNumber}` : 'QR code'}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {state.kind === 'loading' ? (
        <div aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading the QR code</span>
          <Skeleton className="mx-auto aspect-square w-56" />
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{state.message}</p>
      ) : null}

      {state.kind === 'none' && table ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted">This table has no QR code yet.</p>
          {table.status === 'inactive' ? (
            <p className="text-xs text-muted">The table is inactive, so its code will not work until it is reactivated.</p>
          ) : null}
          {canRotate ? (
            <Button variant="primary" loading={busy}
              onClick={() => act(async () => (await tablesApi.issueQr(table.id)).qr)}>
              Generate QR code
            </Button>
          ) : null}
        </div>
      ) : null}

      {state.kind === 'ready' && table ? (
        <div className="space-y-4">
          {table.status === 'inactive' ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              This table is inactive. Its code shows customers a "not available" message until it is reactivated.
            </p>
          ) : null}

          <QrCard qr={state.qr} tableId={table.id} restaurantName={restaurantName} tableNumber={table.tableNumber} tableName={table.name} />

          {canRotate ? (
            confirming ? (
              // Inline confirmation rather than a second modal: the consequence is
              // stated right next to the button that causes it.
              <div role="group" aria-label="Confirm" className="rounded-md border border-danger/40 bg-danger-bg p-3 no-print">
                <p className="text-sm font-medium text-danger">
                  {confirming === 'regenerate'
                    ? 'Replace this code? The card on the table will stop working immediately.'
                    : 'Revoke this code? The card on the table will stop working and no new one is made.'}
                </p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button size="sm" onClick={() => setConfirming(null)} disabled={busy}>Keep it</Button>
                  <Button size="sm" variant="danger" loading={busy}
                    onClick={() => act(async () => confirming === 'regenerate'
                      ? (await tablesApi.regenerateQr(table.id)).qr
                      : (await tablesApi.revokeQr(table.id), null))}>
                    {confirming === 'regenerate' ? 'Replace code' : 'Revoke code'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-center gap-2 border-t border-border pt-4 no-print">
                <Button size="sm" onClick={() => setConfirming('regenerate')}>Replace code</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming('revoke')}>Revoke</Button>
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
