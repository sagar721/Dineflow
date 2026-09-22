import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Printer, QrCode } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { naturalOrder, tablesApi, type QrSheet } from './api.ts';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sheet: QrSheet };

/**
 * Every active table's QR card on A4 pages, three across (FR-015), for printing in
 * one go. Rendered outside the app shell so the printout holds only the cards.
 *
 * The provisional gate applies here exactly as on a single card: until the web
 * address is final, each card is watermarked and printing is off.
 */
export function QrSheetPage() {
  const { may } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', sheet: await tablesApi.qrSheet() });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load the QR codes.' });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const cards = useMemo(
    () => (load.kind === 'ready'
      ? [...load.sheet.cards].sort((a, b) => naturalOrder.compare(a.tableNumber, b.tableNumber))
      : []),
    [load],
  );

  async function generateMissing() {
    setBusy(true);
    setActionError(null);
    try {
      await tablesApi.issueMissingQr();
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not generate the missing codes.');
    } finally {
      setBusy(false);
    }
  }

  const sheet = load.kind === 'ready' ? load.sheet : null;
  const missing = sheet?.activeTablesWithoutQr ?? 0;
  const canRotate = may('qr.rotate');

  return (
    <main className="min-h-dvh bg-bg px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-5xl">
        <header className="no-print mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link to="/tables" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
              <ArrowLeft className="size-4" aria-hidden="true" /> Tables &amp; QR
            </Link>
            <h1 className="mt-2 text-2xl font-semibold text-text">QR sheet</h1>
            <p className="mt-1 text-sm text-muted">
              {sheet
                ? `${cards.length} ${cards.length === 1 ? 'code' : 'codes'} for ${sheet.restaurantName}, three to a row on A4.`
                : 'Every active table’s QR code, ready to print.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canRotate && missing > 0 ? (
              <Button iconLeft={<QrCode className="size-4" />} loading={busy} onClick={generateMissing}>
                Generate {missing} missing {missing === 1 ? 'code' : 'codes'}
              </Button>
            ) : null}
            <Button
              variant="primary"
              iconLeft={<Printer className="size-4" />}
              onClick={() => window.print()}
              disabled={!sheet || sheet.provisional || cards.length === 0}
              title={sheet?.provisional ? 'Printing is off until the web address is final' : undefined}
            >
              Print sheet
            </Button>
          </div>
        </header>

        {actionError ? (
          <p role="alert" className="no-print mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{actionError}</p>
        ) : null}

        {sheet?.provisional ? (
          <p role="note" className="no-print mb-4 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
            The web address is not final yet, so these codes may stop working if it changes. Printing is off
            until the address is confirmed.
          </p>
        ) : null}

        {sheet && missing > 0 ? (
          <p role="note" className="no-print mb-4 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
            {missing} active {missing === 1 ? 'table has' : 'tables have'} no QR code yet, so {missing === 1 ? 'it is' : 'they are'} not
            on this sheet.{canRotate ? '' : ' Ask an owner or manager to generate them.'}
          </p>
        ) : null}

        {load.kind === 'loading' ? (
          <div aria-busy="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <span className="sr-only">Loading the QR codes</span>
            {[0, 1, 2].map((key) => <Skeleton key={key} className="aspect-[3/4] w-full" />)}
          </div>
        ) : null}

        {load.kind === 'error' ? (
          <Card>
            <div className="space-y-3 p-5">
              <p role="alert" className="text-sm font-medium text-danger">{load.message}</p>
              <Button onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>Try again</Button>
            </div>
          </Card>
        ) : null}

        {sheet && cards.length === 0 ? (
          <Card>
            <EmptyState
              icon={<QrCode className="size-8" />}
              title="No QR codes to print"
              description={missing > 0
                ? 'Your active tables do not have QR codes yet.'
                : 'Add tables first. Each active table gets its own code.'}
              action={canRotate && missing > 0 ? (
                <Button variant="primary" loading={busy} onClick={generateMissing}>Generate QR codes</Button>
              ) : (
                <Link to="/tables" className="text-sm font-medium text-brand hover:underline">Go to Tables &amp; QR</Link>
              )}
            />
          </Card>
        ) : null}

        {sheet && cards.length > 0 ? (
          <section aria-label="QR codes" className="qr-sheet grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <figure
                key={card.url}
                className="qr-sheet-card relative flex flex-col items-center rounded-lg border border-border bg-white p-4 text-center text-black"
              >
                <p className="text-xs font-medium uppercase tracking-wide">{sheet.restaurantName}</p>
                {/* Rendered as an image, never injected as markup (see QrCard). */}
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(card.svg)}`}
                  alt={`QR code for table ${card.tableNumber}`}
                  className="mt-2 aspect-square w-full max-w-[180px]"
                />
                <figcaption className="mt-2">
                  <span className="block text-xl font-semibold tabular">Table {card.tableNumber}</span>
                  {card.name ? <span className="block text-sm">{card.name}</span> : null}
                  <span className="mt-1 block text-xs">Scan to see the menu</span>
                </figcaption>
                {sheet.provisional ? (
                  <span aria-hidden="true"
                    className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden rounded-lg">
                    <span className="-rotate-12 rounded bg-danger/90 px-2 py-1 text-xs font-bold tracking-wide text-inverse">
                      PROVISIONAL — DO NOT PRINT
                    </span>
                  </span>
                ) : null}
              </figure>
            ))}
          </section>
        ) : null}
      </div>
    </main>
  );
}
