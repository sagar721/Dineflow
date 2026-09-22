import { useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '@/components/ui/index.ts';
import { ordersApi, type LiveUpdate } from './api.ts';
import { unannounced } from './board.ts';

/** Design D-05: poll every 3 s while the screen is visible; worst case ≈ 3 s + network (NFR-P04). */
export const POLL_MS = 3_000;
/** After this long without a successful poll, staff are told orders are not arriving. */
const OFFLINE_AFTER_MS = 15_000;

type Options = {
  /** Something changed: refetch what is on screen. */
  onChange: () => void;
  /** Orders placed since the last poll, each reported once. */
  onNewOrders?: (orders: LiveUpdate['newOrders']) => void;
};

/**
 * Live orders (FR-050), behind one hook so the transport can change later (design
 * D-05 names SSE as the upgrade path) without touching the screens.
 *
 * Polls only while the tab is visible. Reports "reconnecting" on the first failed
 * poll and "offline" if none succeeds for 15 s, so a quiet screen is never mistaken
 * for one that has stopped receiving orders.
 */
export function useLiveOrders({ onChange, onNewOrders }: Options) {
  const [state, setState] = useState<ConnectionState>('reconnecting');
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>();
  const handlers = useRef({ onChange, onNewOrders });
  handlers.current = { onChange, onNewOrders };

  useEffect(() => {
    let cursor: string | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSuccess = Date.now();
    const seenVersions = new Map<string, number>();
    const announced = new Set<string>();

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const update = await ordersApi.live(cursor);
          if (stopped) return;
          const first = cursor === undefined;
          cursor = update.cursor;
          lastSuccess = Date.now();
          setState('live');
          setLastUpdated(new Date());
          // The server looks back a few seconds to catch late commits, so the same
          // change can be reported twice; only a new version counts.
          const fresh = update.changes.filter((change) => (seenVersions.get(change.id) ?? 0) < change.version);
          for (const change of fresh) seenVersions.set(change.id, change.version);
          if (!first && fresh.length) handlers.current.onChange();
          const arrivals = unannounced(update.newOrders, announced);
          for (const order of arrivals) announced.add(order.id);
          if (!first && arrivals.length) handlers.current.onNewOrders?.(arrivals);
        } catch {
          if (stopped) return;
          setState(Date.now() - lastSuccess >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting');
        }
      }
      timer = setTimeout(poll, POLL_MS);
    };

    // Catch up at once when the screen comes back into view.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        handlers.current.onChange();
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { state, lastUpdated };
}
