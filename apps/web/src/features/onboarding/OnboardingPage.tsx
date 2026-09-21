import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Check, Store, Receipt, Rocket } from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError, apiFetch } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';

type Restaurant = {
  id: string; slug: string; name: string; status: string; currency: string; timezone: string;
  address_line1: string | null; city: string | null; region: string | null; postal_code: string | null;
  country: string | null; phone: string | null; email: string | null;
  opening_hours_text: string | null; brand_color: string | null; version: number;
};
type Settings = {
  contact_policy: string; prices_include_tax: boolean; bill_footer: string | null;
  tax_registration_no: string | null; onboarding_completed_at: string | null;
};
type TaxComponent = { id: string; name: string; rate_bps: number; active: boolean };
type Payload = { restaurant: Restaurant; settings: Settings; taxComponents: TaxComponent[] };

const STEPS = [
  { id: 'profile', label: 'Your restaurant', icon: Store },
  { id: 'billing', label: 'Bills and tax', icon: Receipt },
  { id: 'golive', label: 'Go live', icon: Rocket },
] as const;
type StepId = (typeof STEPS)[number]['id'];

export function OnboardingPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [data, setData] = useState<Payload | null>(null);
  const [step, setStep] = useState<StepId>('profile');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<Payload>('/restaurant')
      .then(setData)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load your restaurant.'));
  }, []);

  const isLive = data?.restaurant.status === 'active';

  // The heading renders in every state, including loading and error. A page whose
  // only heading appears after a fetch is a page with no structure for anyone
  // navigating by headings.
  const header = (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-text">
        {isLive ? 'Your restaurant' : 'Set up your restaurant'}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {isLive
          ? 'These details appear on your customer menu and on every bill.'
          : 'Three short steps. Nothing is visible to customers until you go live.'}
      </p>
    </div>
  );

  if (error && !data) {
    return (
      <div className="mx-auto max-w-2xl">
        {header}
        <Card>
          <CardBody>
            <p role="alert" className="text-sm font-medium text-danger">{error}</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-2xl space-y-3" aria-busy="true">
        {header}
        <span className="sr-only">Loading your restaurant</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      {header}

      {/* A list, not a row of divs: the steps are an ordered sequence and one of
          them is current, which assistive technology should be able to say. */}
      <ol className="mb-6 flex gap-2" aria-label="Setup steps">
        {STEPS.map((item, index) => {
          const active = item.id === step;
          const done = isLive || STEPS.findIndex((s) => s.id === step) > index;
          return (
            <li key={item.id} className="flex-1">
              <button
                type="button"
                onClick={() => setStep(item.id)}
                aria-current={active ? 'step' : undefined}
                className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors ${
                  active ? 'border-brand bg-brand-subtle text-brand'
                  : done ? 'border-border bg-surface text-muted'
                  : 'border-border bg-surface text-muted hover:bg-surface-2'
                }`}
              >
                {done ? <Check className="size-4 shrink-0" aria-hidden="true" />
                      : <item.icon className="size-4 shrink-0" aria-hidden="true" />}
                <span className="truncate">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {error ? (
        <p role="alert" className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {step === 'profile' ? (
        <ProfileStep
          data={data}
          busy={busy}
          onSaved={(next) => { setData(next); setStep('billing'); setError(null); }}
          onError={setError}
          setBusy={setBusy}
        />
      ) : null}

      {step === 'billing' ? (
        <BillingStep
          data={data}
          busy={busy}
          onSaved={(next) => { setData(next); setStep('golive'); setError(null); }}
          onError={setError}
          setBusy={setBusy}
        />
      ) : null}

      {step === 'golive' ? (
        <GoLiveStep
          data={data}
          busy={busy}
          onLive={async (next) => {
            setData(next);
            await refresh();
            navigate('/', { replace: true });
          }}
          onError={setError}
          setBusy={setBusy}
        />
      ) : null}
    </div>
  );
}

type StepProps = {
  data: Payload;
  busy: boolean;
  onError: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
};

/** Reloads the whole payload after a write, so the version is never stale. */
async function reload(): Promise<Payload> {
  return apiFetch<Payload>('/restaurant');
}

function message(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.fields?.length) {
      return `${caught.message} (${caught.fields.map((f) => f.field).join(', ')})`;
    }
    return caught.message;
  }
  return 'Something went wrong. Please try again.';
}

function ProfileStep({ data, busy, onSaved, onError, setBusy }: StepProps & { onSaved: (p: Payload) => void }) {
  const r = data.restaurant;
  const [form, setForm] = useState({
    name: r.name, addressLine1: r.address_line1 ?? '', city: r.city ?? '',
    postalCode: r.postal_code ?? '', phone: r.phone ?? '', email: r.email ?? '',
    openingHoursText: r.opening_hours_text ?? '', brandColor: r.brand_color ?? '#1f6f5c',
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await apiFetch('/restaurant', { method: 'PATCH', body: { ...form, version: r.version } });
      onSaved(await reload());
    } catch (caught) {
      onError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <Card>
      <CardHeader title="Your restaurant" description="Shown on your menu and printed on every bill." />
      <CardBody>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Restaurant name" required>
            {({ id }) => <Input id={id} required value={form.name} onChange={set('name')} autoFocus />}
          </Field>
          <Field label="Street address" required hint="Required before you can go live.">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} required value={form.addressLine1} onChange={set('addressLine1')} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="City" required>
              {({ id }) => <Input id={id} required value={form.city} onChange={set('city')} />}
            </Field>
            <Field label="Postcode">
              {({ id }) => <Input id={id} value={form.postalCode} onChange={set('postalCode')} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" required hint="A phone number or an email is required.">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} type="tel" value={form.phone} onChange={set('phone')} />
              )}
            </Field>
            <Field label="Email">
              {({ id }) => <Input id={id} type="email" value={form.email} onChange={set('email')} />}
            </Field>
          </div>
          <Field label="Opening hours" hint="Free text, shown to customers. For example: Mon–Sat, 11am–11pm.">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={form.openingHoursText} onChange={set('openingHoursText')} />
            )}
          </Field>
          <Field label="Accent colour" hint="Used on your customer menu. Text contrast is checked for you.">
            {({ id, describedBy }) => (
              <div className="flex items-center gap-3">
                <input
                  id={id}
                  aria-describedby={describedBy}
                  type="color"
                  value={form.brandColor}
                  onChange={set('brandColor')}
                  className="h-11 w-16 cursor-pointer rounded-md border border-border-strong bg-surface p-1"
                />
                <span className="tabular text-sm text-muted">{form.brandColor}</span>
              </div>
            )}
          </Field>

          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
            Save and continue
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function BillingStep({ data, busy, onSaved, onError, setBusy }: StepProps & { onSaved: (p: Payload) => void }) {
  const [pricesIncludeTax, setPricesIncludeTax] = useState(data.settings.prices_include_tax);
  const [taxRegistrationNo, setTaxRegistrationNo] = useState(data.settings.tax_registration_no ?? '');
  const [billFooter, setBillFooter] = useState(data.settings.bill_footer ?? '');
  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await apiFetch('/restaurant/settings', {
        method: 'PATCH',
        body: { pricesIncludeTax, taxRegistrationNo, billFooter },
      });
      if (taxName.trim() && taxRate.trim()) {
        // Rates are entered as a percentage and stored in basis points, so 5.5%
        // is exactly 550 and never a rounded float.
        const rateBps = Math.round(Number(taxRate) * 100);
        await apiFetch('/restaurant/tax-components', {
          method: 'POST', body: { name: taxName.trim(), rateBps },
        });
      }
      onSaved(await reload());
    } catch (caught) {
      onError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Bills and tax" description="You can change all of this later." />
      <CardBody>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">Do your menu prices include tax?</legend>
            {[
              { value: true, label: 'Yes — the price on the menu is what the customer pays' },
              { value: false, label: 'No — tax is added at the bill' },
            ].map((option) => (
              <label key={String(option.value)} className="flex items-start gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="pricesIncludeTax"
                  className="mt-1"
                  checked={pricesIncludeTax === option.value}
                  onChange={() => setPricesIncludeTax(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>

          <Field label="Tax registration number" hint="Printed on bills, if your bills need one.">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={taxRegistrationNo}
                onChange={(event) => setTaxRegistrationNo(event.target.value)} />
            )}
          </Field>

          {data.taxComponents.length > 0 ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-sm">
              <p className="mb-2 font-medium text-text">Taxes already set up</p>
              <ul className="space-y-1">
                {data.taxComponents.map((tax) => (
                  <li key={tax.id} className="flex justify-between text-muted">
                    <span>{tax.name}</span>
                    <span className="tabular">{(tax.rate_bps / 100).toFixed(2)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="Add a tax" hint="For example GST. Leave blank if you do not charge tax.">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={taxName}
                  onChange={(event) => setTaxName(event.target.value)} placeholder="GST" />
              )}
            </Field>
            <Field label="Rate %">
              {({ id }) => (
                <Input id={id} inputMode="decimal" value={taxRate} className="w-28 tabular"
                  onChange={(event) => setTaxRate(event.target.value)} placeholder="5" />
              )}
            </Field>
          </div>

          <Field label="Bill footer" hint="A short line at the bottom of every bill.">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={billFooter}
                onChange={(event) => setBillFooter(event.target.value)} placeholder="Thank you for dining with us" />
            )}
          </Field>

          <p className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
            Tax rates and what must appear on a bill are your responsibility and differ by place.
            Check these with your accountant before you start billing customers.
          </p>

          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
            Save and continue
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function GoLiveStep({ data, busy, onLive, onError, setBusy }: StepProps & { onLive: (p: Payload) => Promise<void> }) {
  const r = data.restaurant;
  const ready = Boolean(r.address_line1 && r.city && (r.phone || r.email));
  const isLive = r.status === 'active';

  async function goLive() {
    setBusy(true);
    onError(null);
    try {
      await apiFetch('/restaurant/onboarding/complete', { method: 'POST' });
      await onLive(await reload());
    } catch (caught) {
      onError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Go live" description="Turns on your restaurant. You can pause ordering at any time." />
      <CardBody className="space-y-4">
        <ul className="space-y-2 text-sm">
          <Item done label="Restaurant name" detail={r.name} />
          <Item done={Boolean(r.address_line1 && r.city)} label="Address"
            detail={[r.address_line1, r.city].filter(Boolean).join(', ') || 'Not added yet'} />
          <Item done={Boolean(r.phone || r.email)} label="Contact"
            detail={r.phone || r.email || 'Not added yet'} />
          <Item done={data.taxComponents.length > 0} label="Tax"
            detail={data.taxComponents.length > 0
              ? data.taxComponents.map((t) => `${t.name} ${(t.rate_bps / 100).toFixed(2)}%`).join(', ')
              : 'None set up — bills will show no tax'} optional />
        </ul>

        {/* Tables and the menu are the next modules. Saying so beats a checklist
            item that looks broken because the screen behind it does not exist. */}
        <div className="rounded-md border border-border bg-surface-2 p-3 text-sm text-muted">
          <p className="font-medium text-text">Still to come</p>
          <p className="mt-1">
            Tables, QR codes and your menu are built in the next modules. Going live now sets up your
            restaurant; customers cannot order until those exist.
          </p>
        </div>

        {isLive ? (
          <p className="rounded-md bg-success-bg px-3 py-2 text-sm font-medium text-success">
            Your restaurant is live.
          </p>
        ) : (
          <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!ready} onClick={goLive}>
            Go live
          </Button>
        )}
        {!ready && !isLive ? (
          <p className="text-xs text-muted">Add your address and a contact number first.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Item({ done, label, detail, optional }: { done: boolean; label: string; detail: ReactNode; optional?: boolean }) {
  return (
    <li className="flex items-start justify-between gap-3">
      <span className="flex items-start gap-2">
        <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ${
          done ? 'bg-success text-inverse' : 'bg-surface-2 text-muted'}`}>
          {done ? <Check className="size-3" aria-hidden="true" /> : null}
        </span>
        <span>
          <span className="font-medium text-text">{label}</span>
          <span className="block text-muted">{detail}</span>
        </span>
      </span>
      {optional && !done ? <Badge>Optional</Badge> : null}
    </li>
  );
}
