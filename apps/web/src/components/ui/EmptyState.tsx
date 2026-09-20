import type { ReactNode } from 'react';

/**
 * An empty list explains why it is empty and what to do next. "No data" on its own
 * leaves a restaurant owner stuck.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted" aria-hidden="true">{icon}</div> : null}
      <p className="text-base font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
