import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { QrCode } from 'lucide-react';
import { Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';

type Entry = {
  restaurant: { name: string; brandColor: string | null; acceptingOrders: boolean };
  table: { tableNumber: string; name: string | null };
};

type State = { kind: 'loading' } | { kind: 'ready'; entry: Entry } | { kind: 'unavailable'; message: string };

/**
 * What a customer sees after scanning a table's QR code.
 *
 * Deliberately small: it confirms they are at the right restaurant and table, and
 * nothing more, because ordering is a later module. It never shows an internal
 * id, and every way a code can fail looks the same.
 */
export function TableEntryPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiFetch<Entry>(`/public/tables/${encodeURIComponent(token)}`)
      .then((entry) => setState({ kind: 'ready', entry }))
      .catch((caught) => setState({
        kind: 'unavailable',
        message: caught instanceof ApiError && caught.status !== 500
          ? caught.message
          : 'We could not load this table. Please ask a member of staff for help.',
      }));
  }, [token]);

  // The accent colour is only ever a stripe: it is chosen by the restaurant and has
  // not been contrast-checked, so it never sits behind text.
  const accent = state.kind === 'ready' ? state.entry.restaurant.brandColor ?? undefined : undefined;

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <div className="h-1.5 w-full bg-brand" style={accent ? { backgroundColor: accent } : undefined} aria-hidden="true" />
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10">
        {state.kind === 'loading' ? (
          <div aria-busy="true" className="space-y-3">
            <h1 className="text-2xl font-semibold text-text">Finding your table</h1>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {state.kind === 'ready' ? (
          <div className="space-y-6">
            <div>
              <p className="text-sm font-medium text-muted">Welcome to</p>
              <h1 className="text-3xl font-semibold tracking-tight text-text">{state.entry.restaurant.name}</h1>
            </div>

            <div className="rounded-lg border border-border bg-surface p-5 shadow-raised">
              <p className="text-sm text-muted">You are at</p>
              <p className="mt-1 text-2xl font-semibold tabular text-text">Table {state.entry.table.tableNumber}</p>
              {state.entry.table.name ? <p className="text-sm text-muted">{state.entry.table.name}</p> : null}
            </div>

            <p className="text-sm text-muted">
              {state.entry.restaurant.acceptingOrders
                ? 'Ordering from your table is coming soon. For now, please order with a member of staff.'
                : 'This restaurant is not taking orders here right now. Please ask a member of staff.'}
            </p>
          </div>
        ) : null}

        {state.kind === 'unavailable' ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-surface-2 text-muted" aria-hidden="true">
              <QrCode className="size-7" />
            </div>
            <h1 className="text-2xl font-semibold text-text">This code isn't working</h1>
            <p role="alert" className="text-sm text-muted">{state.message}</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
