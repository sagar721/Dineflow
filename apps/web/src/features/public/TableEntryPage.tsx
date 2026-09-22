import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QrCode, ShoppingBag } from 'lucide-react';
import { formatMoney } from '@dineflow/shared';
import { Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { CustomerMenu } from '@/features/order/CustomerMenu.tsx';
import { ReviewCart } from '@/features/order/ReviewCart.tsx';
import {
  loadCart, loadMyOrders, orderApi, rememberOrder, saveCart, type Contact, type MyOrder, type PublicItem, type PublicMenu,
} from '@/features/order/api.ts';
import {
  addOne, browsingSubtotal, EMPTY_CART, reconcile, removeLine, setNote, setQuantity, totalQuantity, type Cart,
} from '@/features/order/cart.ts';

type State = { kind: 'loading' } | { kind: 'ready'; menu: PublicMenu } | { kind: 'unavailable'; message: string };

/**
 * What a customer sees after scanning a table's QR code: the menu, a cart, a review
 * screen and order placement (FR-030 … FR-041). No account, no login.
 *
 * Everything comes from the API for this one token. The cart lives on this device
 * only; the server re-checks and re-prices it when the order is placed.
 */
export function TableEntryPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [cart, setCartState] = useState<Cart>(EMPTY_CART);
  const [view, setView] = useState<'menu' | 'review'>('menu');
  const [notice, setNotice] = useState<string | null>(null);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);

  const setCart = useCallback((next: Cart) => {
    setCartState(next);
    saveCart(token, next);
  }, [token]);

  useEffect(() => {
    orderApi.menu(token)
      .then((menu) => {
        setState({ kind: 'ready', menu });
        // A cart kept from earlier is checked against today's menu before use.
        const items = new Map(menu.categories.flatMap((c) => c.items).map((item) => [item.id, item]));
        const { cart: restored, dropped } = reconcile(loadCart(token), items, menu.ordering);
        setCart(restored);
        if (dropped) setNotice(`${dropped === 1 ? 'An item' : `${dropped} items`} in your cart ${dropped === 1 ? 'is' : 'are'} no longer available and ${dropped === 1 ? 'was' : 'were'} removed.`);
        setMyOrders(loadMyOrders().filter((order) => order.tableToken === token));
      })
      .catch((caught) => setState({
        kind: 'unavailable',
        message: caught instanceof ApiError && caught.status !== 500
          ? caught.message
          : 'We could not load this table. Please ask a member of staff for help.',
      }));
  }, [token, setCart]);

  const menu = state.kind === 'ready' ? state.menu : null;
  const itemsById = useMemo(
    () => new Map((menu?.categories ?? []).flatMap((c) => c.items).map((item) => [item.id, item])),
    [menu],
  );

  const onAdd = (item: PublicItem) => menu && setCart(addOne(cart, item, menu.ordering));
  const onSetQuantity = (item: PublicItem, quantity: number) => menu && setCart(setQuantity(cart, item.id, quantity, menu.ordering));

  async function place(extra: { specialInstructions?: string; contact?: Contact }) {
    // One key per cart, saved before sending: a retry or reload after a lost
    // response reuses it, so the server returns the same order, never a second.
    const key = cart.idempotencyKey ?? crypto.randomUUID();
    const keyed: Cart = { ...cart, idempotencyKey: key };
    setCartState(keyed);
    saveCart(token, keyed);

    const { order, statusToken } = await orderApi.place(token, keyed, key, extra);
    rememberOrder({ statusToken, ref: order.ref, placedAt: order.placedAt, tableToken: token });
    saveCart(token, EMPTY_CART);
    navigate(`/o/${statusToken}`, { state: { order, justPlaced: true } });
  }

  const accent = menu?.restaurant.brandColor ?? undefined;
  const count = totalQuantity(cart);

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      {/* The accent colour is only ever a stripe: it is the restaurant's choice and
          has not been contrast-checked, so it never sits behind text. */}
      <div className="h-1.5 w-full bg-brand" style={accent ? { backgroundColor: accent } : undefined} aria-hidden="true" />
      <div className={`mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-6 ${count > 0 && view === 'menu' ? 'pb-28' : ''}`}>
        {state.kind === 'loading' ? (
          <div aria-busy="true" className="space-y-3">
            <h1 className="text-2xl font-semibold text-text">Finding your table</h1>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {menu && notice ? (
          <p role="status" className="mb-4 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">{notice}</p>
        ) : null}

        {menu && view === 'menu' ? (
          <>
            <CustomerMenu menu={menu} cart={cart} onAdd={onAdd} onSetQuantity={onSetQuantity} />
            {myOrders.length > 0 ? (
              <section aria-labelledby="my-orders" className="mt-8">
                <h2 id="my-orders" className="text-sm font-semibold text-text">Your orders at this table</h2>
                <ul className="mt-2 space-y-1">
                  {myOrders.map((order) => (
                    <li key={order.statusToken}>
                      <Link to={`/o/${order.statusToken}`} className="text-sm font-medium text-brand hover:underline">
                        Order {order.ref}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}

        {menu && view === 'review' ? (
          <ReviewCart
            token={token}
            menu={menu}
            cart={cart}
            itemsById={itemsById}
            onSetQuantity={onSetQuantity}
            onRemove={(id) => setCart(removeLine(cart, id))}
            onNote={(id, note) => setCart(setNote(cart, id, note))}
            onBack={() => setView('menu')}
            onPlace={place}
          />
        ) : null}

        {state.kind === 'unavailable' ? (
          <div className="space-y-4 pt-4 text-center">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-surface-2 text-muted" aria-hidden="true">
              <QrCode className="size-7" />
            </div>
            <h1 className="text-2xl font-semibold text-text">This code isn't working</h1>
            <p role="alert" className="text-sm text-muted">{state.message}</p>
          </div>
        ) : null}
      </div>

      {menu && view === 'menu' && count > 0 ? (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface px-4 py-3 shadow-raised">
          <button type="button" onClick={() => { setView('review'); window.scrollTo(0, 0); }}
            className="mx-auto flex h-12 w-full max-w-md items-center justify-between rounded-md bg-brand px-4 text-inverse">
            <span className="inline-flex items-center gap-2 font-semibold">
              <ShoppingBag className="size-5" aria-hidden="true" /> View cart · {count} {count === 1 ? 'item' : 'items'}
            </span>
            <span className="font-semibold tabular">{formatMoney(browsingSubtotal(cart, itemsById), menu.restaurant.currency)}</span>
          </button>
        </div>
      ) : null}
    </main>
  );
}
