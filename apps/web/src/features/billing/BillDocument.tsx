import { formatMoney } from '@dineflow/shared';
import type { Bill } from './api.ts';
import { rateLabel } from './logic.ts';

/**
 * A bill as the customer sees it (FR-071): issuer, number, orders, table, time,
 * lines, subtotal, discount, each tax, service charge, rounding and total. Every
 * figure is the stored snapshot; nothing is recomputed here.
 */
export function BillDocument({ bill, timezone }: { bill: Bill; timezone: string }) {
  const money = (minor: number) => formatMoney(minor, bill.currency);
  const when = bill.finalizedAt ?? bill.createdAt;
  const row = (label: string, value: string, strong = false) => (
    <p className={`flex justify-between gap-4 ${strong ? 'text-base font-semibold text-text' : 'text-sm text-muted'}`}>
      <span>{label}</span><span className="tabular text-text">{value}</span>
    </p>
  );
  return (
    <article aria-label={bill.ref ? `Bill ${bill.ref}` : 'Draft bill'} className="space-y-4 text-sm">
      <header className="text-center">
        <p className="text-base font-semibold text-text">{bill.issuer.name}</p>
        {bill.issuer.addressLines?.map((line) => <p key={line} className="text-muted">{line}</p>)}
        {bill.issuer.phone || bill.issuer.email
          ? <p className="text-muted">{[bill.issuer.phone, bill.issuer.email].filter(Boolean).join(' · ')}</p> : null}
        {bill.issuer.taxRegistrationNo ? <p className="text-muted">Tax registration: {bill.issuer.taxRegistrationNo}</p> : null}
      </header>

      {bill.status === 'void' ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-center font-semibold uppercase tracking-wide text-danger">
          Void{bill.voidReason ? ` — ${bill.voidReason}` : ''}
        </p>
      ) : null}
      {bill.status === 'draft' ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-center font-medium text-muted">Draft — not a bill until finalized</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted">
        <dt>Bill no.</dt><dd className="text-right font-semibold tabular text-text">{bill.ref ?? '—'}</dd>
        <dt>Table</dt><dd className="text-right tabular text-text">{bill.table.tableNumber}</dd>
        <dt>Order{bill.orders.length > 1 ? 's' : ''}</dt>
        <dd className="text-right tabular text-text">{bill.orders.map((o) => `#${o.ref}`).join(', ')}</dd>
        <dt>Date</dt>
        <dd className="text-right tabular text-text">
          {new Date(when).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })}
        </dd>
      </dl>

      <table className="w-full text-left">
        <thead className="border-b border-border text-xs text-muted">
          <tr><th className="py-1 font-medium">Item</th><th className="py-1 text-right font-medium">Qty</th>
            <th className="py-1 text-right font-medium">Price</th><th className="py-1 text-right font-medium">Total</th></tr>
        </thead>
        <tbody>
          {bill.lines.map((line, index) => (
            <tr key={index} className="border-b border-border last:border-0">
              <td className="py-1 text-text">{line.name}</td>
              <td className="py-1 text-right tabular">{line.quantity}</td>
              <td className="py-1 text-right tabular">{money(line.unitPriceMinor)}</td>
              <td className="py-1 text-right tabular text-text">{money(line.lineTotalMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-1 border-t border-border pt-2">
        {row('Subtotal', money(bill.subtotalMinor))}
        {bill.discountMinor > 0 ? row(`Discount${bill.discount?.reason ? ` (${bill.discount.reason})` : ''}`, `−${money(bill.discountMinor)}`) : null}
        {bill.serviceChargeMinor > 0 ? row(`Service charge ${rateLabel(bill.serviceChargeBps)}`, money(bill.serviceChargeMinor)) : null}
        {bill.taxes.map((tax) => row(
          `${tax.name} ${rateLabel(tax.rateBps)}${bill.pricesIncludeTax ? ' (included)' : ''}`, money(tax.amountMinor)))}
        {bill.roundingMinor !== 0 ? row('Rounding', `${bill.roundingMinor > 0 ? '+' : '−'}${money(Math.abs(bill.roundingMinor))}`) : null}
        {row('Total', money(bill.totalMinor), true)}
        {bill.status === 'finalized' ? row('Payment', bill.paymentStatus === 'paid' ? 'Paid' : 'Unpaid') : null}
      </div>

      {bill.issuer.footer ? <p className="whitespace-pre-line text-center text-xs text-muted">{bill.issuer.footer}</p> : null}
    </article>
  );
}
