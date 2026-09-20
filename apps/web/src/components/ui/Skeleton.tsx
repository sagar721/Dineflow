import { cn } from '@/lib/cn.ts';

/** Placeholder for content that is loading. Announced as busy by its container. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} aria-hidden="true" />;
}
