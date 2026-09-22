import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { billingApi, type Bill, type BillCopy } from './api.ts';
import { BillDocument } from './BillDocument.tsx';

const WIDTHS = { thermal: { label: '80 mm roll', className: 'w-[80mm] px-2 text-[11px]' },
  a4: { label: 'A4', className: 'w-[210mm] max-w-full px-10 text-sm' } } as const;

/**
 * The printable bill (FR-078): the browser's own print, with CSS for an 80 mm
 * thermal roll and for A4. Printing records a copy in the billing ledger, so the
 * first copy is the original and every later one is marked a duplicate (Stage-2
 * condition 5.3). Rendered without the app shell, so nothing else lands on paper.
 */
export function BillPrintPage() {
  const { id = '' } = useParams();
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<BillCopy | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState<keyof typeof WIDTHS>('thermal');

  useEffect(() => {
    billingApi.detail(id)
      .then(({ bill: loaded }) => setBill(loaded))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load this bill.'));
  }, [id]);

  async function print() {
    if (!bill) return;
    setBusy(true);
    setError(null);
    try {
      const recorded = await billingApi.recordPrint(bill.id);
      setBill(recorded.bill);
      setCopy(recorded.copy);
      // Let the mark render before the print dialog takes its snapshot.
      setTimeout(() => window.print(), 0);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not print this bill.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-bg py-6">
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center gap-3 px-4 print:hidden">
        <h1 className="flex-1 text-lg font-semibold text-text">{bill?.ref ? `Bill ${bill.ref}` : 'Bill'}</h1>
        <div role="group" aria-label="Paper size" className="flex gap-2">
          {(Object.keys(WIDTHS) as (keyof typeof WIDTHS)[]).map((key) => (
            <Button key={key} size="sm" variant={width === key ? 'primary' : 'secondary'} aria-pressed={width === key}
              onClick={() => setWidth(key)}>{WIDTHS[key].label}</Button>
          ))}
        </div>
        <Button variant="primary" loading={busy} disabled={!bill || bill.status === 'draft'} onClick={() => void print()}>Print</Button>
        <Button onClick={() => void billingApi.pdf(id).then((blob) => {
          const href = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = href;
          link.download = `bill-${bill?.ref ?? id}.pdf`;
          link.click();
          URL.revokeObjectURL(href);
        }).catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not make the PDF.'))}>
          Download PDF
        </Button>
      </div>

      {error ? <p role="alert" className="mx-auto max-w-[210mm] px-4 text-sm font-medium text-danger print:hidden">{error}</p> : null}
      {!bill && !error ? <div aria-busy="true" className="mx-auto max-w-[210mm] px-4"><Skeleton className="h-64 w-full" /></div> : null}

      {bill ? (
        <div className={`mx-auto bg-surface py-4 text-text ${WIDTHS[width].className} print:w-full print:bg-white`}>
          {copy?.duplicate ? (
            <p className="mb-2 text-center text-sm font-bold uppercase tracking-wide text-danger">{copy.mark}</p>
          ) : null}
          <BillDocument bill={bill} timezone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
          {bill.contentHash ? (
            <p className="mt-4 break-all text-center text-[8px] text-muted">Verification: {bill.contentHash}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
