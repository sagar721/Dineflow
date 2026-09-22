import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { formatMoney } from '@dineflow/shared';
import { Page } from '@/app/AppShell.tsx';
import { Button, Card, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError, saveBlob } from '@/lib/api.ts';
import { billingApi, type SalesDay, type SalesMethod, type SalesReport } from './api.ts';
import { PAYMENT_METHOD_LABEL } from './logic.ts';

const selectClass = 'h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text';
const today = () => new Intl.DateTimeFormat('en-CA').format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat('en-CA').format(new Date(Date.now() - n * 86_400_000));

/**
 * Sales by day and by payment method (FR-084), on the restaurant's own days, with
 * CSV export. Billing staff see the sales they billed themselves; owners and
 * managers see all of them.
 */
export function SalesReportPage() {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<'day' | 'method'>('day');
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await billingApi.sales({ from, to, groupBy }));
    } catch (caught) {
      setReport(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the report.');
    }
  }, [from, to, groupBy]);
  useEffect(() => { void load(); }, [load]);

  const money = (minor: number) => (report ? formatMoney(minor, report.currency) : '');
  const days = (report?.rows ?? []) as SalesDay[];
  const methods = (report?.rows ?? []) as SalesMethod[];

  return (
    <Page
      title="Sales report"
      description="Bills finalized in the period, by day or by payment method."
      actions={
        <Button size="sm" iconLeft={<Download className="size-4" />} loading={busy} disabled={!report}
          onClick={() => {
            setBusy(true);
            billingApi.salesCsv({ from, to, groupBy })
              .then((blob) => saveBlob(blob, `sales-by-${groupBy}-${from}-to-${to}.csv`))
              .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not export the report.'))
              .finally(() => setBusy(false));
          }}>Export CSV</Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="From">{({ id }) => <Input id={id} type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{({ id }) => <Input id={id} type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Group by">
          {({ id }) => (
            <select id={id} className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'method')}>
              <option value="day">Day</option>
              <option value="method">Payment method</option>
            </select>
          )}
        </Field>
      </div>

      {error ? <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p> : null}
      {!report && !error ? <div aria-busy="true"><Skeleton className="h-40 w-full" /></div> : null}

      {report ? (
        <Card>
          <div className="overflow-x-auto p-4 sm:p-5">
            {report.scope === 'mine' ? (
              <p className="mb-3 text-sm text-muted">These are the sales you billed. Ask an owner or manager for the whole restaurant.</p>
            ) : null}
            <p className="mb-3 text-sm text-muted">Days are {report.timezone} days.</p>
            {report.rows.length === 0 ? <p className="text-sm text-muted">No sales in this period.</p> : null}
            {report.rows.length > 0 && groupBy === 'day' ? (
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-border text-left text-muted">
                  <tr><th className="py-2 font-medium">Day</th><th className="py-2 text-right font-medium">Bills</th>
                    <th className="py-2 text-right font-medium">Void</th><th className="py-2 text-right font-medium">Subtotal</th>
                    <th className="py-2 text-right font-medium">Discounts</th><th className="py-2 text-right font-medium">Tax</th>
                    <th className="py-2 text-right font-medium">Total</th></tr>
                </thead>
                <tbody>
                  {days.map((row) => (
                    <tr key={row.day} className="border-b border-border last:border-0">
                      <td className="py-2 tabular text-text">{row.day}</td>
                      <td className="py-2 text-right tabular">{row.bills}</td>
                      <td className="py-2 text-right tabular">{row.voidedBills}</td>
                      <td className="py-2 text-right tabular">{money(row.subtotalMinor)}</td>
                      <td className="py-2 text-right tabular">{money(row.discountMinor)}</td>
                      <td className="py-2 text-right tabular">{money(row.taxMinor)}</td>
                      <td className="py-2 text-right font-semibold tabular text-text">{money(row.totalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold text-text">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right tabular">{report.totals.bills ?? 0}</td>
                    <td className="py-2 text-right tabular">{report.totals.voidedBills ?? 0}</td>
                    <td className="py-2 text-right tabular">{money(report.totals.subtotalMinor ?? 0)}</td>
                    <td className="py-2 text-right tabular">{money(report.totals.discountMinor ?? 0)}</td>
                    <td className="py-2 text-right tabular">{money(report.totals.taxMinor ?? 0)}</td>
                    <td className="py-2 text-right tabular">{money(report.totals.totalMinor ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            ) : null}
            {report.rows.length > 0 && groupBy === 'method' ? (
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted">
                  <tr><th className="py-2 font-medium">Payment method</th><th className="py-2 text-right font-medium">Payments</th>
                    <th className="py-2 text-right font-medium">Amount</th></tr>
                </thead>
                <tbody>
                  {methods.map((row) => (
                    <tr key={row.method} className="border-b border-border last:border-0">
                      <td className="py-2 text-text">{PAYMENT_METHOD_LABEL[row.method] ?? row.method}</td>
                      <td className="py-2 text-right tabular">{row.payments}</td>
                      <td className="py-2 text-right font-semibold tabular text-text">{money(row.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold text-text">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right tabular">{report.totals.payments ?? 0}</td>
                    <td className="py-2 text-right tabular">{money(report.totals.amountMinor ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            ) : null}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
