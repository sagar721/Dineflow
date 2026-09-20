import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AnyPermissionKey, StaffRole } from '@dineflow/shared';
import { ApiError, apiFetch } from '@/lib/api.ts';

export type Session = {
  userId: string;
  kind: 'staff' | 'platform_admin';
  role: StaffRole | null;
  restaurantId: string | null;
  mfa: boolean;
  permissions: AnyPermissionKey[];
};

type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; session: Session }
  | { status: 'signed-out' };

type SessionContextValue = {
  state: SessionState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Whether the UI should show a control. Cosmetic only — the server checks the
   * same permission again for the request the control triggers, so hiding a button
   * is a courtesy, never a security boundary.
   */
  may: (key: AnyPermissionKey) => boolean;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const session = await apiFetch<Session>('/auth/me');
      setState({ status: 'signed-in', session });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: 'signed-out' });
        return;
      }
      // A network or server failure is not a sign-out: clearing the session here
      // would throw staff back to the login screen every time the API hiccups.
      setState((previous) => (previous.status === 'signed-in' ? previous : { status: 'signed-out' }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      // Whatever the server said, stop showing signed-in state on this device.
      setState({ status: 'signed-out' });
    }
  }, []);

  const value = useMemo<SessionContextValue>(() => ({
    state,
    refresh,
    signOut,
    may: (key) => state.status === 'signed-in' && state.session.permissions.includes(key),
  }), [state, refresh, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
