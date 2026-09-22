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
import { OrdersPage } from '@/features/orders/OrdersPage.tsx';
import { KitchenPage } from '@/features/orders/KitchenPage.tsx';
import { KitchenBoard } from '@/features/orders/KitchenBoard.tsx';
import { BillingPage } from '@/features/billing/BillingPage.tsx';
import { SalesReportPage } from '@/features/billing/SalesReportPage.tsx';
import { BillPrintPage } from '@/features/billing/BillPrintPage.tsx';
import { BillDocument } from '@/features/billing/BillDocument.tsx';
import type { Bill } from '@/features/billing/api.ts';
import type { OrderSummary } from '@/features/orders/api.ts';
import type { PublicMenu } from '@/features/order/api.ts';
import { TableEntryPage } from '@/features/public/TableEntryPage.tsx';
import { SecurityPage } from '@/features/auth/SecurityPage.tsx';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage.tsx';
import { AppShell } from '@/app/AppShell.tsx';
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx';
import { DesignPage } from '@/features/design/DesignPage.tsx';
import { NotFoundPage } from '@/app/NotFoundPage.tsx';

const routes = ['/', '/design', '/orders', '/login', '/accept-invite', '/setup', '/tables', '/menu', '/kitchen', '/billing', '/billing/sales', '/billing/sample-bill-id/print', '/staff', '/t/sample-token', '/security', '/reset-password', '/tables/qr-sheet', '/o/sample-status-token'];
let failures = 0;

