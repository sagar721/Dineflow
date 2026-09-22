import { useCallback, useEffect, useState } from 'react';
import { BellRing, ClipboardList, Search } from 'lucide-react';
import { formatMoney, ORDER_STATUSES, ORDER_STATUS_LABEL } from '@dineflow/shared';
import { Page } from '@/app/AppShell.tsx';
import { Button, Card, EmptyState, Field, Input, LiveIndicator, OrderStatusChip, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { tablesApi, naturalOrder, type DiningTable } from '@/features/tables/api.ts';
import { OrderDetailDialog } from './OrderDetailDialog.tsx';
import { useLiveOrders } from './useLiveOrders.ts';
import { chime, enableSound, soundReady } from './alert.ts';
import { ordersApi, timeIn, type OrderFilters, type OrderPage } from './api.ts';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; page: OrderPage };

const selectClass = 'h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text';

/**
 * All orders (FR-051, FR-057): filters by status, table, date and number; newest
 * first; paged on the server. Live (FR-050): new and changed orders appear within
 * a few seconds, with an optional chime.
 */
export function OrdersPage() {
  const [filters, setFilters] = useState<OrderFilters>({});
  const [search, setSearch] = useState('');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [more, setMore] = useState(false);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [arrivals, setArrivals] = useState<string[]>([]);
  const [sound, setSound] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', page: await ordersApi.list(filters) });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load orders.' });
    }
  }, [filters]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    tablesApi.list().then(({ tables: list }) => setTables(
      [...list].sort((a, b) => naturalOrder.compare(a.tableNumber, b.tableNumber)))).catch(() => undefined);
  }, []);

  const live = useLiveOrders({
    onChange: () => void refresh(),
    onNewOrders: (orders) => {
      setArrivals((previous) => [...orders.map((o) => `Order ${o.ref}, table ${o.tableNumber}`), ...previous].slice(0, 3));
      chime();
    },
  });

  async function loadMore() {
    if (load.kind !== 'ready' || !load.page.nextCursor) return;
    setMore(true);
    try {
      const next = await ordersApi.list(filters, load.page.nextCursor);
      setLoad({ kind: 'ready', page: { ...next, orders: [...load.page.orders, ...next.orders] } });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load more orders.' });
    } finally {
      setMore(false);
    }
  }

  const set = (patch: OrderFilters) => { setLoad({ kind: 'loading' }); setFilters((current) => ({ ...current, ...patch })); };

  return (
    <Page
      title="Orders"
      description="Every order, newest first."
      actions={
        <div className="flex items-center gap-3">
          <LiveIndicator state={live.state} lastUpdated={live.lastUpdated} />
          {!sound || !soundReady() ? (
            <Button size="sm" iconLeft={<BellRing className="size-4" />}
              onClick={() => void enableSound().then(setSound)}>Turn on sound</Button>
          ) : null}
        </div>
      }
    >
      {arrivals.length ? (
        <div role="status" className="mb-3 flex items-start justify-between gap-3 rounded-md bg-brand-subtle px-3 py-2 text-sm font-medium text-text">
          <span>New: {arrivals.join(' · ')}</span>
          <button type="button" className="text-brand hover:underline" onClick={() => setArrivals([])}>Dismiss</button>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <form className="min-w-48 flex-1" onSubmit={(event) => { event.preventDefault(); set({ q: search.trim() || undefined }); }}>
          <Field label="Order number">
            {({ id }) => (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <Input id={id} type="search" className="pl-9" placeholder="e.g. 42" maxLength={20}
                  value={search} onChange={(event) => setSearch(event.target.value)}
                  onBlur={() => set({ q: search.trim() || undefined })} />
              </div>
            )}
          </Field>
        </form>
        <Field label="Status">
          {({ id }) => (
            <select id={id} className={selectClass} value={filters.status ?? ''} onChange={(event) => set({ status: event.target.value || undefined })}>
              <option value="">All</option>
              <option value="pending,accepted,preparing,ready">Active</option>
              {ORDER_STATUSES.map((status) => <option key={status} value={status}>{ORDER_STATUS_LABEL[status]}</option>)}
            </select>
          )}
        </Field>
        <Field label="Table">
          {({ id }) => (
            <select id={id} className={selectClass} value={filters.table ?? ''} onChange={(event) => set({ table: event.target.value || undefined })}>
              <option value="">All</option>
              {tables.map((table) => <option key={table.id} value={table.id}>Table {table.tableNumber}</option>)}
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
        <div aria-busy="true" className="space-y-2"><span className="sr-only">Loading orders</span>
          <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : null}

      {load.kind === 'error' ? (
        <Card><div className="space-y-3 p-5">
          <p role="alert" className="text-sm font-medium text-danger">{load.message}</p>
          <Button onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>Try again</Button>
        </div></Card>
      ) : null}

      {load.kind === 'ready' && load.page.orders.length === 0 ? (
        <Card>
          <EmptyState icon={<ClipboardList className="size-8" />}
            title={Object.values(filters).some(Boolean) ? 'No orders match' : 'No orders yet'}
            description={Object.values(filters).some(Boolean)
              ? 'Try a different filter.' : 'Orders placed from table QR codes will appear here as they arrive.'} />
        </Card>
      ) : null}

      {load.kind === 'ready' && load.page.orders.length > 0 ? (
        <>
          <Card>
            <ul className="divide-y divide-border">
              {load.page.orders.map((order) => (
                <li key={order.id}>
                  <button type="button" onClick={() => setOpenId(order.id)}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-2 sm:px-5">
                    <span className="w-20 font-semibold tabular text-text">#{order.ref}</span>
                    <span className="w-20 text-sm text-muted">Table <span className="font-medium text-text">{order.table.tableNumber}</span></span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {order.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
                    </span>
                    <span className="text-sm tabular text-muted">{timeIn(order.placedAt, load.page.timezone)}</span>
                    <span className="w-24 text-right text-sm font-medium tabular text-text">{formatMoney(order.subtotalMinor, load.page.currency)}</span>
                    <OrderStatusChip status={order.status} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {load.page.nextCursor ? (
            <div className="mt-3 text-center"><Button loading={more} onClick={() => void loadMore()}>Load more</Button></div>
          ) : null}
        </>
      ) : null}

      <OrderDetailDialog orderId={openId} onClose={() => setOpenId(null)} onChanged={() => void refresh()} />
    </Page>
  );
}
