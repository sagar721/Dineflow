import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { tablesApi } from './api.ts';

type Props = { open: boolean; onClose: () => void; onSaved: (created: number) => void };

type Errors = Partial<Record<'prefix' | 'from' | 'to' | 'capacity' | 'form', string>>;

const MAX = 100;
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value) : NaN);

/**
 * Adds a numbered range of tables at once (FR-018), such as T1 to T20. The server
 * creates all of them or none, so a clash never leaves half a range behind.
 */
export function BulkTablesDialog({ open, onClose, onSaved }: Props) {
  const [prefix, setPrefix] = useState('');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('10');
  const [capacity, setCapacity] = useState('4');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPrefix('');
    setFrom('1');
    setTo('10');
    setCapacity('4');
    setErrors({});
  }, [open]);

  const first = whole(from);
  const last = whole(to);
  const count = Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first + 1 : 0;
  const preview = count > 0
    ? count === 1 ? `${prefix.trim()}${first}` : `${prefix.trim()}${first} to ${prefix.trim()}${last}`
    : '';

  function validate(): Errors {
    const next: Errors = {};
    if (prefix.trim().length > 10) next.prefix = 'Use 10 characters or fewer.';
    if (!Number.isFinite(first) || first > 9999) next.from = 'Enter a whole number from 0 to 9999.';
    if (!Number.isFinite(last) || last > 9999) next.to = 'Enter a whole number from 0 to 9999.';
    else if (Number.isFinite(first) && last < first) next.to = 'Must not be less than the first number.';
    else if (count > MAX) next.to = `At most ${MAX} tables at a time.`;
    const seats = whole(capacity);
    if (!Number.isFinite(seats) || seats < 1 || seats > 100) next.capacity = 'Enter a whole number from 1 to 100.';
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const { tables } = await tablesApi.bulkCreate({
        prefix: prefix.trim(), from: first, to: last, capacity: Number(capacity),
      });
      onSaved(tables.length);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'TABLE_NUMBER_TAKEN') {
        const taken = caught.fields?.map((field) => field.message).join(', ');
        setErrors({ form: taken ? `Already in use: ${taken}. Nothing was added.` : caught.message });
      } else {
        setErrors({ form: caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add several tables"
      description="Creates a numbered range in one go. If any number is already used, nothing is added."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="bulk-tables-form" variant="primary" loading={busy} disabled={count === 0}>
            {count > 0 && count <= MAX ? `Add ${count} ${count === 1 ? 'table' : 'tables'}` : 'Add tables'}
          </Button>
        </>
      }
    >
      <form id="bulk-tables-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form ? (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{errors.form}</p>
        ) : null}

        <Field label="Prefix" hint="Optional, such as T or Patio. Leave empty for plain numbers." error={errors.prefix}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} autoFocus maxLength={10} className="w-40"
              value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          )}
        </Field>

        <div className="flex flex-wrap gap-4">
          <Field label="From" required error={errors.from}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric" className="w-28 tabular"
                value={from} onChange={(event) => setFrom(event.target.value)} />
            )}
          </Field>
          <Field label="To" required error={errors.to}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric" className="w-28 tabular"
                value={to} onChange={(event) => setTo(event.target.value)} />
            )}
          </Field>
          <Field label="Seats each" required error={errors.capacity}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric" className="w-28 tabular"
                value={capacity} onChange={(event) => setCapacity(event.target.value)} />
            )}
          </Field>
        </div>

        {preview ? (
          <p className="text-sm text-muted" role="status" aria-live="polite">
            Tables <span className="font-medium text-text tabular">{preview}</span>
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
