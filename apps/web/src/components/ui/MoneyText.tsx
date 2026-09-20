import { formatMoney, type Currency } from '@dineflow/shared';
import { cn } from '@/lib/cn.ts';

/**
 * The only way money is rendered. It takes minor units, never a pre-formatted
 * string, so a value cannot be rounded differently in two places on one screen.
 */
export function MoneyText({
  minor,
  currency = 'INR',
  className,
  emphasis = false,
}: {
  minor: number;
  currency?: Currency;
  className?: string;
  emphasis?: boolean;
}) {
  return (
    <span className={cn('tabular', emphasis && 'font-semibold', className)}>
      {formatMoney(minor, currency)}
    </span>
  );
}
