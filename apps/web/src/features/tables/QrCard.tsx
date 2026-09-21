import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/index.ts';

export type QrPayload = { url: string; svg: string; issuedAt: string; provisional: boolean };

type QrCardProps = {
  qr: QrPayload;
  restaurantName: string;
  tableNumber: string;
  tableName: string | null;
};

/**
 * One table's QR card: the code, the table it belongs to, and the actions to get it
 * onto the table.
 *
 * The SVG comes from our own API, but it is still rendered as an image rather than
 * injected as markup — the design forbids raw HTML injection, and an <img> cannot
 * run script whatever the response contains.
 */
export function QrCard({ qr, restaurantName, tableNumber, tableName }: QrCardProps) {
  const imageSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`;
  const fileName = `table-${tableNumber.replace(/[^A-Za-z0-9-]+/g, '-')}-qr.svg`;

  function download() {
    const blob = new Blob([qr.svg], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="space-y-4">
      <figure
        className="qr-print-card relative mx-auto flex max-w-xs flex-col items-center rounded-lg border border-border bg-white p-5 text-center text-black"
      >
        <p className="text-xs font-medium uppercase tracking-wide">{restaurantName}</p>
        <img
          src={imageSrc}
          alt={`QR code for table ${tableNumber}`}
          className="mt-3 aspect-square w-full max-w-[220px]"
        />
        <figcaption className="mt-3">
          <span className="block text-2xl font-semibold tabular">Table {tableNumber}</span>
          {tableName ? <span className="block text-sm">{tableName}</span> : null}
          <span className="mt-1 block text-xs">Scan to see the menu</span>
        </figcaption>

        {/* A provisional card must never be laminated: its link encodes a domain that
            may still change, which would strand every printed code (design Q-04). */}
        {qr.provisional ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden rounded-lg"
          >
            <span className="-rotate-12 rounded bg-danger/90 px-3 py-1 text-sm font-bold tracking-wide text-inverse">
              PROVISIONAL — DO NOT PRINT
            </span>
          </span>
        ) : null}
      </figure>

      {qr.provisional ? (
        <p role="note" className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
          The web address is not final yet, so this code may stop working if it changes. You can test
          it by scanning the screen, but downloading and printing are off until the address is confirmed.
        </p>
      ) : null}

      <div className="flex flex-wrap justify-center gap-2 no-print">
        {/* Download is withheld too: a downloaded SVG carries no watermark and could
            be printed anyway, which would defeat the point of the gate. */}
        <Button
          iconLeft={<Download className="size-4" />}
          onClick={download}
          disabled={qr.provisional}
          title={qr.provisional ? 'Downloading is off until the web address is final' : undefined}
        >
          Download SVG
        </Button>
        <Button
          iconLeft={<Printer className="size-4" />}
          onClick={() => window.print()}
          disabled={qr.provisional}
          title={qr.provisional ? 'Printing is off until the web address is final' : undefined}
        >
          Print
        </Button>
      </div>
    </div>
  );
}
