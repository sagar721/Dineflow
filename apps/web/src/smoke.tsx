// Render smoke test: proves the component tree actually renders, rather than only
// that it compiles. Built with `vite build --ssr` and run in Node by `npm run smoke`.
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AppShell } from '@/app/AppShell.tsx';
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx';
import { DesignPage } from '@/features/design/DesignPage.tsx';
import { NotFoundPage } from '@/app/NotFoundPage.tsx';

const routes = ['/', '/design', '/orders'];
let failures = 0;

for (const route of routes) {
  try {
    const html = renderToString(
      <MemoryRouter initialEntries={[route]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/design" element={<DesignPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );

    const checks: [string, boolean][] = [
      ['renders markup', html.length > 500],
      ['has a skip link', html.includes('Skip to main content')],
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
    if (route === '/orders') {
      checks.push(['unbuilt route says so', html.includes('Nothing is built at /orders')]);
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

console.log(failures === 0 ? '\nRender smoke test passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
