import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Receipt, Search } from 'lucide-react';
import { formatMoney, type Currency } from '@dineflow/shared';
import { Page } from '@/app/AppShell.tsx';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { timeIn } from '@/features/orders/api.ts';
import { billingApi, type BillableOrder, type BillableTable, type BillFilters, type BillPage } from './api.ts';
import { BillDialog } from './BillDialog.tsx';
import { billState } from './logic.ts';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; page: BillPage };
const selectClass = 'h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text';

/**
 * Billing (FR-070 … FR-082): make a bill from a table's unbilled orders, then
 * finalize, take payment, and find past bills. From an order's details,
 * `?table=…&order=…` opens the table with that order chosen and `?bill=…` opens its bill.
 */
export function BillingPage() {
  const { may } = useSession();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<BillFilters>({});
  const [search, setSearch] = useState('');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get('bill'));

  const [billable, setBillable] = useState<{ currency: Currency; tables: BillableTable[] } | null>(null);
  const [tableId, setTableId] = useState<string | null>(params.get('table'));
  const [orders, setOrders] = useState<BillableOrder[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(params.get('order') ? [params.get('order')!] : []));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const canCreate = may('bill.create');

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', page: await billingApi.list(filters) });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load bills.' });
    }
    if (canCreate) billingApi.billableTables().then(setBillable).catch(() => undefined);
  }, [filters, canCreate]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!tableId) { setOrders(null); return; }
    setOrders(null);
    billingApi.billableOrders(tableId).then(({ orders: list }) => setOrders(list))
      .catch((caught) => setCreateError(caught instanceof ApiError ? caught.message : 'Could not load the orders.'));
  }, [tableId]);

  const chooseTable = (id: string | null) => {
    setTableId(id); setChosen(new Set()); setCreateError(null);
    if (params.size) setParams({}, { replace: true });
  };
  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function createDraft() {
    setCreating(true); setCreateError(null);
    try {
      const { bill } = await billingApi.create([...chosen]);
      chooseTable(null);
      setOpenId(bill.id);
      void refresh();
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? caught.message : 'Could not create the bill.');
    } finally {
      setCreating(false);
    }
  }

  async function loadMore() {
    if (load.kind !== 'ready' || !load.page.nextCursor) return;
    setMore(true);
    try {
      const next = await billingApi.list(filters, load.page.nextCursor);
      setLoad({ kind: 'ready', page: { ...next, bills: [...load.page.bills, ...next.bills] } });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load more bills.' });
    } finally {
      setMore(false);
    }
  }

  const set = (patch: BillFilters) => { setLoad({ kind: 'loading' }); setFilters((current) => ({ ...current, ...patch })); };
  const timezone = load.kind === 'ready' ? load.page.timezone : 'Asia/Kolkata';
  const currency = billable?.currency ?? (load.kind === 'ready' ? load.page.currency : 'INR');
  const chosenTotal = (orders ?? []).filter((o) => chosen.has(o.id)).reduce((sum, o) => sum + o.subtotalMinor, 0);

  return (
    <Page title="Billing" description="Make bills from a table’s orders, take payment and find past bills."
      actions={may('report.sales')
        ? <Link className="text-sm font-medium text-brand hover:underline" to="/billing/sales">Sales report</Link>
        : undefined}>
      {canCreate ? (
        <Card className="mb-5">
          <div className="space-y-3 p-4 sm:p-5">
            <h2 className="font-semibold text-text">New bill</h2>
            {billable && billable.tables.length === 0 && !tableId
              ? <p className="text-sm text-muted">Every order is billed. New orders will appear here.</p> : null}
            {!billable ? <Skeleton className="h-10 w-full" /> : null}
            <div className="flex flex-wrap gap-2">
              {billable?.tables.map((table) => (
                <Button key={table.id} size="sm" variant={tableId === table.id ? 'primary' : 'secondary'}
                  aria-pressed={tableId === table.id} onClick={() => chooseTable(tableId === table.id ? null : table.id)}>
                  Table {table.tableNumber} · {table.orderCount} order{table.orderCount === 1 ? '' : 's'} · {formatMoney(table.subtotalMinor, currency)}
                </Button>
              ))}
            </div>
            {tableId ? (
              <fieldset className="space-y-2">
                <legend className="text-sm text-muted">Choose the orders to put on this bill.</legend>
                {orders === null ? <Skeleton className="h-16 w-full" /> : null}
                {orders?.length === 0 ? <p className="text-sm text-muted">This table has no unbilled orders.</p> : null}
                {orders?.map((order) => (
                  <label key={order.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2">
                    <input type="checkbox" className="mt-1 size-4" checked={chosen.has(order.id)} onChange={() => toggle(order.id)} />
                    <span className="w-16 font-semibold tabular text-text">#{order.ref}</span>
                    <span className="min-w-0 flex-1 text-text">{order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</span>
                    <span className="tabular text-muted">{timeIn(order.placedAt, timezone)}</span>
                    <span className="w-24 text-right tabular text-text">{formatMoney(order.subtotalMinor, currency)}</span>
                  </label>
                ))}
                {createError ? <p role="alert" className="text-sm font-medium text-danger">{createError}</p> : null}
                <Button variant="primary" disabled={chosen.size === 0} loading={creating} onClick={() => void createDraft()}>
                  Create draft bill{chosen.size ? ` · ${formatMoney(chosenTotal, currency)}` : ''}
                </Button>
              </fieldset>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <form className="min-w-40 flex-1" onSubmit={(event) => { event.preventDefault(); set({ q: search.trim() || undefined }); }}>
          <Field label="Bill number">
            {({ id }) => (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <Input id={id} type="search" inputMode="numeric" className="pl-9" placeholder="e.g. 42" maxLength={10}
                  value={search} onChange={(event) => setSearch(event.target.value)} onBlur={() => set({ q: search.trim() || undefined })} />
              </div>
            )}
          </Field>
        </form>
        <Field label="Status">
          {({ id }) => (
            <select id={id} className={selectClass}
              value={filters.payment ? `pay:${filters.payment}` : filters.status ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                set(value.startsWith('pay:')
                  ? { status: undefined, payment: value.slice(4) as 'paid' | 'unpaid' }
                  : { status: (value || undefined) as BillFilters['status'], payment: undefined });
              }}>
              <option value="">All</option>
              <option value="pay:unpaid">Unpaid</option>
              <option value="pay:paid">Paid</option>
              <option value="draft">Draft</option>
              <option value="void">Void</option>
            </select>
          )}
        </Field>
        <Field label="From">
          {({ id }) => <Input id={id} type="date" className="w-40" value={filters.from ?? ''} onChange={(event) => set({ from: event.target.value || undefined })} />}
        </Field>
        <Field label="To">
          {({ id }) => <Input id={id} type="date" className="w-40" value={filters.to ?? ''} onChange={(event) => set({ to: event.target.value || undefined })} />}
        </Field>
      </div>

      {load.kind === 'loading' ? (
        <div aria-busy="true" className="space-y-2"><span className="sr-only">Loading bills</span>
          <Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : null}
      {load.kind === 'error' ? (
        <Card><div className="space-y-3 p-5">
          <p role="alert" className="text-sm font-medium text-danger">{load.message}</p>
          <Button onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>Try again</Button>
        </div></Card>
      ) : null}
      {load.kind === 'ready' && load.page.bills.length === 0 ? (
        <Card><EmptyState icon={<Receipt className="size-8" />}
          title={Object.values(filters).some(Boolean) ? 'No bills match' : 'No bills yet'}
          description={Object.values(filters).some(Boolean) ? 'Try a different filter.' : 'Bills you make will appear here.'} /></Card>
      ) : null}
      {load.kind === 'ready' && load.page.bills.length > 0 ? (
        <>
          <Card>
            <ul className="divide-y divide-border">
              {load.page.bills.map((bill) => {
                const state = billState(bill);
                return (
                  <li key={bill.id}>
                    <button type="button" onClick={() => setOpenId(bill.id)}
                      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-2 sm:px-5">
                      <span className="w-20 font-semibold tabular text-text">{bill.ref ? `No. ${bill.ref}` : 'Draft'}</span>
                      <span className="w-20 text-sm text-muted">Table <span className="font-medium text-text">{bill.tableNumber}</span></span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted">Orders {bill.orderRefs.map((r) => `#${r}`).join(', ')}</span>
                      <span className="text-sm tabular text-muted">{timeIn(bill.finalizedAt ?? bill.createdAt, load.page.timezone)}</span>
                      <span className="w-24 text-right text-sm font-medium tabular text-text">{formatMoney(bill.totalMinor, load.page.currency)}</span>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
          {load.page.nextCursor ? (
            <div className="mt-3 text-center"><Button loading={more} onClick={() => void loadMore()}>Load more</Button></div>
          ) : null}
        </>
      ) : null}

      <BillDialog billId={openId} timezone={timezone} onClose={() => setOpenId(null)} onChanged={() => void refresh()} />
    </Page>
  );
}
