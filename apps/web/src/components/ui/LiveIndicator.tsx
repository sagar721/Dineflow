import { cn } from '@/lib/cn.ts';

export type ConnectionState = 'live' | 'reconnecting' | 'offline';

const COPY: Record<ConnectionState, { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'text-success' },
  reconnecting: { label: 'Reconnecting', tone: 'text-warning' },
  offline: { label: 'Not receiving orders', tone: 'text-danger' },
};

/**
 * Staff must be able to tell "no new orders" from "not receiving orders" — the two
 * look identical on a quiet screen and only one of them loses money (FR-050).
 */
export function LiveIndicator({ state, lastUpdated }: { state: ConnectionState; lastUpdated?: Date }) {
  const { label, tone } = COPY[state];
  return (
    <div className="flex items-center gap-2 text-xs" role="status" aria-live="polite">
      <span
        className={cn('size-2 rounded-full bg-current', tone, state === 'live' && 'motion-safe:animate-pulse')}
        aria-hidden="true"
      />
      <span className={cn('font-medium', tone)}>{label}</span>
      {lastUpdated ? (
        <span className="text-muted">
          updated{' '}
          {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      ) : null}
    </div>
  );
}
