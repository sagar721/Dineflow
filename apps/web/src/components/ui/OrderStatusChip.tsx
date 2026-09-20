import { ORDER_STATUS_LABEL, type OrderStatus } from '@dineflow/shared';
import { cn } from '@/lib/cn.ts';

/**
 * One map from status to appearance, so a status can never be shown in the right
 * colour on one screen and the wrong one on another. Colour is paired with the
 * label, never used alone (design system §5).
 */
const STYLES: Record<OrderStatus, string> = {
  pending: 'bg-status-pending-bg text-status-pending',
  accepted: 'bg-status-accepted-bg text-status-accepted',
  preparing: 'bg-status-preparing-bg text-status-preparing',
  ready: 'bg-status-ready-bg text-status-ready',
  served: 'bg-status-served-bg text-status-served',
  cancelled: 'bg-status-cancelled-bg text-status-cancelled',
};

export function OrderStatusChip({ status, className }: { status: OrderStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        STYLES[status],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {ORDER_STATUS_LABEL[status]}
    </span>
  );
}
