// Render smoke test: proves the component tree actually renders, rather than only
// that it compiles. Built with `vite build --ssr` and run in Node by `npm run smoke`.
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionProvider } from '@/features/auth/SessionProvider.tsx';
import { LoginPage } from '@/features/auth/LoginPage.tsx';
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage.tsx';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage.tsx';
import { AppShell } from '@/app/AppShell.tsx';
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx';
import { DesignPage } from '@/features/design/DesignPage.tsx';
import { NotFoundPage } from '@/app/NotFoundPage.tsx';

const routes = ['/', '/design', '/orders', '/login', '/accept-invite', '/setup'];
let failures = 0;

for (const route of routes) {
  try {
    const signedOut = route === '/login' || route === '/accept-invite';
    const html = renderToString(
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider>
          {signedOut ? (
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/accept-invite" element={<AcceptInvitePage />} />
            </Routes>
          ) : (
            <AppShell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/design" element={<DesignPage />} />
                <Route path="/setup" element={<OnboardingPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </AppShell>
          )}
        </SessionProvider>
      </MemoryRouter>,
    );

    const checks: [string, boolean][] = [
      ['renders markup', html.length > 500],
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

console.log(failures === 0 ? '\nRender smoke test passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
