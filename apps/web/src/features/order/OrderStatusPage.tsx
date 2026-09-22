import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CheckCircle2, ClipboardList } from 'lucide-react';
import { formatMoney, ORDER_STATUS_LABEL, TERMINAL_STATUSES, type OrderStatus } from '@dineflow/shared';
import { Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { loadMyOrders, orderApi, type PlacedOrder } from './api.ts';

type State = { kind: 'loading' } | { kind: 'ready'; order: PlacedOrder } | { kind: 'missing'; message: string };

const STEPS: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'served'];
const REFRESH_MS = 15_000;

/**
 * The order confirmation and status page (FR-041, FR-042). Reached by its own
 * unguessable link, so it works after a reload and later on the same device. It
 * shows the order and its status only — never who placed it.
 */
export function OrderStatusPage() {
  const { statusToken = '' } = useParams();
  const location = useLocation();
  const handed = (location.state as { order?: PlacedOrder; justPlaced?: boolean } | null) ?? null;
  const [state, setState] = useState<State>(handed?.order ? { kind: 'ready', order: handed.order } : { kind: 'loading' });
  const [justPlaced] = useState(Boolean(handed?.justPlaced));

  const status = state.kind === 'ready' ? (state.order.status as OrderStatus) : null;
  const finished = status !== null && TERMINAL_STATUSES.includes(status);

  // Checks for updates until the order is served or cancelled (FR-041).
  useEffect(() => {
    if (finished) return;
    let stopped = false;
    const refresh = () => orderApi.status(statusToken)
      .then(({ order }) => { if (!stopped) setState({ kind: 'ready', order }); })
      .catch((caught) => {
        if (stopped) return;
        // A dropped connection keeps what is on screen; only a real "not found" replaces it.
        if (caught instanceof ApiError && caught.status === 404) setState({ kind: 'missing', message: caught.message });
        else setState((previous) => (previous.kind === 'loading'
          ? { kind: 'missing', message: 'We could not load this order. Check your connection and try again.' }
          : previous));
      });
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [statusToken, finished]);

  const tableToken = loadMyOrders().find((each) => each.statusToken === statusToken)?.tableToken;

  return (
    <main className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-md px-4 py-6">
        {state.kind === 'loading' ? (
          <div aria-busy="true" className="space-y-3">
            <h1 className="text-2xl font-semibold text-text">Finding your order</h1>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {state.kind === 'missing' ? (
          <div className="space-y-3 pt-4 text-center">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-surface-2 text-muted" aria-hidden="true">
              <ClipboardList className="size-7" />
            </div>
            <h1 className="text-2xl font-semibold text-text">Order not found</h1>
            <p role="alert" className="text-sm text-muted">{state.message}</p>
          </div>
        ) : null}

        {state.kind === 'ready' ? (
          <OrderDetails order={state.order} justPlaced={justPlaced} tableToken={tableToken} />
        ) : null}
      </div>
    </main>
  );
}

function OrderDetails({ order, justPlaced, tableToken }: { order: PlacedOrder; justPlaced: boolean; tableToken?: string }) {
  const status = order.status as OrderStatus;
  const currency = order.restaurant.currency ?? 'INR';
  const reached = STEPS.indexOf(status);

  return (
    <div className="space-y-5">
      {justPlaced ? (
        <p role="status" className="flex items-center gap-2 rounded-md bg-success-bg px-3 py-2 text-sm font-medium text-success">
          <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" /> Your order has been sent to the restaurant.
        </p>
      ) : null}

      <header>
        {order.restaurant.name ? <p className="text-sm font-medium text-muted">{order.restaurant.name}</p> : null}
        <h1 className="text-3xl font-semibold tracking-tight text-text">Order {order.ref}</h1>
        <p className="mt-1 text-sm text-muted">
          {order.table ? `Table ${order.table.tableNumber} · ` : ''}
          Placed {new Date(order.placedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </p>
      </header>

      <section aria-labelledby="order-status" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="order-status" className="text-sm font-medium text-muted">Status</h2>
        <p className="mt-1 text-xl font-semibold text-text" aria-live="polite">{ORDER_STATUS_LABEL[status] ?? order.status}</p>
        {status === 'cancelled' ? (
          <p className="mt-1 text-sm text-muted">This order was cancelled. Please ask a member of staff if you have questions.</p>
        ) : (
          <ol className="mt-3 flex gap-1" aria-label="Progress">
            {STEPS.map((step, index) => (
              <li key={step} className="flex-1">
                <span className={`block h-1.5 rounded-full ${index <= reached ? 'bg-brand' : 'bg-surface-2'}`} aria-hidden="true" />
                <span className={`mt-1 block text-[11px] ${index <= reached ? 'font-medium text-text' : 'text-muted'}`}>
                  {ORDER_STATUS_LABEL[step]}
                  {index <= reached ? <span className="sr-only"> (done)</span> : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="order-items">
        <h2 id="order-items" className="mb-2 text-lg font-semibold text-text">Items</h2>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-start gap-3 p-3">
              <span className="tabular text-sm text-muted">{item.quantity} ×</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">{item.name}</p>
                {item.note ? <p className="text-xs text-muted">{item.note}</p> : null}
              </div>
              <span className="font-medium tabular text-text">{formatMoney(item.lineTotalMinor, currency)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-sm text-muted">Subtotal · taxes, if any, on your bill</span>
          <span className="text-lg font-semibold tabular text-text">{formatMoney(order.subtotalMinor, currency)}</span>
        </div>
        {order.specialInstructions ? (
          <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">{order.specialInstructions}</p>
        ) : null}
      </section>

      <p className="text-xs text-muted">Keep this page open or bookmark it to follow your order.</p>
      {tableToken ? (
        <Link to={`/t/${tableToken}`} className="inline-flex h-11 items-center text-sm font-medium text-brand hover:underline">
          Order something else
        </Link>
      ) : null}
    </div>
  );
}
