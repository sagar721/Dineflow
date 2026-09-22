import { Minus, Plus } from 'lucide-react';
import { formatMoney } from '@dineflow/shared';
import { DietMark } from '@/features/menu/DietMark.tsx';
import type { PublicItem, PublicMenu } from './api.ts';
import { quantityOf, totalQuantity, type Cart } from './cart.ts';

type Props = {
  menu: PublicMenu;
  cart: Cart;
  onAdd: (item: PublicItem) => void;
  onSetQuantity: (item: PublicItem, quantity: number) => void;
};

/**
 * The menu a customer browses (FR-030, FR-031, FR-025): mobile-first, one-handed,
 * with add and quantity controls. Sold-out items stay visible but cannot be added.
 * Presentational only, so it can be rendered with fixed data in the smoke test.
 */
export function CustomerMenu({ menu, cart, onAdd, onSetQuantity }: Props) {
  const { restaurant, table, categories, ordering } = menu;
  const full = totalQuantity(cart) >= ordering.maxItemsPerOrder;

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm font-medium text-muted">Welcome to</p>
        <h1 className="text-3xl font-semibold tracking-tight text-text">{restaurant.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Table <span className="font-semibold tabular text-text">{table.tableNumber}</span>
          {table.name ? ` · ${table.name}` : ''}
        </p>
      </header>

      {!restaurant.acceptingOrders ? (
        <p role="note" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          This restaurant is not taking orders here right now. You can still browse the menu, or ask a member of staff.
        </p>
      ) : null}

      {categories.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">The menu is being prepared. Please ask a member of staff.</p>
      ) : (
        <>
          {categories.length > 1 ? (
            <nav aria-label="Menu sections" className="-mx-4 overflow-x-auto px-4">
              <ul className="flex gap-2 pb-1">
                {categories.map((category) => (
                  <li key={category.id}>
                    <a href={`#section-${category.id}`}
                      className="inline-flex h-10 items-center whitespace-nowrap rounded-full border border-border bg-surface px-4 text-sm font-medium text-text">
                      {category.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          {categories.map((category) => (
            <section key={category.id} id={`section-${category.id}`} aria-labelledby={`heading-${category.id}`} className="scroll-mt-4">
              <h2 id={`heading-${category.id}`} className="mb-2 text-lg font-semibold text-text">{category.name}</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
                {category.items.map((item) => {
                  const quantity = quantityOf(cart, item.id);
                  const canAddMore = restaurant.acceptingOrders && item.available && !full && quantity < ordering.maxQtyPerLine;
                  return (
                    <li key={item.id} className={`flex gap-3 p-3 ${item.available ? '' : 'opacity-60'}`}>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-text">
                          <DietMark diet={item.diet} className="mr-1.5" />
                          {item.name}
                        </p>
                        {item.description ? <p className="mt-0.5 text-sm text-muted">{item.description}</p> : null}
                        <p className="mt-1 text-sm font-semibold tabular text-text">{formatMoney(item.priceMinor, restaurant.currency)}</p>

                        <div className="mt-2">
                          {!item.available ? (
                            <span className="inline-flex rounded-full bg-danger-bg px-2.5 py-1 text-xs font-medium text-danger">Sold out</span>
                          ) : !restaurant.acceptingOrders ? null : quantity === 0 ? (
                            <button type="button" disabled={!canAddMore} onClick={() => onAdd(item)}
                              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-brand px-4 text-sm font-semibold text-brand disabled:opacity-50">
                              <Plus className="size-4" aria-hidden="true" /> Add<span className="sr-only"> {item.name}</span>
                            </button>
                          ) : (
                            <div className="inline-flex items-center rounded-md border border-brand" role="group" aria-label={`${item.name} quantity`}>
                              <button type="button" onClick={() => onSetQuantity(item, quantity - 1)}
                                className="grid size-11 place-items-center text-brand" aria-label={`Remove one ${item.name}`}>
                                <Minus className="size-4" aria-hidden="true" />
                              </button>
                              <span className="min-w-8 text-center text-sm font-semibold tabular text-text" aria-live="polite">{quantity}</span>
                              <button type="button" disabled={!canAddMore} onClick={() => onAdd(item)}
                                className="grid size-11 place-items-center text-brand disabled:opacity-40" aria-label={`Add one more ${item.name}`}>
                                <Plus className="size-4" aria-hidden="true" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" loading="lazy" decoding="async" width={88} height={88}
                          className="size-22 shrink-0 rounded-md object-cover" />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
