import { ORDER_STATUS_LABEL, type StaffRole } from '@dineflow/shared';
import { actionsFor, elapsedLabel, groupForKitchen, isLate } from './board.ts';
import type { OrderSummary } from './api.ts';

type Props = {
  orders: OrderSummary[];
  role: StaffRole;
  now: number;
  busyId: string | null;
  onAdvance: (order: OrderSummary) => void;
  onOpen: (order: OrderSummary) => void;
};

const COLUMNS = ['pending', 'accepted', 'preparing', 'ready'] as const;

/**
 * The kitchen board (FR-056): large type for arm's length, one column per active
 * status, oldest order first, with how long each has waited. Each card offers the
 * one next step this role may take; everything else is in the order's details.
 * Presentational only, so the smoke test renders it with fixed data.
 */
export function KitchenBoard({ orders, role, now, busyId, onAdvance, onOpen }: Props) {
  const board = groupForKitchen(orders);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((status) => (
        <section key={status} aria-labelledby={`col-${status}`} className="rounded-lg bg-surface-2 p-3">
          <h2 id={`col-${status}`} className="mb-3 flex items-center justify-between text-lg font-semibold text-text">
            {ORDER_STATUS_LABEL[status]} <span className="rounded-full bg-surface px-2.5 text-base tabular">{board[status].length}</span>
          </h2>
          {board[status].length === 0 ? <p className="px-1 py-6 text-center text-sm text-muted">Nothing here.</p> : null}
          <ul className="space-y-3">
            {board[status].map((order) => {
              const advance = actionsFor(role, order.status).find((action) => action.kind === 'advance');
              const late = isLate(order.placedAt, now);
              return (
                <li key={order.id} className={`rounded-lg border bg-surface p-3 shadow-raised ${late ? 'border-danger' : 'border-border'}`}>
                  <button type="button" onClick={() => onOpen(order)} className="block w-full text-left">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-2xl font-bold tabular text-text">#{order.ref}</span>
                      <span className={`text-sm font-semibold tabular ${late ? 'text-danger' : 'text-muted'}`}>
                        {elapsedLabel(order.placedAt, now)}{late ? <span className="sr-only"> — waiting a long time</span> : null}
                      </span>
                    </div>
                    <p className="text-lg font-semibold text-text">Table {order.table.tableNumber}</p>
                    <ul className="mt-2 space-y-1">
                      {order.items.map((item, index) => (
                        <li key={index} className="text-lg leading-snug text-text">
                          <span className="font-bold tabular">{item.quantity}×</span> {item.name}
                          {item.note ? <span className="block text-sm font-medium text-warning">↳ {item.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                    {order.specialInstructions ? (
                      <p className="mt-2 rounded bg-warning-bg px-2 py-1 text-sm font-medium text-warning">“{order.specialInstructions}”</p>
                    ) : null}
                    {order.staffNote ? <p className="mt-2 text-sm text-muted">Note: {order.staffNote}</p> : null}
                  </button>
                  {advance ? (
                    <button type="button" disabled={busyId === order.id} onClick={() => onAdvance(order)}
                      className="mt-3 h-14 w-full rounded-md bg-brand text-lg font-semibold text-inverse disabled:opacity-60">
                      {busyId === order.id ? 'Saving…' : advance.label}
                      <span className="sr-only"> — order {order.ref}</span>
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
