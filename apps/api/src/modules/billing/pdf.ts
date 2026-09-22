// The bill as a PDF (FR-079), generated on the server from the stored snapshot
// with pdfmake. Regenerating gives identical amounts: nothing is recomputed, and
// the document's dates are the bill's own. What differs between copies is only the
// copy mark — the first copy is the original; later ones say DUPLICATE (Stage-2
// condition 5.3) — and a void bill is marked VOID on every copy.
import PdfPrinter from 'pdfmake';
import vfs from 'pdfmake/build/vfs_fonts.js';
import { formatMoney, type Currency } from '@dineflow/shared';
import type { BillView } from './routes.ts';

const font = (name: string) => Buffer.from(vfs[name]!, 'base64');
// Roboto (bundled with pdfmake) has the rupee sign and the minus sign.
const printer = new PdfPrinter({
  Roboto: {
    normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'),
    italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf'),
  },
});

const rate = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')} %`;

/** The copy mark printed on a copy, if any: VOID, DUPLICATE COPY n, or nothing. */
export function copyMark(status: BillView['status'], copy: number): string | null {
  if (status === 'void') return copy > 1 ? `VOID — DUPLICATE COPY ${copy}` : 'VOID';
  return copy > 1 ? `DUPLICATE COPY ${copy}` : null;
}

export function billPdf(bill: BillView, copy: number, timezone: string): Promise<Buffer> {
  const money = (minor: number) => formatMoney(minor, bill.currency as Currency);
  const issuer = bill.issuer as {
    name?: string; addressLines?: string[]; phone?: string | null; email?: string | null;
    taxRegistrationNo?: string | null; footer?: string | null;
  };
  const when = bill.finalizedAt ?? bill.createdAt;
  const mark = copyMark(bill.status, copy);
  const totalRow = (label: string, value: string, bold = false) =>
    [{ text: label, bold, colSpan: 3 }, {}, {}, { text: value, alignment: 'right', bold }];

  const definition = {
    pageSize: 'A4',
    pageMargins: [48, 48, 48, 56],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    info: {
      title: `Bill ${bill.ref ?? ''}`.trim(), author: issuer.name ?? '', producer: 'DineFlow', creator: 'DineFlow',
      // The bill's own time, so the file does not change merely by being regenerated.
      creationDate: new Date(when), modDate: new Date(when),
    },
    content: [
      ...(mark ? [{ text: mark, bold: true, fontSize: 14, color: '#b42318', alignment: 'center', margin: [0, 0, 0, 8] }] : []),
      { text: issuer.name ?? '', bold: true, fontSize: 16, alignment: 'center' },
      ...(issuer.addressLines ?? []).map((line) => ({ text: line, alignment: 'center' })),
      ...([issuer.phone, issuer.email].some(Boolean)
        ? [{ text: [issuer.phone, issuer.email].filter(Boolean).join(' · '), alignment: 'center' }] : []),
      ...(issuer.taxRegistrationNo ? [{ text: `Tax registration: ${issuer.taxRegistrationNo}`, alignment: 'center' }] : []),
      { text: bill.status === 'void' ? 'Void bill' : 'Bill', bold: true, fontSize: 12, margin: [0, 16, 0, 6] },
      {
        columns: [
          { width: '*', stack: [
            { text: ['Bill no. ', { text: bill.ref ?? '', bold: true }] },
            `Table ${bill.table.tableNumber}`,
            `Order${bill.orders.length > 1 ? 's' : ''} ${bill.orders.map((o) => `#${o.ref}`).join(', ')}`,
          ] },
          { width: 'auto', alignment: 'right', text: new Date(when).toLocaleString('en-IN', {
            dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }) },
        ],
      },
      {
        margin: [0, 12, 0, 0],
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: [
            [{ text: 'Item', bold: true }, { text: 'Qty', bold: true, alignment: 'right' },
             { text: 'Price', bold: true, alignment: 'right' }, { text: 'Total', bold: true, alignment: 'right' }],
            ...bill.lines.map((l) => [l.name, { text: String(l.quantity), alignment: 'right' },
              { text: money(l.unitPriceMinor), alignment: 'right' }, { text: money(l.lineTotalMinor), alignment: 'right' }]),
            totalRow('Subtotal', money(bill.subtotalMinor)),
            ...(bill.discountMinor > 0
              ? [totalRow(`Discount${bill.discount?.reason ? ` (${bill.discount.reason})` : ''}`, `−${money(bill.discountMinor)}`)] : []),
            ...(bill.serviceChargeMinor > 0 ? [totalRow(`Service charge ${rate(bill.serviceChargeBps)}`, money(bill.serviceChargeMinor))] : []),
            ...bill.taxes.map((t) => totalRow(`${t.name} ${rate(t.rateBps)}${bill.pricesIncludeTax ? ' (included)' : ''}`, money(t.amountMinor))),
            ...(bill.roundingMinor !== 0
              ? [totalRow('Rounding', `${bill.roundingMinor > 0 ? '+' : '−'}${money(Math.abs(bill.roundingMinor))}`)] : []),
            totalRow('Total', money(bill.totalMinor), true),
            ...(bill.status === 'finalized' ? [totalRow('Payment', bill.paymentStatus === 'paid' ? 'Paid' : 'Unpaid')] : []),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      ...(bill.status === 'void' && bill.voidReason ? [{ text: `Voided: ${bill.voidReason}`, margin: [0, 10, 0, 0] }] : []),
      ...(issuer.footer ? [{ text: issuer.footer, alignment: 'center', margin: [0, 16, 0, 0] }] : []),
      ...(bill.contentHash ? [{ text: `Verification: ${bill.contentHash}`, fontSize: 7, color: '#667085', margin: [0, 18, 0, 0] }] : []),
    ],
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(definition);
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
