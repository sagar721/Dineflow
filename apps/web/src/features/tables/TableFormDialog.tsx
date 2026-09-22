import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { tablesApi, type DiningTable } from './api.ts';

type Props = {
  open: boolean;
  /** The table to edit, or null to create one. */
  table: DiningTable | null;
  onClose: () => void;
  onSaved: (table: DiningTable) => void;
};

type Errors = Partial<Record<'tableNumber' | 'name' | 'notes' | 'capacity' | 'form', string>>;

/**
 * Create or edit a table. The checks here mirror the server's so people get
 * immediate feedback; the server's answer is still the one that counts.
 */
export function TableFormDialog({ open, table, onClose, onSaved }: Props) {
  const [tableNumber, setTableNumber] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [capacity, setCapacity] = useState('4');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTableNumber(table?.tableNumber ?? '');
    setName(table?.name ?? '');
    setNotes(table?.notes ?? '');
    setCapacity(String(table?.capacity ?? 4));
    setErrors({});
  }, [open, table]);

  function validate(): Errors {
    const next: Errors = {};
    const number = tableNumber.trim();
    if (!number) next.tableNumber = 'Enter a table number.';
    else if (number.length > 20) next.tableNumber = 'Use 20 characters or fewer.';
    if (name.trim().length > 60) next.name = 'Use 60 characters or fewer.';
    if (notes.trim().length > 500) next.notes = 'Use 500 characters or fewer.';
    const seats = Number(capacity);
    if (!/^\d+$/.test(capacity.trim()) || seats < 1 || seats > 100) next.capacity = 'Enter a whole number from 1 to 100.';
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    const input = {
      tableNumber: tableNumber.trim(), name: name.trim() || null, notes: notes.trim() || null, capacity: Number(capacity),
    };
    try {
      const result = table
        ? await tablesApi.update(table.id, { ...input, version: table.version })
        : await tablesApi.create(input);
      onSaved(result.table);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'TABLE_NUMBER_TAKEN') {
        setErrors({ tableNumber: caught.message });
      } else if (caught instanceof ApiError) {
        setErrors({ form: caught.message });
      } else {
        setErrors({ form: 'Something went wrong. Please try again.' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={table ? `Edit table ${table.tableNumber}` : 'Add a table'}
      description={table ? undefined : 'You can generate its QR code once it is saved.'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="table-form" variant="primary" loading={busy}>
            {table ? 'Save changes' : 'Add table'}
          </Button>
        </>
      }
    >
      <form id="table-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form ? (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{errors.form}</p>
        ) : null}

        <Field label="Table number" required hint="What staff and customers call it, such as 12 or T4." error={errors.tableNumber}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} autoFocus maxLength={20}
              value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} />
          )}
        </Field>

        <Field label="Name" hint="Optional, such as Window or Terrace." error={errors.name}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} maxLength={60}
              value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>

        <Field label="Seats" required error={errors.capacity}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric"
              className="w-28 tabular" value={capacity} onChange={(event) => setCapacity(event.target.value)} />
          )}
        </Field>

        <Field label="Notes" hint="Optional. For staff only; customers never see these." error={errors.notes}>
          {({ id, describedBy, invalid }) => (
            <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} maxLength={500} rows={3}
              className={`block w-full rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted ${
                invalid ? 'border-danger' : 'border-border-strong'}`}
              value={notes} onChange={(event) => setNotes(event.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
