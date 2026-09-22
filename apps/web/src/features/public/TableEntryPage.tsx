import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { QrCode } from 'lucide-react';
import { formatMoney, type Currency } from '@dineflow/shared';
import { Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { DietMark } from '@/features/menu/DietMark.tsx';
import type { Diet } from '@/features/menu/api.ts';

type PublicItem = {
  id: string; name: string; description: string | null; priceMinor: number;
  imageUrl: string | null; diet: Diet; available: boolean;
};

type Entry = {
  restaurant: { name: string; brandColor: string | null; acceptingOrders: boolean; currency: Currency };
  table: { tableNumber: string; name: string | null };
  categories: { id: string; name: string; items: PublicItem[] }[];
};

type State = { kind: 'loading' } | { kind: 'ready'; entry: Entry } | { kind: 'unavailable'; message: string };

/**
 * What a customer sees after scanning a table's QR code: the restaurant, their
 * table and the menu (FR-030, FR-031, FR-025).
 *
 * Everything comes from the API for this one token; hidden and archived items
 * never reach the phone, and sold-out items are shown as such. Ordering is the
 * next module, so there is no cart yet. It never shows an internal id, and every
 * way a code can fail looks the same.
 */
export function TableEntryPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiFetch<Entry>(`/public/tables/${encodeURIComponent(token)}/menu`)
      .then((entry) => setState({ kind: 'ready', entry }))
      .catch((caught) => setState({
        kind: 'unavailable',
        message: caught instanceof ApiError && caught.status !== 500
          ? caught.message
          : 'We could not load this table. Please ask a member of staff for help.',
      }));
  }, [token]);

  // The accent colour is only ever a stripe: it is chosen by the restaurant and has
  // not been contrast-checked, so it never sits behind text.
  const accent = state.kind === 'ready' ? state.entry.restaurant.brandColor ?? undefined : undefined;

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <div className="h-1.5 w-full bg-brand" style={accent ? { backgroundColor: accent } : undefined} aria-hidden="true" />
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-6">
        {state.kind === 'loading' ? (
          <div aria-busy="true" className="space-y-3">
            <h1 className="text-2xl font-semibold text-text">Finding your table</h1>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {state.kind === 'ready' ? <Menu entry={state.entry} /> : null}

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
    </main>
  );
}

function Menu({ entry }: { entry: Entry }) {
  const { restaurant, table, categories } = entry;
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

      <p role="note" className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
        {restaurant.acceptingOrders
          ? 'Ordering from your phone is coming soon. For now, please order with a member of staff.'
          : 'This restaurant is not taking orders here right now. Please ask a member of staff.'}
      </p>

      {categories.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">The menu is being prepared. Please ask a member of staff.</p>
      ) : (
        <>
          {categories.length > 1 ? (
            // Jump links, scrollable sideways so a long menu stays one-handed.
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
            <section key={category.id} id={`section-${category.id}`} aria-labelledby={`heading-${category.id}`}
              className="scroll-mt-4">
              <h2 id={`heading-${category.id}`} className="mb-2 text-lg font-semibold text-text">{category.name}</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
                {category.items.map((item) => (
                  <li key={item.id} className={`flex gap-3 p-3 ${item.available ? '' : 'opacity-60'}`}>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text">
                        <DietMark diet={item.diet} className="mr-1.5" />
                        {item.name}
                      </p>
                      {item.description ? <p className="mt-0.5 text-sm text-muted">{item.description}</p> : null}
                      <p className="mt-1 text-sm font-semibold tabular text-text">
                        {formatMoney(item.priceMinor, restaurant.currency)}
                        {!item.available ? (
                          <span className="ml-2 rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger">Sold out</span>
                        ) : null}
                      </p>
                    </div>
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt="" loading="lazy" decoding="async" width={88} height={88}
                        className="size-22 shrink-0 rounded-md object-cover" />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
