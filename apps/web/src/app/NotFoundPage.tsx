import { useLocation } from 'react-router';
import { Page } from '@/app/AppShell.tsx';
import { Card, EmptyState, Button } from '@/components/ui/index.ts';

/**
 * Also stands in for the sections whose modules are not built yet: saying so plainly
 * is better than a half-working screen that looks finished.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <Page title="Not available yet">
      <Card>
        <EmptyState
          title={`Nothing is built at ${pathname}`}
          description="This section is part of the planned product but its module has not been implemented. The dashboard and the design system are the two screens that exist today."
          action={
            <Button variant="primary" onClick={() => { window.location.href = '/'; }}>
              Back to dashboard
            </Button>
          }
        />
      </Card>
    </Page>
  );
}
