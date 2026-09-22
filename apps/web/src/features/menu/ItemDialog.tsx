import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Button, Dialog, Field, Input } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import {
  fileToBase64, IMAGE_TYPES, MAX_IMAGE_BYTES, menuApi, minorToInput,
  type Diet, type MenuCategory, type MenuItem,
} from './api.ts';

type Props = {
  open: boolean;
  /** The item to edit, or null to create one. */
  item: MenuItem | null;
  categories: MenuCategory[];
  /** Pre-selected category for a new item. */
  defaultCategoryId?: string;
  onClose: () => void;
  /** Saved from the form, or archived/restored: the dialog is done. */
  onSaved: (item: MenuItem) => void;
  /** The photo changed: refresh the list, keep the dialog open. */
  onChanged: (item: MenuItem) => void;
};

type Errors = Partial<Record<'name' | 'description' | 'price' | 'categoryId' | 'image' | 'form', string>>;

const DIETS: { value: Diet; label: string }[] = [
  { value: 'veg', label: 'Veg' }, { value: 'non_veg', label: 'Non-veg' },
  { value: 'egg', label: 'Egg' }, { value: 'none', label: 'Not stated' },
];

const selectClass = 'h-11 w-full rounded-md border bg-surface px-3 text-sm text-text';

/**
 * Create or edit a menu item (FR-021). Checks mirror the server's for quick
 * feedback; the server's answer is the one that counts. The image can be added
 * once the item exists, since it is stored against the item.
 */
