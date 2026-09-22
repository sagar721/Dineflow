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
import { OnboardingPage } from '@/features/onboarding/OnboardingPage.tsx';
import { TablesPage } from '@/features/tables/TablesPage.tsx';
import { QrSheetPage } from '@/features/tables/QrSheetPage.tsx';
import { MenuPage } from '@/features/menu/MenuPage.tsx';
import { OrderStatusPage } from '@/features/order/OrderStatusPage.tsx';
import { OrdersPage } from '@/features/orders/OrdersPage.tsx';
import { KitchenPage } from '@/features/orders/KitchenPage.tsx';
import { TableEntryPage } from '@/features/public/TableEntryPage.tsx';
import { SecurityPage } from '@/features/auth/SecurityPage.tsx';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage.tsx';
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
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* What a customer's phone opens after scanning a table's QR code. No
              session, no app shell: a customer is not a member of staff. */}
          <Route path="/t/:token" element={<TableEntryPage />} />
          {/* A customer's order, by its unguessable status link (FR-042). */}
          <Route path="/o/:statusToken" element={<OrderStatusPage />} />
          {/* Outside the shell so that printing gives only the cards. */}
          <Route
            path="/tables/qr-sheet"
            element={<RequireAuth permission="qr.read"><QrSheetPage /></RequireAuth>}
          />

          <Route
            path="*"
            element={
              <AppShell>
                <Routes>
                  <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
                  <Route path="/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />
                  <Route
                    path="/tables"
                    element={<RequireAuth permission="table.read"><TablesPage /></RequireAuth>}
                  />
                  <Route path="/orders" element={<RequireAuth permission="order.read"><OrdersPage /></RequireAuth>} />
                  <Route path="/kitchen" element={<RequireAuth permission="order.read"><KitchenPage /></RequireAuth>} />
                  <Route
                    path="/menu"
                    element={<RequireAuth permission="menu.read"><MenuPage /></RequireAuth>}
                  />
                  <Route
                    path="/setup"
                    element={
                      <RequireAuth permission="restaurant.settings.update">
                        <OnboardingPage />
                      </RequireAuth>
                    }
                  />
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
