import { useEffect, useState } from 'react';
import { formatMoney, ORDER_STATUS_LABEL } from '@dineflow/shared';
import { Button, Dialog, Field, OrderStatusChip, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { actionsFor, type OrderAction } from './board.ts';
import { dateTimeIn, ordersApi, timeIn, type OrderDetail } from './api.ts';

type Props = { orderId: string | null; onClose: () => void; onChanged: () => void };

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', manager: 'Manager', kitchen: 'Kitchen', billing: 'Billing' };
const textareaClass = 'block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text';

/**
 * One order in full (FR-051): the snapshot it was placed with, its history, the
 * staff note, and the actions this role may take. Contact details appear only when
 * the server sent them, which it does only for roles allowed to see them.
 */
export function OrderDetailDialog({ orderId, onClose, onChanged }: Props) {
  const { state: session } = useSession();
  const role = session.status === 'signed-in' ? session.session.role : null;
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<OrderAction | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [editingNote, setEditingNote] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    setOrder(null);
    setError(null);
    setNotice(null);
    setPending(null);
    setEditingNote(false);
    ordersApi.detail(orderId)
      .then(({ order: loaded }) => setOrder(loaded))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load this order.'));
  }, [orderId]);

  /** Runs a change; on a conflict, shows the order as it is now and says why (FR-058). */
  async function run(label: string, change: () => Promise<{ order: OrderDetail }>) {
    if (!order) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const { order: updated } = await change();
      setOrder(updated);
      setPending(null);
      setReason('');
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'STALE_VERSION') {
        const { order: fresh } = await ordersApi.detail(order.id);
        setOrder(fresh);
        setPending(null);
        setNotice(caught.message);
        onChanged();
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(null);
    }
  }

  const act = (action: OrderAction) => {
    if (!order) return;
    if (action.needsReason && pending?.to !== action.to) {
      setPending(action);
      setReason('');
      return;
    }
    const text = reason.trim();
    if (action.needsReason && text.length < 3) {
      setError('Give a reason of at least 3 characters.');
      return;
    }
    void run(action.label, () => (action.kind === 'revert'
      ? ordersApi.revert(order.id, order.version, text)
      : ordersApi.setStatus(order.id, action.to, order.version, action.needsReason ? text : undefined)));
  };

  const actions = order && role ? actionsFor(role, order.status) : [];

  return (
    <Dialog open={orderId !== null} onClose={onClose} title={order ? `Order ${order.ref}` : 'Order'}
      footer={<Button onClick={onClose}>Close</Button>}>
      {!order && !error ? (
        <div aria-busy="true" className="space-y-2"><span className="sr-only">Loading the order</span>
          <Skeleton className="h-6 w-1/2" /><Skeleton className="h-24 w-full" /></div>
      ) : null}
      {error ? <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p> : null}
      {notice ? <p role="status" className="mb-3 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">{notice}</p> : null}

      {order ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <OrderStatusChip status={order.status} />
            <span>Table <span className="font-semibold tabular text-text">{order.table.tableNumber}</span></span>
            <span>· placed {timeIn(order.placedAt, order.timezone)}</span>
          </div>

          {order.status === 'cancelled' && order.cancelReason ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">Cancelled: {order.cancelReason}</p>
          ) : null}

          <section aria-labelledby="order-lines">
            <h3 id="order-lines" className="sr-only">Items</h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {order.lines.map((line, index) => (
                <li key={index} className="flex gap-3 px-3 py-2 text-sm">
                  <span className="tabular font-semibold text-text">{line.quantity}×</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-text">{line.name}</p>
                    {line.note ? <p className="text-xs text-muted">Note: {line.note}</p> : null}
                  </div>
                  <span className="tabular text-text">{formatMoney(line.lineTotalMinor, order.currency)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex justify-between text-sm"><span className="text-muted">Subtotal</span>
              <span className="font-semibold tabular text-text">{formatMoney(order.subtotalMinor, order.currency)}</span></p>
            {order.specialInstructions ? (
              <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-text">“{order.specialInstructions}”</p>
            ) : null}
          </section>

          {order.contact !== undefined ? (
            <section aria-labelledby="order-contact" className="text-sm">
              <h3 id="order-contact" className="font-medium text-text">Customer contact</h3>
              {order.contact ? (
                <p className="text-muted">{[order.contact.mobile, order.contact.email].filter(Boolean).join(' · ')}</p>
              ) : <p className="text-muted">None given.</p>}
            </section>
          ) : null}

          <section aria-labelledby="order-note" className="text-sm">
            <h3 id="order-note" className="font-medium text-text">Staff note <span className="font-normal text-muted">(never shown to the customer)</span></h3>
            {editingNote ? (
              <div className="mt-2 space-y-2">
                <textarea aria-labelledby="order-note" rows={2} maxLength={500} className={textareaClass}
                  value={note} onChange={(event) => setNote(event.target.value)} />
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" loading={busy === 'note'}
                    onClick={() => void run('note', () => ordersApi.setNote(order.id, note.trim() || null, order.version))
                      .then(() => setEditingNote(false))}>Save note</Button>
                  <Button size="sm" onClick={() => setEditingNote(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex items-start gap-2">
                <p className="flex-1 text-muted">{order.staffNote ?? 'No note.'}</p>
                <Button size="sm" variant="ghost" onClick={() => { setNote(order.staffNote ?? ''); setEditingNote(true); }}>
                  {order.staffNote ? 'Edit' : 'Add note'}
                </Button>
              </div>
            )}
          </section>

          {actions.length ? (
            <section aria-labelledby="order-actions" className="space-y-3 border-t border-border pt-4">
              <h3 id="order-actions" className="sr-only">Actions</h3>
              <div className="flex flex-wrap gap-2">
                {actions.map((action) => (
                  <Button key={action.kind + action.to} size="sm" loading={busy === action.label}
                    variant={action.kind === 'advance' ? 'primary' : action.kind === 'cancel' ? 'danger' : 'secondary'}
                    onClick={() => act(action)}>
                    {action.label}
                  </Button>
                ))}
              </div>
              {pending ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <Field label={pending.kind === 'cancel' ? 'Why is this order being cancelled?' : `Why take it back to ${ORDER_STATUS_LABEL[pending.to]}?`}
                    required hint="Recorded in the order history and the activity log.">
                    {({ id, describedBy }) => (
                      <textarea id={id} aria-describedby={describedBy} rows={2} maxLength={300} className={textareaClass}
                        value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
                    )}
                  </Field>
                  <div className="flex gap-2">
                    <Button size="sm" variant={pending.kind === 'cancel' ? 'danger' : 'primary'} loading={busy === pending.label}
                      onClick={() => act(pending)}>
                      {pending.kind === 'cancel' ? 'Cancel this order' : 'Take it back'}
                    </Button>
                    <Button size="sm" onClick={() => setPending(null)}>Keep as is</Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          <section aria-labelledby="order-history" className="text-sm">
            <h3 id="order-history" className="font-medium text-text">History</h3>
            <ol className="mt-1 space-y-1 text-muted">
              {order.history.map((entry, index) => (
                <li key={index}>
                  <span className="tabular">{dateTimeIn(entry.at, order.timezone)}</span>
                  {' — '}{entry.from ? `${ORDER_STATUS_LABEL[entry.from]} → ` : 'Placed · '}{ORDER_STATUS_LABEL[entry.to]}
                  {entry.byRole ? ` by ${ROLE_LABEL[entry.byRole] ?? entry.byRole}` : ''}
                  {entry.reason ? ` (“${entry.reason}”)` : ''}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}
