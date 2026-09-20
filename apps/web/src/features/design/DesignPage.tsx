import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ORDER_STATUSES } from '@dineflow/shared';
import { Page } from '@/app/AppShell.tsx';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, IconButton,
  Input, LiveIndicator, MoneyText, OrderStatusChip, Skeleton,
} from '@/components/ui/index.ts';
import { LogoMark, Wordmark } from '@/brand/Logo.tsx';

/**
 * The living reference for the design system: every component in every state, on
 * one page. It is the target for accessibility and visual checks, and it is how a
 * reviewer sees the disabled, loading and error states that screenshots of happy
 * paths never show.
 */
export function DesignPage() {
  const [kitchen, setKitchen] = useState(false);

  return (
    <Page
      title="Design system"
      description="Every component, every state. Used for review and accessibility checks."
      actions={
        <Button onClick={() => setKitchen((value) => !value)}>
          {kitchen ? 'Light (admin)' : 'Dark (kitchen)'}
        </Button>
      }
    >
      <div data-theme={kitchen ? 'dark' : undefined} className="space-y-6 rounded-lg bg-bg p-4">
        <Section title="Brand">
          <div className="flex flex-wrap items-center gap-8">
            <Wordmark size={32} />
            <LogoMark size={40} className="text-brand" />
            <div className="flex items-center gap-2">
              <span className="grid size-10 place-items-center rounded-md bg-brand text-inverse">
                <LogoMark size={24} />
              </span>
              <span className="text-sm text-muted">App icon</span>
            </div>
          </div>
        </Section>

        <Section title="Colour">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {[
              ['Brand', 'bg-brand', 'text-inverse'],
              ['Surface', 'bg-surface border border-border', 'text-text'],
              ['Surface 2', 'bg-surface-2', 'text-text'],
              ['Success', 'bg-success', 'text-inverse'],
              ['Warning', 'bg-warning', 'text-inverse'],
              ['Danger', 'bg-danger', 'text-inverse'],
            ].map(([label, bg, fg]) => (
              <div key={label} className={`rounded-md p-3 text-xs font-medium ${bg} ${fg}`}>
                {label}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Typography">
          <div className="space-y-1">
            <p className="text-3xl font-semibold text-text">Spice Garden</p>
            <p className="text-xl font-semibold text-text">Order SG-1042</p>
            <p className="text-base text-text">Body text at the default size.</p>
            <p className="text-sm text-muted">Secondary text, used for hints and metadata.</p>
            <p className="tabular text-sm text-text">Tabular figures 0123456789 · ₹1,249.50</p>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="space-y-3">
            {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-2">
                <Button variant={variant} size="sm">Small</Button>
                <Button variant={variant}>Default</Button>
                <Button variant={variant} size="lg">Large</Button>
                <Button variant={variant} loading>Loading</Button>
                <Button variant={variant} disabled>Disabled</Button>
                <Button variant={variant} iconLeft={<Plus className="size-4" />}>With icon</Button>
              </div>
            ))}
            <div className="flex gap-2">
              <IconButton label="Add item" icon={<Plus className="size-4" />} />
              <IconButton label="Delete" variant="danger" icon={<Trash2 className="size-4" />} />
            </div>
          </div>
        </Section>

        <Section title="Order status">
          <div className="flex flex-wrap gap-2">
            {ORDER_STATUSES.map((status) => (
              <OrderStatusChip key={status} status={status} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['neutral', 'brand', 'success', 'warning', 'danger', 'info'] as const).map((tone) => (
              <Badge key={tone} tone={tone}>{tone}</Badge>
            ))}
          </div>
        </Section>

        <Section title="Connection state">
          <div className="flex flex-wrap gap-6">
            <LiveIndicator state="live" lastUpdated={new Date()} />
            <LiveIndicator state="reconnecting" />
            <LiveIndicator state="offline" lastUpdated={new Date(Date.now() - 6 * 60_000)} />
          </div>
        </Section>

        <Section title="Form fields">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Field label="Item name" required hint="Shown to customers on the menu">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} placeholder="Paneer Tikka" defaultValue="Paneer Tikka" />
              )}
            </Field>
            <Field label="Price" required error="Enter an amount of 0 or more">
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="-10" inputMode="decimal" />
              )}
            </Field>
            <Field label="Table label" hint="Must be unique within the restaurant">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} placeholder="12" />}
            </Field>
            <Field label="Restaurant slug">
              {({ id }) => <Input id={id} value="spice-garden" disabled readOnly />}
            </Field>
          </div>
        </Section>

        <Section title="Money">
          <div className="flex flex-wrap items-baseline gap-6">
            <MoneyText minor={0} />
            <MoneyText minor={24950} />
            <MoneyText minor={2148500} emphasis />
          </div>
          <p className="mt-2 text-xs text-muted">
            Rendered from integer minor units. There is no code path that formats money any other way.
          </p>
        </Section>

        <Section title="Loading and empty">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader title="Loading" />
              <CardBody className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </CardBody>
            </Card>
            <Card>
              <EmptyState
                title="No tables yet"
                description="Create your first table to generate a QR code for it."
                action={<Button variant="primary" iconLeft={<Plus className="size-4" />}>Add table</Button>}
              />
            </Card>
          </div>
        </Section>
      </div>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`section-${title}`}>
      <h2 id={`section-${title}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}