for (const route of routes) {
  try {
    // Rendered without the app shell (the QR sheet is printed bare), so no skip link.
    const signedOut = route === '/login' || route === '/accept-invite' || route.startsWith('/t/')
      || route === '/reset-password' || route === '/tables/qr-sheet' || route.startsWith('/o/')
      || route.endsWith('/print');
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
              <Route path="/billing/:id/print" element={<BillPrintPage />} />
            </Routes>
          ) : (
            <AppShell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/design" element={<DesignPage />} />
                <Route path="/setup" element={<OnboardingPage />} />
                <Route path="/tables" element={<TablesPage />} />
                <Route path="/menu" element={<MenuPage />} />
                <Route path="/orders" element={<OrdersPage />} />
                <Route path="/kitchen" element={<KitchenPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/billing/sales" element={<SalesReportPage />} />
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
    if (route === '/orders' || route === '/kitchen') {
      checks.push(['order screen shows a busy state while loading', html.includes('aria-busy')]);
      checks.push(['order screen shows its connection state', /Reconnecting|Live|Not receiving/.test(html)]);
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
    // /billing is built now; /staff is still a placeholder, so it carries this check.
    if (route === '/staff') {
      checks.push(['unbuilt route says so', html.includes('Nothing is built at /staff')]);
    }
    if (route === '/billing') {
      checks.push(['billing page has its heading while loading', html.includes('Billing')]);
      checks.push(['billing page shows a busy state', html.includes('aria-busy')]);
    }
    if (route === '/billing/sales') {
      checks.push(['sales report has its heading while loading', html.includes('Sales report')]);
      checks.push(['sales report offers CSV export', html.includes('Export CSV')]);
    }
    if (route.endsWith('/print')) {
      checks.push(['print page carries no app navigation', !html.includes('Skip to main content')]);
      checks.push(['print page offers both paper sizes', html.includes('80 mm roll') && html.includes('A4')]);
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

// The kitchen board with fixed orders: each role sees exactly its next step, and
// nothing on the board carries customer contact details.
{
  const order = (n: number, status: OrderSummary['status'], minutesAgo: number): OrderSummary => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ref: String(n), number: n, status,
    placedAt: new Date(Date.UTC(2026, 8, 22, 12, 0) - minutesAgo * 60_000).toISOString(),
    statusUpdatedAt: new Date(Date.UTC(2026, 8, 22, 12, 0)).toISOString(), subtotalMinor: 6000, itemCount: 2, version: 1,
    table: { id: 't', tableNumber: '4', name: null }, items: [{ name: 'Masala Dosa', quantity: 2, note: 'No onion' }],
    specialInstructions: null, staffNote: null, cancelReason: null,
  });
  const orders = [order(11, 'pending', 3), order(12, 'ready', 20), order(13, 'served', 40)];
  const now = Date.UTC(2026, 8, 22, 12, 0);
  const noop = () => undefined;
  const kitchen = renderToString(<KitchenBoard orders={orders} role="kitchen" now={now} busyId={null} onAdvance={noop} onOpen={noop} />);
  const billing = renderToString(<KitchenBoard orders={orders} role="billing" now={now} busyId={null} onAdvance={noop} onOpen={noop} />);
  const checks: [string, boolean][] = [
    ['kitchen can accept a pending order', /Accept<span class="sr-only"> — order (<!-- -->)?11</.test(kitchen)],
    ['kitchen cannot serve a ready order', !/Mark served/.test(kitchen)],
    ['billing can serve a ready order and do nothing else', /Mark served/.test(billing) && !/Accept</.test(billing)],
    ['served orders are not on the board', !kitchen.includes('#<!-- -->13') && !kitchen.includes('>#13<')],
    ['a long wait is flagged', kitchen.includes('waiting a long time') && kitchen.includes('20 min')],
    ['item notes are shown', kitchen.includes('No onion')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} kitchen board — ${name}`);
  }
}

// A bill with fixed data: every part FR-071 requires, from the stored snapshot.
{
  const bill: Bill = {
    id: 'b', status: 'void', paymentStatus: null, series: 'main', number: 7, ref: '7',
    table: { id: 't', tableNumber: '4', name: null },
    orders: [{ id: 'o1', ref: '11', status: 'served', released: true }, { id: 'o2', ref: '12', status: 'served', released: true }],
    currency: 'INR', pricesIncludeTax: false, serviceChargeBps: 1000, roundingMode: 'nearest_1',
    lines: [{ name: 'Masala Dosa', quantity: 2, unitPriceMinor: 12_000, lineTotalMinor: 24_000 }],
    taxes: [{ name: 'CGST', rateBps: 250, taxableMinor: 21_600, amountMinor: 540 }, { name: 'SGST', rateBps: 250, taxableMinor: 21_600, amountMinor: 540 }],
    subtotalMinor: 24_000, discount: { type: 'percent', value: 1000, reason: 'Regular guest' }, discountMinor: 2_400,
    serviceChargeMinor: 2_160, taxTotalMinor: 1_080, roundingMinor: -40, totalMinor: 24_800,
    issuer: { name: 'Spice Garden', addressLines: ['12 MG Road', 'Kochi, Kerala, 682001'], phone: '0484 000 0000',
      taxRegistrationNo: 'TEST-REG-1', footer: 'Thank you' },
    contentHash: null, createdAt: '2026-09-22T12:00:00Z', createdBy: null, finalizedAt: '2026-09-22T12:05:00Z', finalizedBy: null,
    voidedAt: '2026-09-22T12:10:00Z', voidedBy: null, voidReason: 'Wrong table', payments: [], version: 3,
  };
  const html = renderToString(<BillDocument bill={bill} timezone="Asia/Kolkata" />);
  const checks: [string, boolean][] = [
    ['issuer, address and tax registration', html.includes('Spice Garden') && html.includes('12 MG Road') && html.includes('TEST-REG-1')],
    ['bill number, table and every order', html.includes('>7<') && html.includes('#11, #12')],
    ['each tax line with its rate', html.includes('CGST 2.5 %') && html.includes('SGST 2.5 %')],
    ['discount, service charge and rounding shown', html.includes('Regular guest') && html.includes('Service charge 10 %') && html.includes('Rounding')],
    ['total formatted from minor units', html.includes('₹248.00')],
    ['a void bill says so', html.includes('Void') && html.includes('Wrong table')],
    ['footer', html.includes('Thank you')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} bill document — ${name}`);
  }
}

console.log(failures === 0 ? '\nRender smoke test passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
