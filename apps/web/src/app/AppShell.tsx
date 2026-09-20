import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { LayoutDashboard, ClipboardList, ChefHat, QrCode, BookOpen, Receipt, Users, Settings, Palette } from 'lucide-react';
import { Wordmark } from '@/brand/Logo.tsx';
import { cn } from '@/lib/cn.ts';

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; ready?: boolean };

// The full navigation is shown from day one so the shape of the product is visible,
// but sections without a module behind them are marked rather than faked.
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, ready: true },
  { to: '/orders', label: 'Orders', icon: ClipboardList },
  { to: '/kitchen', label: 'Kitchen', icon: ChefHat },
  { to: '/tables', label: 'Tables & QR', icon: QrCode },
  { to: '/menu', label: 'Menu', icon: BookOpen },
  { to: '/billing', label: 'Billing', icon: Receipt },
  { to: '/staff', label: 'Staff', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/design', label: 'Design system', icon: Palette, ready: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-overlay"
      >
        Skip to main content
      </a>

      {/* Sidebar on laptops and up; a bottom bar takes over on phones, where a
          sidebar would eat a third of a small screen. */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Wordmark />
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-0.5">
            {NAV.map((item) => (
              <li key={item.to}>
                <SidebarLink item={item} />
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-border p-3 text-xs text-muted">
          <p className="font-medium text-text">Spice Garden</p>
          <p>Priya Nair · Owner</p>
        </div>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:hidden">
          <Wordmark size={24} />
        </header>

        <main id="main" className="px-4 pb-24 pt-4 sm:px-6 sm:pt-6 lg:pb-10">
          {children}
        </main>
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {NAV.slice(0, 5).map((item) => {
            const active = pathname === item.to;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium',
                    active ? 'text-brand' : 'text-muted',
                  )}
                >
                  <item.icon className="size-5" aria-hidden="true" />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-subtle text-brand' : 'text-muted hover:bg-surface-2 hover:text-text',
        )
      }
    >
      <item.icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
      {item.ready ? null : (
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          Soon
        </span>
      )}
    </NavLink>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
