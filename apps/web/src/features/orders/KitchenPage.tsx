import { useCallback, useEffect, useState } from 'react';
import { BellRing, ChefHat } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { Button, Card, EmptyState, LiveIndicator, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { KitchenBoard } from './KitchenBoard.tsx';
import { OrderDetailDialog } from './OrderDetailDialog.tsx';
import { useLiveOrders } from './useLiveOrders.ts';
import { chime, enableSound, soundReady } from './alert.ts';
import { actionsFor } from './board.ts';
import { ordersApi, type OrderPage, type OrderSummary } from './api.ts';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; page: OrderPage };

/**
 * The kitchen screen (FR-050, FR-056). Live: new orders appear within a few
 * seconds with a chime and a flash; the connection state is always visible so a
 * quiet screen is never mistaken for a broken one.
 */
export function KitchenPage() {
  const { state: session } = useSession();
  const role = session.status === 'signed-in' ? session.session.role : null;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [sound, setSound] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', page: await ordersApi.kitchen() });
    } catch (caught) {
      setLoad((previous) => previous.kind === 'ready'
        ? previous // keep the board on screen through a blip; the live indicator says so
        : { kind: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load the kitchen board.' });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // Elapsed times tick without refetching.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  const live = useLiveOrders({
    onChange: () => void refresh(),
    onNewOrders: () => {
      chime();
      setFlash(true);
      setTimeout(() => setFlash(false), 2_500);
    },
  });

  async function advance(order: OrderSummary) {
    if (!role) return;
    const next = actionsFor(role, order.status).find((action) => action.kind === 'advance');
    if (!next) return;
    setBusyId(order.id);
    setMessage(null);
    try {
      await ordersApi.setStatus(order.id, next.to, order.version);
    } catch (caught) {
      // A conflict means another screen got there first; the refresh shows where it is now.
      setMessage(caught instanceof ApiError ? caught.message : 'That did not go through. Please try again.');
    } finally {
      setBusyId(null);
      void refresh();
    }
  }

  return (
    <Page
      title="Kitchen"
      description="Active orders, oldest first."
      actions={
        <div className="flex items-center gap-3">
          <LiveIndicator state={live.state} lastUpdated={live.lastUpdated} />
          {!sound || !soundReady() ? (
            <Button size="sm" iconLeft={<BellRing className="size-4" />} onClick={() => void enableSound().then(setSound)}>
              Turn on sound
            </Button>
          ) : null}
        </div>
      }
    >
      <div className={`rounded-lg transition-shadow ${flash ? 'ring-4 ring-brand' : ''}`}>
        {flash ? <p role="status" className="sr-only">New order received</p> : null}
        {message ? <p role="alert" className="mb-3 rounded-md bg-warning-bg px-3 py-2 text-sm font-medium text-warning">{message}</p> : null}

        {load.kind === 'loading' ? (
          <div aria-busy="true" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <span className="sr-only">Loading the kitchen board</span>
            {[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-64 w-full" />)}
          </div>
        ) : null}

        {load.kind === 'error' ? (
          <Card><div className="space-y-3 p-5">
            <p role="alert" className="text-sm font-medium text-danger">{load.message}</p>
            <Button onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>Try again</Button>
          </div></Card>
        ) : null}

        {load.kind === 'ready' && load.page.orders.length === 0 ? (
          <Card><EmptyState icon={<ChefHat className="size-8" />} title="No active orders"
            description="New orders appear here as soon as customers place them." /></Card>
        ) : null}

        {load.kind === 'ready' && load.page.orders.length > 0 && role ? (
          <>
            <KitchenBoard orders={load.page.orders} role={role} now={now} busyId={busyId}
              onAdvance={(order) => void advance(order)} onOpen={(order) => setOpenId(order.id)} />
            {load.page.truncated ? <p className="mt-2 text-sm text-muted">Showing the 200 oldest active orders.</p> : null}
          </>
        ) : null}
      </div>

      <OrderDetailDialog orderId={openId} onClose={() => setOpenId(null)} onChanged={() => void refresh()} />
    </Page>
  );
}
