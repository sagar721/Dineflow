import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { formatMoney } from '@dineflow/shared';
import { Button, Field, Input } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { orderApi, type Contact, type PublicItem, type PublicMenu, type Quote } from './api.ts';
import { MAX_NOTE, quantityOf, type Cart } from './cart.ts';

type Props = {
  token: string;
  menu: PublicMenu;
  cart: Cart;
  itemsById: ReadonlyMap<string, PublicItem>;
  onSetQuantity: (item: PublicItem, quantity: number) => void;
  onRemove: (menuItemId: string) => void;
  onNote: (menuItemId: string, note: string) => void;
  onBack: () => void;
  /** Places the order. Resolves on success; throws the API's error otherwise. */
  onPlace: (extra: { specialInstructions?: string; contact?: Contact }) => Promise<void>;
};

type QuoteState = { kind: 'loading' } | { kind: 'ready'; quote: Quote } | { kind: 'error'; error: ApiError | null };

const textareaClass = 'block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text';

/**
 * The review screen (FR-033, FR-034, FR-036). The total shown here comes from the
 * server, which priced this exact cart; the prices while browsing were only a guide.
 */
export function ReviewCart({ token, menu, cart, itemsById, onSetQuantity, onRemove, onNote, onBack, onPlace }: Props) {
  const [quote, setQuote] = useState<QuoteState>({ kind: 'loading' });
  const [instructions, setInstructions] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const policy = menu.ordering.contactPolicy;
  const currency = menu.restaurant.currency;

  // Re-priced by the server whenever the cart changes, after a short pause.
  useEffect(() => {
    if (cart.lines.length === 0) return;
    // An edited cart is a new attempt: the last refusal no longer applies.
    setError(null);
    let cancelled = false;
    setQuote((previous) => (previous.kind === 'ready' ? previous : { kind: 'loading' }));
    const timer = setTimeout(() => {
      orderApi.quote(token, cart)
        .then((result) => { if (!cancelled) setQuote({ kind: 'ready', quote: result }); })
        .catch((caught) => { if (!cancelled) setQuote({ kind: 'error', error: caught instanceof ApiError ? caught : null }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, cart]);

  const problem = error ?? (quote.kind === 'error' ? quote.error : null);
  // Lines the server refused, to mark them for removal.
  const refused = new Set(
    problem?.code === 'ORDER_ITEM_UNAVAILABLE' || problem?.code === 'QUANTITY_LIMIT'
      ? ((problem.fields ?? []) as unknown as { menuItemId?: string }[]).map((each) => each.menuItemId ?? '')
      : [],
  );

  const needMobile = policy === 'require_mobile' || policy === 'require_both';
  const needEmail = policy === 'require_email' || policy === 'require_both';
  const fieldError = (field: string) => (error?.code === 'VALIDATION_FAILED'
    ? error.fields?.find((each) => each.field === field)?.message : undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const contact: Contact = {};
    if (policy !== 'off') {
      if (mobile.trim()) contact.mobile = mobile.trim();
      if (email.trim()) contact.email = email.trim();
    }
    try {
      await onPlace({
        ...(instructions.trim() ? { specialInstructions: instructions.trim() } : {}),
        ...(Object.keys(contact).length ? { contact } : {}),
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN', 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (cart.lines.length === 0) {
    return (
      <div className="space-y-4 py-8 text-center">
        <h1 className="text-2xl font-semibold text-text">Your cart is empty</h1>
        <p className="text-sm text-muted">Add something from the menu to get started.</p>
        <Button variant="primary" onClick={onBack}>Back to the menu</Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 pb-28" noValidate>
      <div>
        <button type="button" onClick={onBack} className="inline-flex h-11 items-center gap-1 text-sm font-medium text-brand">
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to the menu
        </button>
        <h1 className="text-2xl font-semibold text-text">Review your order</h1>
        <p className="text-sm text-muted">Table {menu.table.tableNumber}</p>
      </div>

      {problem ? (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{problem.message}</p>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {cart.lines.map((line) => {
          const item = itemsById.get(line.menuItemId);
          const priced = quote.kind === 'ready' ? quote.quote.items.find((each) => each.menuItemId === line.menuItemId) : undefined;
          const name = priced?.name ?? item?.name ?? 'Item';
          const quantity = quantityOf(cart, line.menuItemId);
          return (
            <li key={line.menuItemId} className={`space-y-2 p-3 ${refused.has(line.menuItemId) ? 'bg-danger-bg' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text">{name}</p>
                  <p className="text-xs text-muted tabular">
                    {priced ? `${formatMoney(priced.unitPriceMinor, currency)} each` : item ? `${formatMoney(item.priceMinor, currency)} each` : ''}
                  </p>
                </div>
                <p className="font-semibold tabular text-text">
                  {priced ? formatMoney(priced.lineTotalMinor, currency) : '…'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center rounded-md border border-border-strong" role="group" aria-label={`${name} quantity`}>
                  <button type="button" className="grid size-11 place-items-center" aria-label={`Remove one ${name}`}
                    onClick={() => item && onSetQuantity(item, quantity - 1)}>
                    <Minus className="size-4" aria-hidden="true" />
                  </button>
                  <span className="min-w-8 text-center text-sm font-semibold tabular">{quantity}</span>
                  <button type="button" className="grid size-11 place-items-center disabled:opacity-40" aria-label={`Add one more ${name}`}
                    disabled={!item?.available || quantity >= menu.ordering.maxQtyPerLine}
                    onClick={() => item && onSetQuantity(item, quantity + 1)}>
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <Button size="sm" variant="ghost" iconLeft={<Trash2 className="size-4" />} onClick={() => onRemove(line.menuItemId)}>
                  Remove<span className="sr-only"> {name}</span>
                </Button>
              </div>
              <label className="block">
                <span className="sr-only">Note for {name}</span>
                <input type="text" maxLength={MAX_NOTE} placeholder="Add a note (optional), e.g. less spicy"
                  className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-muted"
                  value={line.note} onChange={(event) => onNote(line.menuItemId, event.target.value)} />
              </label>
            </li>
          );
        })}
      </ul>

      <Field label="Anything else the kitchen should know?" hint="Optional.">
        {({ id, describedBy }) => (
          <textarea id={id} aria-describedby={describedBy} rows={2} maxLength={500} className={textareaClass}
            value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        )}
      </Field>

      {policy !== 'off' ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-text">Your contact details{needMobile || needEmail ? '' : ' (optional)'}</legend>
          {policy !== 'require_email' ? (
            <Field label="Mobile number" required={needMobile} error={fieldError('contact.mobile')}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} type="tel" inputMode="tel" autoComplete="tel"
                  maxLength={20} value={mobile} onChange={(event) => setMobile(event.target.value)} />
              )}
            </Field>
          ) : null}
          {policy !== 'require_mobile' ? (
            <Field label="Email" required={needEmail} error={fieldError('contact.email')}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} type="email" autoComplete="email"
                  maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
              )}
            </Field>
          ) : null}
          <p className="text-xs text-muted">
            {menu.restaurant.name} uses these details only to reach you about this order. They are not used for marketing.
          </p>
        </fieldset>
      ) : null}

      {/* Sticky, so the total and the button are always under the thumb. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface px-4 py-3 shadow-raised">
        <div className="mx-auto flex max-w-md items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">Subtotal{quote.kind === 'ready' ? '' : ' (checking…)'} · taxes, if any, on your bill</p>
            <p className="text-lg font-semibold tabular text-text" aria-live="polite">
              {quote.kind === 'ready' ? formatMoney(quote.quote.subtotalMinor, currency) : '—'}
            </p>
          </div>
          <Button type="submit" variant="primary" size="lg" loading={busy}
            disabled={quote.kind !== 'ready' || !menu.restaurant.acceptingOrders}>
            Place order
          </Button>
        </div>
      </div>
    </form>
  );
}
