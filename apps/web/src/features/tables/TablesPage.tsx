import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ListPlus, Plus, Printer, QrCode, Search, Table2 } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { naturalOrder, tablesApi, type DiningTable, type TableStatus } from './api.ts';
import { TableFormDialog } from './TableFormDialog.tsx';
import { QrDialog } from './QrDialog.tsx';
import { BulkTablesDialog } from './BulkTablesDialog.tsx';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tables: DiningTable[]; truncated: boolean };

type Filter = 'all' | TableStatus;

export function TablesPage() {
  const { may } = useSession();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [restaurantName, setRestaurantName] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const [editing, setEditing] = useState<DiningTable | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<DiningTable | null>(null);
  const [statusFor, setStatusFor] = useState<DiningTable | null>(null);

  const canWrite = may('table.write');
  const canSeeQr = may('qr.read');

  const refresh = useCallback(async () => {
    try {
      const { tables, truncated } = await tablesApi.list();
      setLoad({ kind: 'ready', tables, truncated });
    } catch (caught) {
      setLoad({ kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load your tables.' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The restaurant name goes on each printed QR card.
    apiFetch<{ restaurant: { name: string } }>('/restaurant')
      .then((data) => setRestaurantName(data.restaurant.name))
      .catch(() => undefined);
  }, [refresh]);

  // Filtering and ordering happen here rather than on the server: a restaurant has
  // a few dozen tables, and people expect T2 before T10, which SQL sorts the other way.
  const visible = useMemo(() => {
    if (load.kind !== 'ready') return [];
    const needle = search.trim().toLowerCase();
    return load.tables
      .filter((table) => filter === 'all' || table.status === filter)
      .filter((table) => !needle
        || table.tableNumber.toLowerCase().includes(needle)
        || (table.name ?? '').toLowerCase().includes(needle))
      .sort((a, b) => naturalOrder.compare(a.tableNumber, b.tableNumber));
  }, [load, search, filter]);

  const total = load.kind === 'ready' ? load.tables.length : 0;
  const active = load.kind === 'ready' ? load.tables.filter((t) => t.status === 'active').length : 0;

  return (
    <Page
      title="Tables & QR"
      description={load.kind === 'ready' ? `${active} active of ${total} tables` : 'Your tables and the codes customers scan.'}
      actions={canWrite || canSeeQr ? (
        <div className="flex flex-wrap gap-2">
          {canSeeQr ? (
            <Button iconLeft={<Printer className="size-4" />} onClick={() => navigate('/tables/qr-sheet')}>
              QR sheet
            </Button>
          ) : null}
          {canWrite ? (
            <>
              <Button iconLeft={<ListPlus className="size-4" />} onClick={() => setBulkOpen(true)}>
                Add several
              </Button>
              <Button variant="primary" iconLeft={<Plus className="size-4" />}
                onClick={() => { setEditing(null); setFormOpen(true); }}>
                Add table
              </Button>
            </>
          ) : null}
        </div>
      ) : undefined}
    >
      {notice ? (
        <p role="status" className="mb-3 rounded-md bg-success-bg px-3 py-2 text-sm font-medium text-success">{notice}</p>
      ) : null}

      {load.kind === 'loading' ? (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading your tables</span>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
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

      {load.kind === 'ready' && load.tables.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Table2 className="size-8" />}
            title="No tables yet"
            description="Add a table for each place customers sit. Each one gets its own QR code."
            action={canWrite ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" iconLeft={<Plus className="size-4" />}
                  onClick={() => { setEditing(null); setFormOpen(true); }}>
                  Add your first table
                </Button>
                <Button iconLeft={<ListPlus className="size-4" />} onClick={() => setBulkOpen(true)}>
                  Add several
                </Button>
              </div>
            ) : undefined}
          />
        </Card>
      ) : null}

      {load.kind === 'ready' && load.tables.length > 0 ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <Field label="Search tables">
                {({ id }) => (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                    <Input id={id} type="search" className="pl-9" placeholder="Number or name"
                      value={search} onChange={(event) => setSearch(event.target.value)} />
                  </div>
                )}
              </Field>
            </div>
            <Field label="Status">
              {({ id }) => (
                <select id={id} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}
                  className="h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text">
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              )}
            </Field>
          </div>

          {/* Announced when the filter changes, so a screen-reader user knows the
              list below has changed without having to go and look. */}
          <p className="sr-only" role="status" aria-live="polite">{visible.length} tables shown</p>

          {visible.length === 0 ? (
            <Card>
              <EmptyState title="No tables match" description="Try a different search or status filter." />
            </Card>
          ) : (
            <Card>
              <ul className="divide-y divide-border">
                {visible.map((table) => (
                  <li key={table.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold tabular text-text">
                        Table {table.tableNumber}
                        {table.name ? <span className="ml-2 font-normal text-muted">{table.name}</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {table.capacity} {table.capacity === 1 ? 'seat' : 'seats'}
                        {canSeeQr ? (table.qr ? ' · QR code issued' : ' · No QR code') : ''}
                      </p>
                      {table.notes ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                          <span className="sr-only">Notes: </span>{table.notes}
                        </p>
                      ) : null}
                    </div>

                    <Badge tone={table.status === 'active' ? 'success' : 'neutral'}>
                      {table.status === 'active' ? 'Active' : 'Inactive'}
                    </Badge>

                    <div className="flex flex-wrap gap-2">
                      {canSeeQr ? (
                        <Button size="sm" iconLeft={<QrCode className="size-4" />} onClick={() => setQrFor(table)}>
                          QR<span className="sr-only"> code for table {table.tableNumber}</span>
                        </Button>
                      ) : null}
                      {canWrite ? (
                        <>
                          <Button size="sm" onClick={() => { setEditing(table); setFormOpen(true); }}>
                            Edit<span className="sr-only"> table {table.tableNumber}</span>
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setStatusFor(table)}>
                            {table.status === 'active' ? 'Deactivate' : 'Activate'}
                            <span className="sr-only"> table {table.tableNumber}</span>
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {load.truncated ? (
            <p className="mt-2 text-xs text-muted">Showing the first 500 tables.</p>
          ) : null}
        </>
      ) : null}

      <TableFormDialog
        open={formOpen}
        table={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); void refresh(); }}
      />
      <BulkTablesDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onSaved={(created) => {
          setBulkOpen(false);
          setNotice(`${created} ${created === 1 ? 'table' : 'tables'} added.`);
          void refresh();
        }}
      />
      <QrDialog
        open={qrFor !== null}
        table={qrFor}
        restaurantName={restaurantName}
        onClose={() => setQrFor(null)}
        onChanged={() => void refresh()}
      />
      <StatusDialog
        table={statusFor}
        onClose={() => setStatusFor(null)}
        onChanged={() => { setStatusFor(null); void refresh(); }}
      />
    </Page>
  );
}

function StatusDialog({ table, onClose, onChanged }: {
  table: DiningTable | null; onClose: () => void; onChanged: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setReason(''); setError(null); }, [table]);

  const deactivating = table?.status === 'active';

  async function confirm() {
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      await tablesApi.setStatus(table.id, deactivating ? 'inactive' : 'active', table.version, reason.trim() || undefined);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={table !== null}
      onClose={onClose}
      size="sm"
      title={table ? `${deactivating ? 'Deactivate' : 'Activate'} table ${table.tableNumber}?` : ''}
      description={deactivating
        ? 'Its QR code will show customers a "not available" message. Nothing is deleted, and the same printed card works again when you reactivate it.'
        : 'Its QR code will work again straight away.'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={deactivating ? 'danger' : 'primary'} loading={busy} onClick={confirm}>
            {deactivating ? 'Deactivate' : 'Activate'}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p>
      ) : null}
      {deactivating ? (
        <Field label="Reason" hint="Optional. Recorded in the activity log.">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} maxLength={200} placeholder="For example: being repaired"
              value={reason} onChange={(event) => setReason(event.target.value)} />
          )}
        </Field>
      ) : null}
    </Dialog>
  );
}
