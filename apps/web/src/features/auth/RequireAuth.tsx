import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { AnyPermissionKey } from '@dineflow/shared';
import { Card, EmptyState, Skeleton } from '@/components/ui/index.ts';
import { useSession } from './SessionProvider.tsx';

/**
 * Gate for signed-in routes.
 *
 * This hides screens; it does not protect data. Every request the screen makes is
 * authorized again on the server, so a user who edits their way past this gate sees
 * an empty shell and a string of 403s.
 */
export function RequireAuth({ children, permission }: { children: ReactNode; permission?: AnyPermissionKey }) {
  const { state, may } = useSession();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <div className="space-y-3 p-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your session</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (state.status === 'signed-out') {
    // Remember where they were headed so the sign-in lands them back there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (permission && !may(permission)) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to this"
          description="Your role does not include this area. If you think that is wrong, ask your restaurant owner."
        />
      </Card>
    );
  }

  return <>{children}</>;
}
