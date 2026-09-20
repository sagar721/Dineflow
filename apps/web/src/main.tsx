import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppShell } from '@/app/AppShell.tsx';
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx';
import { DesignPage } from '@/features/design/DesignPage.tsx';
import { NotFoundPage } from '@/app/NotFoundPage.tsx';
import { LoginPage } from '@/features/auth/LoginPage.tsx';
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage.tsx';
import { RequireAuth } from '@/features/auth/RequireAuth.tsx';
import { SessionProvider } from '@/features/auth/SessionProvider.tsx';
import '@/styles/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          {/* Signed-out routes render without the app shell: someone who cannot
              sign in has no navigation to use. */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />

          <Route
            path="*"
            element={
              <AppShell>
                <Routes>
                  <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
                  <Route path="/design" element={<DesignPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </AppShell>
            }
          />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
