import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, BookOpen, ImageOff, Plus, Search } from 'lucide-react';
import { formatMoney } from '@dineflow/shared';
import { Page } from '@/app/AppShell.tsx';
import { Badge, Button, Card, Dialog, EmptyState, Field, IconButton, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { menuApi, type MenuCategory, type MenuData, type MenuItem } from './api.ts';
import { ItemDialog } from './ItemDialog.tsx';
import { DietMark } from './DietMark.tsx';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: MenuData };
type StatusFilter = 'all' | 'available' | 'sold_out' | 'hidden' | 'archived';

const selectClass = 'h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text';

/**
 * The menu editor (FR-020 … FR-028). Owners and managers shape the menu; kitchen
 * staff see it and can mark items sold out, and nothing else — the server enforces
 * the same split, so the hidden controls here are a courtesy, not the protection.
 */
export function MenuPage() {
  const { may } = useSession();
  const canWrite = may('menu.write');
  const canToggle = may('menu.item.toggleAvailability');

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<MenuCategory | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [showArchivedCategories, setShowArchivedCategories] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', data: await menuApi.load() });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load the menu.' });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const data = load.kind === 'ready' ? load.data : null;
  const liveCategories = useMemo(() => data?.categories.filter((c) => !c.archived) ?? [], [data]);
  const archivedCategories = useMemo(() => data?.categories.filter((c) => c.archived) ?? [], [data]);
  const categoryById = useMemo(() => new Map(data?.categories.map((c) => [c.id, c]) ?? []), [data]);

  /** Items in menu order: by category position, then the order within it. */
  const visibleItems = useMemo(() => {
    if (!data) return [];
    const position = new Map(data.categories.map((c, index) => [c.id, index]));
    const needle = search.trim().toLowerCase();
    return data.items
      .filter((item) => categoryFilter === 'all' || item.categoryId === categoryFilter)
      .filter((item) => {
        switch (statusFilter) {
          case 'available': return !item.archived && item.available;
          case 'sold_out': return !item.archived && !item.available;
          case 'hidden': return !item.archived && !item.visible;
          case 'archived': return item.archived;
          default: return !item.archived;
        }
      })
      .filter((item) => !needle || item.name.toLowerCase().includes(needle)
        || (item.description ?? '').toLowerCase().includes(needle))
      .sort((a, b) => (position.get(a.categoryId)! - position.get(b.categoryId)!) || a.sortOrder - b.sortOrder
        || a.name.localeCompare(b.name));
  }, [data, search, categoryFilter, statusFilter]);

  const replaceItem = (item: MenuItem) => setLoad((previous) => previous.kind === 'ready'
    ? { kind: 'ready', data: { ...previous.data, items: previous.data.items.map((each) => (each.id === item.id ? item : each)) } }
    : previous);

  async function run(id: string, action: () => Promise<unknown>, done?: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await action();
      if (done) setNotice({ tone: 'success', text: done });
    } catch (caught) {
      setNotice({ tone: 'danger', text: caught instanceof ApiError ? caught.message : 'Something went wrong.' });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  const toggleAvailable = (item: MenuItem) => run(item.id, async () => {
    replaceItem((await menuApi.setAvailability(item.id, !item.available)).item);
  }, `${item.name} is ${item.available ? 'now sold out' : 'available again'}.`);

  const moveCategory = (index: number, delta: -1 | 1) => run(`move-${index}`, async () => {
    const ids = liveCategories.map((c) => c.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    const { categories } = await menuApi.reorderCategories(ids);
    setLoad((previous) => previous.kind === 'ready' ? { kind: 'ready', data: { ...previous.data, categories } } : previous);
  });

  const updateCategory = (category: MenuCategory, changes: { visible?: boolean; archived?: boolean }, done: string) =>
    run(category.id, async () => {
      await menuApi.updateCategory(category.id, changes, category.version);
      await refresh();
    }, done);

  const itemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of data?.items ?? []) if (!item.archived) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
    return counts;
  }, [data]);

  const liveItemCount = data ? data.items.filter((item) => !item.archived).length : 0;

  return (
    <Page
      title="Menu"
      description={data ? `${liveItemCount} items in ${liveCategories.length} categories` : 'Categories, items and prices.'}
      actions={canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button iconLeft={<Plus className="size-4" />} onClick={() => { setEditingCategory(null); setCategoryOpen(true); }}>
            Add category
          </Button>
          <Button variant="primary" iconLeft={<Plus className="size-4" />} disabled={liveCategories.length === 0}
            title={liveCategories.length === 0 ? 'Add a category first' : undefined}
            onClick={() => { setEditingItem(null); setItemOpen(true); }}>
            Add item
          </Button>
        </div>
      ) : undefined}
    >
      {notice ? (
        <p role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`mb-3 rounded-md px-3 py-2 text-sm font-medium ${
            notice.tone === 'danger' ? 'bg-danger-bg text-danger' : 'bg-success-bg text-success'}`}>
          {notice.text}
        </p>
      ) : null}

      {load.kind === 'loading' ? (
        <div aria-busy="true" className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <span className="sr-only">Loading the menu</span>
          <Skeleton className="h-64 w-full" />
          <div className="space-y-2"><Skeleton className="h-11 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
        </div>
      ) : null}

      {load.kind === 'error' ? (
        <Card>
          <div className="space-y-3 p-5">
            <p role="alert" className="text-sm font-medium text-danger">{load.message}</p>
            <Button onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>Try again</Button>
          </div>
        </Card>
      ) : null}

      {data && data.categories.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="size-8" />}
            title="No menu yet"
            description="Start with a category, such as Starters or Drinks, then add items to it."
            action={canWrite ? (
              <Button variant="primary" iconLeft={<Plus className="size-4" />}
                onClick={() => { setEditingCategory(null); setCategoryOpen(true); }}>
                Add your first category
              </Button>
            ) : undefined}
          />
        </Card>
      ) : null}

      {data && data.categories.length > 0 ? (
        <div className="grid items-start gap-4 lg:grid-cols-[300px_1fr]">
          {/* ------------------------------------------------------ categories */}
          <Card>
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-text">Categories</h2>
              <p className="text-xs text-muted">In the order customers see them.</p>
            </div>
            <ul className="divide-y divide-border">
              {liveCategories.map((category, index) => (
                <li key={category.id} className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-text">{category.name}</p>
                      <p className="text-xs text-muted">
                        {itemCounts.get(category.id) ?? 0} items
                        {!category.visible ? ' · Hidden from customers' : ''}
                      </p>
                    </div>
                    {canWrite ? (
                      <div className="flex gap-1">
                        <IconButton size="sm" label={`Move ${category.name} up`} icon={<ArrowUp className="size-4" />}
                          disabled={index === 0 || busyId !== null} onClick={() => void moveCategory(index, -1)} />
                        <IconButton size="sm" label={`Move ${category.name} down`} icon={<ArrowDown className="size-4" />}
                          disabled={index === liveCategories.length - 1 || busyId !== null}
                          onClick={() => void moveCategory(index, 1)} />
                      </div>
                    ) : null}
                  </div>
                  {canWrite ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => { setEditingCategory(category); setCategoryOpen(true); }}>
                        Rename<span className="sr-only"> {category.name}</span>
                      </Button>
                      <Button size="sm" variant="ghost" loading={busyId === category.id}
                        onClick={() => void updateCategory(category, { visible: !category.visible },
                          `${category.name} is ${category.visible ? 'hidden from' : 'shown to'} customers.`)}>
                        {category.visible ? 'Hide' : 'Show'}<span className="sr-only"> {category.name}</span>
                      </Button>
                      <Button size="sm" variant="ghost"
                        onClick={() => void updateCategory(category, { archived: true }, `${category.name} archived.`)}>
                        Archive<span className="sr-only"> {category.name}</span>
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {archivedCategories.length > 0 ? (
              <div className="border-t border-border px-4 py-3">
                <button type="button" className="text-xs font-medium text-brand hover:underline"
                  aria-expanded={showArchivedCategories} onClick={() => setShowArchivedCategories((open) => !open)}>
                  {showArchivedCategories ? 'Hide' : 'Show'} archived ({archivedCategories.length})
                </button>
                {showArchivedCategories ? (
                  <ul className="mt-2 space-y-2">
                    {archivedCategories.map((category) => (
                      <li key={category.id} className="flex items-center justify-between gap-2 text-sm text-muted">
                        <span className="truncate">{category.name}</span>
                        {canWrite ? (
                          <Button size="sm" variant="ghost" loading={busyId === category.id}
                            onClick={() => void updateCategory(category, { archived: false }, `${category.name} restored.`)}>
                            Restore<span className="sr-only"> {category.name}</span>
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Card>

          {/* ----------------------------------------------------------- items */}
          <div>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Field label="Search items">
                  {({ id }) => (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                      <Input id={id} type="search" className="pl-9" placeholder="Name or description"
                        value={search} onChange={(event) => setSearch(event.target.value)} />
                    </div>
                  )}
                </Field>
              </div>
              <Field label="Category">
                {({ id }) => (
                  <select id={id} className={selectClass} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                    <option value="all">All</option>
                    {data.categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}{category.archived ? ' (archived)' : ''}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Show">
                {({ id }) => (
                  <select id={id} className={selectClass} value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    <option value="all">All current items</option>
                    <option value="available">Available</option>
                    <option value="sold_out">Sold out</option>
                    <option value="hidden">Hidden</option>
                    <option value="archived">Archived</option>
                  </select>
                )}
              </Field>
            </div>

            <p className="sr-only" role="status" aria-live="polite">{visibleItems.length} items shown</p>

            {visibleItems.length === 0 ? (
              <Card>
                <EmptyState
                  title={data.items.length === 0 ? 'No items yet' : 'No items match'}
                  description={data.items.length === 0
                    ? 'Add items to your categories. Each needs a name and a price.'
                    : 'Try a different search or filter.'}
                  action={canWrite && data.items.length === 0 && liveCategories.length > 0 ? (
                    <Button variant="primary" iconLeft={<Plus className="size-4" />}
                      onClick={() => { setEditingItem(null); setItemOpen(true); }}>
                      Add an item
                    </Button>
                  ) : undefined}
                />
              </Card>
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {visibleItems.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" loading="lazy" decoding="async" width={56} height={56}
                          className="size-14 shrink-0 rounded-md border border-border object-cover" />
                      ) : (
                        <div className="grid size-14 shrink-0 place-items-center rounded-md bg-surface-2 text-muted" aria-hidden="true">
                          <ImageOff className="size-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-text">
                          <DietMark diet={item.diet} className="mr-1.5" />
                          {item.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {categoryById.get(item.categoryId)?.name ?? 'Unknown category'}
                        </p>
                      </div>
                      <p className="font-medium tabular text-text">{formatMoney(item.priceMinor, data.currency)}</p>
                      <div className="flex flex-wrap gap-1">
                        {item.archived ? <Badge>Archived</Badge> : null}
                        {!item.archived && !item.visible ? <Badge tone="warning">Hidden</Badge> : null}
                        {!item.archived && !item.available ? <Badge tone="danger">Sold out</Badge> : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canToggle && !item.archived ? (
                          <Button size="sm" variant={item.available ? 'secondary' : 'primary'} loading={busyId === item.id}
                            aria-pressed={!item.available} onClick={() => void toggleAvailable(item)}>
                            {item.available ? 'Mark sold out' : 'Mark available'}
                            <span className="sr-only"> {item.name}</span>
                          </Button>
                        ) : null}
                        {canWrite ? (
                          <Button size="sm" onClick={() => { setEditingItem(item); setItemOpen(true); }}>
                            Edit<span className="sr-only"> {item.name}</span>
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {data.truncated ? <p className="mt-2 text-xs text-muted">Showing the first 2,000 items.</p> : null}
          </div>
        </div>
      ) : null}

      <ItemDialog
        open={itemOpen}
        item={editingItem}
        categories={data?.categories ?? []}
        defaultCategoryId={categoryFilter !== 'all' ? categoryFilter : undefined}
        onClose={() => setItemOpen(false)}
        onSaved={(item) => {
          setItemOpen(false);
          setNotice({ tone: 'success', text: `${item.name} saved.` });
          void refresh();
        }}
        onChanged={replaceItem}
      />
      <CategoryDialog
        open={categoryOpen}
        category={editingCategory}
        onClose={() => setCategoryOpen(false)}
        onSaved={(category) => {
          setCategoryOpen(false);
          setNotice({ tone: 'success', text: `${category.name} saved.` });
          void refresh();
        }}
      />
    </Page>
  );
}

function CategoryDialog({ open, category, onClose, onSaved }: {
  open: boolean; category: MenuCategory | null; onClose: () => void; onSaved: (category: MenuCategory) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setError(null);
  }, [open, category]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return setError('Enter a name.');
    if (trimmed.length > 60) return setError('Use 60 characters or fewer.');
    setBusy(true);
    try {
      const result = category
        ? await menuApi.updateCategory(category.id, { name: trimmed }, category.version)
        : await menuApi.createCategory(trimmed);
      onSaved(result.category);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={category ? `Rename ${category.name}` : 'Add a category'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="menu-category-form" variant="primary" loading={busy}>
            {category ? 'Save' : 'Add category'}
          </Button>
        </>
      }
    >
      <form id="menu-category-form" onSubmit={submit} noValidate>
        <Field label="Name" required hint="Such as Starters, Mains or Drinks." error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} autoFocus maxLength={60}
              value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