export function ItemDialog({ open, item, categories, defaultCategoryId, onClose, onSaved, onChanged }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [diet, setDiet] = useState<Diet>('none');
  const [visible, setVisible] = useState(true);
  const [available, setAvailable] = useState(true);
  const [current, setCurrent] = useState<MenuItem | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'save' | 'image' | 'archive' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const liveCategories = categories.filter((category) => !category.archived);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setDescription(item?.description ?? '');
    setPrice(item ? minorToInput(item.priceMinor) : '');
    setCategoryId(item?.categoryId ?? defaultCategoryId ?? liveCategories[0]?.id ?? '');
    setDiet(item?.diet ?? 'none');
    setVisible(item?.visible ?? true);
    setAvailable(item?.available ?? true);
    setCurrent(item);
    setErrors({});
    // Reset only when the dialog opens, not when the category list refreshes.
  }, [open, item]);

  function validate(): Errors {
    const next: Errors = {};
    if (!name.trim()) next.name = 'Enter a name.';
    else if (name.trim().length > 120) next.name = 'Use 120 characters or fewer.';
    if (description.trim().length > 1000) next.description = 'Use 1,000 characters or fewer.';
    // Compared in whole paise, so no floating point is involved.
    const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(price.trim().replace(/,/g, ''));
    const paise = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
    if (!(paise >= 0 && paise <= 100_000_000)) next.price = 'Enter a price from 0 to 10,00,000, such as 249 or 249.50.';
    if (!categoryId) next.categoryId = 'Choose a category.';
    return next;
  }

  const apiErrors = (caught: unknown): Errors => {
    if (caught instanceof ApiError) {
      if (caught.code === 'ITEM_NAME_TAKEN') return { name: caught.message };
      const field = caught.fields?.[0];
      if (field && ['name', 'description', 'price', 'categoryId'].includes(field.field)) {
        return { [field.field]: field.message } as Errors;
      }
      return { form: caught.message };
    }
    return { form: 'Something went wrong. Please try again.' };
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy('save');
    const input = {
      categoryId, name: name.trim(), description: description.trim() || null,
      price: price.trim().replace(/,/g, ''), diet, visible, available,
    };
    try {
      const result = current
        ? await menuApi.updateItem(current.id, input, current.version)
        : await menuApi.createItem(input);
      onSaved(result.item);
    } catch (caught) {
      setErrors(apiErrors(caught));
    } finally {
      setBusy(null);
    }
  }

  async function chooseImage(file: File | undefined) {
    if (!file || !current) return;
    setErrors({});
    // Quick checks for a clear message; the server checks the actual bytes.
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setErrors({ image: 'Use a JPEG, PNG or WebP image.' });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setErrors({ image: 'Images must be 5 MB or smaller.' });
      return;
    }
    setBusy('image');
    try {
      const { item: updated } = await menuApi.uploadImage(current.id, file.type, await fileToBase64(file));
      setCurrent(updated);
      onChanged(updated);
    } catch (caught) {
      setErrors({ image: caught instanceof ApiError ? caught.message : 'Could not upload the image.' });
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeImage() {
    if (!current) return;
    setBusy('image');
    try {
      const { item: updated } = await menuApi.removeImage(current.id);
      setCurrent(updated);
      onChanged(updated);
    } catch (caught) {
      setErrors({ image: caught instanceof ApiError ? caught.message : 'Could not remove the image.' });
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchived() {
    if (!current) return;
    setBusy('archive');
    try {
      const { item: updated } = await menuApi.updateItem(current.id, { archived: !current.archived }, current.version);
      onSaved(updated);
    } catch (caught) {
      setErrors(apiErrors(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={current ? `Edit ${current.name}` : 'Add an item'}
      description={current ? undefined : 'You can add a photo once the item is saved.'}
      footer={
        <>
          {current ? (
            <Button variant="ghost" className="mr-auto" loading={busy === 'archive'} disabled={busy !== null && busy !== 'archive'}
              onClick={toggleArchived}>
              {current.archived ? 'Restore item' : 'Archive item'}
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={busy !== null}>Cancel</Button>
          <Button type="submit" form="menu-item-form" variant="primary" loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>
            {current ? 'Save changes' : 'Add item'}
          </Button>
        </>
      }
    >
      <form id="menu-item-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form ? (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{errors.form}</p>
        ) : null}
        {current?.archived ? (
          <p role="note" className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
            This item is archived: customers do not see it, and past orders keep their record of it.
          </p>
        ) : null}

        <Field label="Name" required error={errors.name}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} autoFocus maxLength={120}
              value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>

        <Field label="Description" hint="Optional. Shown to customers under the name." error={errors.description}>
          {({ id, describedBy, invalid }) => (
            <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} maxLength={1000} rows={3}
              className={`block w-full rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted ${
                invalid ? 'border-danger' : 'border-border-strong'}`}
              value={description} onChange={(event) => setDescription(event.target.value)} />
          )}
        </Field>

        <div className="flex flex-wrap gap-4">
          <Field label="Price" required hint="For example 249 or 249.50." error={errors.price}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="decimal" className="w-40 tabular"
                value={price} onChange={(event) => setPrice(event.target.value)} />
            )}
          </Field>
          <div className="min-w-48 flex-1">
            <Field label="Category" required error={errors.categoryId}>
              {({ id, describedBy, invalid }) => (
                <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
                  className={`${selectClass} ${invalid ? 'border-danger' : 'border-border-strong'}`}
                  value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  {liveCategories.length === 0 ? <option value="">Add a category first</option> : null}
                  {liveCategories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-text">Veg or non-veg</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DIETS.map((option) => (
              <label key={option.value}
                className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-border-strong px-3 text-sm text-text has-[:checked]:border-brand has-[:checked]:bg-brand-subtle">
                <input type="radio" name="diet" value={option.value} checked={diet === option.value}
                  onChange={() => setDiet(option.value)} />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
            <input type="checkbox" className="size-4" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
            Show on the menu
          </label>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
            <input type="checkbox" className="size-4" checked={available} onChange={(event) => setAvailable(event.target.checked)} />
            Available (untick when sold out)
          </label>
        </div>
      </form>

      {current ? (
        <section aria-labelledby="menu-item-photo" className="mt-5 border-t border-border pt-4">
          <h3 id="menu-item-photo" className="text-sm font-medium text-text">Photo</h3>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            {current.imageUrl ? (
              <img src={current.imageUrl} alt="" className="size-24 rounded-md border border-border object-cover" />
            ) : (
              <div className="grid size-24 place-items-center rounded-md border border-dashed border-border-strong text-xs text-muted">
                No photo
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} className="sr-only" tabIndex={-1}
                aria-hidden="true" onChange={(event) => void chooseImage(event.target.files?.[0])} />
              <Button size="sm" iconLeft={<ImagePlus className="size-4" />} loading={busy === 'image'}
                disabled={busy !== null && busy !== 'image'} onClick={() => fileInput.current?.click()}>
                {current.imageUrl ? 'Replace photo' : 'Upload photo'}
              </Button>
              {current.imageUrl ? (
                <Button size="sm" variant="ghost" iconLeft={<Trash2 className="size-4" />} disabled={busy !== null}
                  onClick={removeImage}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">JPEG, PNG or WebP, up to 5 MB. Photos are resized and their hidden details (such as location) are removed.</p>
          {errors.image ? <p role="alert" className="mt-2 text-sm font-medium text-danger">{errors.image}</p> : null}
        </section>
      ) : null}
    </Dialog>
  );
}
