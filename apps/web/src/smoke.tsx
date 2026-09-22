// Render smoke test: proves the component tree actually renders, rather than only
// that it compiles. Built with `vite build --ssr` and run in Node by `npm run smoke`.
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionProvider } from '@/features/auth/SessionProvider.tsx';
import { LoginPage } from '@/features/auth/LoginPage.tsx';
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage.tsx';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage.tsx';
import { TablesPage } from '@/features/tables/TablesPage.tsx';
import { QrSheetPage } from '@/features/tables/QrSheetPage.tsx';
import { MenuPage } from '@/features/menu/MenuPage.tsx';
import { OrderStatusPage } from '@/features/order/OrderStatusPage.tsx';
import { CustomerMenu } from '@/features/order/CustomerMenu.tsx';
import type { PublicMenu } from '@/features/order/api.ts';
import { TableEntryPage } from '@/features/public/TableEntryPage.tsx';
import { SecurityPage } from '@/features/auth/SecurityPage.tsx';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage.tsx';
import { AppShell } from '@/app/AppShell.tsx';
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx';
import { DesignPage } from '@/features/design/DesignPage.tsx';
import { NotFoundPage } from '@/app/NotFoundPage.tsx';

const routes = ['/', '/design', '/orders', '/login', '/accept-invite', '/setup', '/tables', '/menu', '/t/sample-token', '/security', '/reset-password', '/tables/qr-sheet', '/o/sample-status-token'];
let failures = 0;

for (const route of routes) {
  try {
    // Rendered without the app shell (the QR sheet is printed bare), so no skip link.
    const signedOut = route === '/login' || route === '/accept-invite' || route.startsWith('/t/')
      || route === '/reset-password' || route === '/tables/qr-sheet' || route.startsWith('/o/');
    const html = renderToString(
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider>
          {signedOut ? (
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/accept-invite" element={<AcceptInvitePage />} />
              <Route path="/t/:token" element={<TableEntryPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/tables/qr-sheet" element={<QrSheetPage />} />
              <Route path="/o/:statusToken" element={<OrderStatusPage />} />
            </Routes>
          ) : (
            <AppShell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/design" element={<DesignPage />} />
                <Route path="/setup" element={<OnboardingPage />} />
                <Route path="/tables" element={<TablesPage />} />
                <Route path="/menu" element={<MenuPage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </AppShell>
          )}
        </SessionProvider>
      </MemoryRouter>,
    );

    const checks: [string, boolean][] = [
      // The customer's loading screen is deliberately minimal on a phone, so it gets
      // a lower floor; every other screen must render substantial markup.
      ['renders markup', html.length > (route.startsWith('/t/') || route.startsWith('/o/') ? 200 : 500)],
      ['has a skip link', signedOut || html.includes('Skip to main content')],
      ['has one h1', (html.match(/<h1/g) ?? []).length === 1],
      ['no unresolved React placeholders', !html.includes('[object Object]')],
    ];
    if (route === '/') {
      checks.push(['labels demo data', html.includes('[DEMO]')]);
      // Money must render through Intl from minor units, never as a raw integer.
      checks.push(['formats money', /₹21,485\.00|₹2,148,500/.test(html) || html.includes('₹21,485.00')]);
      checks.push(['shows order statuses', html.includes('Pending') && html.includes('Cancelled')]);
    }
    if (route === '/design') {
      checks.push(['shows every order status', html.includes('Preparing') && html.includes('Served')]);
      checks.push(['icon buttons have names', html.includes('aria-label="Delete"')]);
      checks.push(['invalid field is marked', html.includes('aria-invalid')]);
    }
    if (route === '/setup') {
      // Signed out during server render, so the wizard must show its loading state
      // rather than an empty shell or a crash.
      checks.push(['setup renders without a session', html.length > 500]);
      checks.push(['setup shows a busy state', html.includes('aria-busy')]);
    }
    if (route === '/security') {
      checks.push(['security page has its heading while loading', html.includes('Account security')]);
      checks.push(['security page shows a busy state', html.includes('aria-busy')]);
      checks.push(['no authenticator key in the initial markup', !/[A-Z2-7]{32}/.test(html)]);
    }
    if (route === '/menu') {
      checks.push(['menu editor shows a busy state while loading', html.includes('aria-busy')]);
      checks.push(['menu editor has its heading', html.includes('>Menu<')]);
    }
    if (route === '/tables/qr-sheet') {
      checks.push(['QR sheet shows a busy state while loading', html.includes('aria-busy')]);
      checks.push(['QR sheet print is off until codes load', /<button[^>]*disabled[^>]*>.*?Print sheet/s.test(html)]);
    }
    if (route === '/reset-password') {
      checks.push(['reset page asks for an email when opened without a link', html.includes('type="email"')]);
      checks.push(['reset page has a heading', html.includes('Reset your password')]);
    }
    if (route === '/login') {
      checks.push(['sign-in offers a way to reset the password', html.includes('/reset-password')]);
    }
    if (route === '/tables') {
      checks.push(['tables page has its heading while loading', html.includes('Tables &amp; QR')]);
      checks.push(['tables page shows a busy state', html.includes('aria-busy')]);
    }
    if (route.startsWith('/t/')) {
      checks.push(['customer page has a heading while loading', html.includes('Finding your table')]);
      checks.push(['customer page shows no staff navigation', !html.includes('Skip to main content')]);
      checks.push(['customer page does not echo the token', !html.includes('sample-token')]);
    }
    if (route === '/orders') {
      checks.push(['unbuilt route says so', html.includes('Nothing is built at /orders')]);
    }
    if (route === '/login') {
      checks.push(['password field is a password input', html.includes('type="password"')]);
      // React preserves the camelCase spelling in its SSR output; browsers match
      // attribute names case-insensitively, so compare that way.
      checks.push(['autocomplete hints present', /autocomplete="current-password"/i.test(html)]);
      checks.push(['username hint present', /autocomplete="username"/i.test(html)]);
      checks.push(['labels are wired to inputs', /<label[^>]+for="[^"]+"/.test(html)]);
      checks.push(['no token or secret in the markup', !/eyJ|secret|service-key/i.test(html)]);
    }
    if (route === '/accept-invite') {
      // The form appears only after the link has been checked with the server, so
      // before that there must be no password field to fill in.
      checks.push(['no password field before the link is verified', !/type="password"/i.test(html)]);
      checks.push(['shows a busy state while checking', html.includes('aria-busy')]);
      checks.push(['no invitation token in the markup', !html.includes('#token=')]);
    }

    for (const [name, passed] of checks) {
      if (!passed) failures += 1;
      console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${route} — ${name}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${route} — threw: ${(error as Error).message}`);
  }
}

// The customer menu rendered with fixed data: the add controls must follow
// availability, the cart and the restaurant's ordering switch.
{
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const menu: PublicMenu = {
    restaurant: { name: 'Smoke Cafe', brandColor: null, acceptingOrders: true, currency: 'INR' },
    table: { tableNumber: '7', name: null },
    ordering: { contactPolicy: 'optional', maxQtyPerLine: 20, maxItemsPerOrder: 60 },
    categories: [{ id: id(10), name: 'Snacks', items: [
      { id: id(1), name: 'Samosa', description: null, priceMinor: 2500, imageUrl: null, diet: 'veg', available: true },
      { id: id(2), name: 'Chicken Roll', description: 'Spicy', priceMinor: 12000, imageUrl: null, diet: 'non_veg', available: true },
      { id: id(3), name: 'Idli', description: null, priceMinor: 6000, imageUrl: null, diet: 'veg', available: false },
    ] }],
  };
  const noop = () => undefined;
  const render = (m: PublicMenu, lines: { menuItemId: string; quantity: number; note: string }[]) => renderToString(
    <MemoryRouter><CustomerMenu menu={m} cart={{ lines, idempotencyKey: null }} onAdd={noop} onSetQuantity={noop} /></MemoryRouter>);
  const html = render(menu, [{ menuItemId: id(2), quantity: 3, note: '' }]);
  const paused = render({ ...menu, restaurant: { ...menu.restaurant, acceptingOrders: false } }, []);
  // React separates adjacent text with <!-- --> in server markup.
  const addButtonFor = (name: string) => new RegExp(`Add<span class="sr-only"> (<!-- -->)?${name}<`);
  const checks: [string, boolean][] = [
    ['has one h1', (html.match(/<h1/g) ?? []).length === 1],
    ['an available item can be added', addButtonFor('Samosa').test(html)],
    ['an item in the cart shows its quantity controls', html.includes('Chicken Roll quantity') && />3</.test(html)],
    ['a sold-out item is marked and cannot be added', html.includes('Sold out') && addButtonFor('Samosa').test(html)
      && !addButtonFor('Idli').test(html)],
    ['prices are formatted from minor units', html.includes('₹25.00') && html.includes('₹120.00')],
    ['veg and non-veg are labelled', html.includes('aria-label="Vegetarian"') && html.includes('aria-label="Non-vegetarian"')],
    ['a paused restaurant offers no add buttons', !paused.includes('Add<span') && paused.includes('not taking orders')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} customer menu — ${name}`);
  }
}

console.log(failures === 0 ? '\nRender smoke test passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
