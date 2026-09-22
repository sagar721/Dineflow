import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { formatMoney, type DiscountType } from '@dineflow/shared';
import { Badge, Button, Dialog, Field, Input, Skeleton } from '@/components/ui/index.ts';
import { ApiError } from '@/lib/api.ts';
import { useSession } from '@/features/auth/SessionProvider.tsx';
import { billingApi, type Bill, type PaymentMethod } from './api.ts';
import { BillDocument } from './BillDocument.tsx';
import { billActions, billState, parseDiscount, PAYMENT_METHOD_LABEL, previewDiscount, type BillAction } from './logic.ts';

type Props = { billId: string | null; timezone: string; onClose: () => void; onChanged: () => void };

const selectClass = 'h-11 rounded-md border border-border-strong bg-surface px-3 text-sm text-text';
const textareaClass = 'block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text';

/**
 * One bill, and what this role may do with it now: discount a draft (owner and
 * manager), finalize or discard it, record or reverse the payment, or void it
 * (FR-075 … FR-081). The server re-checks every step.
 */
export function BillDialog({ billId, timezone, onClose, onChanged }: Props) {
  const { state: session } = useSession();
  const role = session.status === 'signed-in' ? session.session.role : null;
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<BillAction | null>(null);
  const [open, setOpen] = useState<BillAction | null>(null);
  const [reason, setReason] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('percent');
  const [discountText, setDiscountText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (!billId) return;
    setBill(null); setError(null); setNotice(null); setOpen(null);
    billingApi.detail(billId)
      .then(({ bill: loaded }) => setBill(loaded))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load this bill.'));
  }, [billId]);

  async function run(action: BillAction, change: () => Promise<{ bill: Bill } | void>) {
    if (!bill) return;
    setBusy(action); setError(null); setNotice(null);
    try {
      const result = await change();
      if (result) setBill(result.bill);
      setOpen(null); setReason('');
      onChanged();
      if (!result) onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'STALE_VERSION') {
        setBill((await billingApi.detail(bill.id)).bill);
        setNotice(caught.message);
        onChanged();
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(null);
    }
  }

  const needReason = (text: string) => {
    if (text.trim().length >= 3) return true;
    setError('Give a reason of at least 3 characters.');
    return false;
  };

  const actions = bill && role ? billActions(role, bill) : [];
  const livePayment = bill?.payments.find((p) => !p.reversedAt) ?? null;
  const parsedDiscount = bill && discountText ? parseDiscount({ type: discountType, text: discountText }, bill.currency) : null;
  let preview: ReturnType<typeof previewDiscount> | null = null;
  if (bill && parsedDiscount && 'value' in parsedDiscount) {
    try { preview = previewDiscount(bill, { type: discountType, value: parsedDiscount.value }); } catch { preview = null; }
  }

  const title = bill ? (bill.ref ? `Bill ${bill.ref}` : 'Draft bill') : 'Bill';
  return (
    <Dialog open={billId !== null} onClose={onClose} title={title} footer={<Button onClick={onClose}>Close</Button>}>
      {!bill && !error ? (
        <div aria-busy="true" className="space-y-2"><span className="sr-only">Loading the bill</span>
          <Skeleton className="h-6 w-1/2" /><Skeleton className="h-40 w-full" /></div>
      ) : null}
      {error ? <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm font-medium text-danger">{error}</p> : null}
      {notice ? <p role="status" className="mb-3 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">{notice}</p> : null}

      {bill ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2"><Badge tone={billState(bill).tone}>{billState(bill).label}</Badge>
            {bill.finalizedBy ? <span className="text-xs text-muted">Finalized by {bill.finalizedBy}</span> : null}</div>
          <BillDocument bill={bill} timezone={timezone} />

          {bill.payments.length ? (
            <section aria-labelledby="bill-payments" className="text-sm">
              <h3 id="bill-payments" className="font-medium text-text">Payments</h3>
              <ul className="mt-1 space-y-1 text-muted">
                {bill.payments.map((p) => (
                  <li key={p.id} className={p.reversedAt ? 'line-through' : ''}>
                    {PAYMENT_METHOD_LABEL[p.method]} {formatMoney(p.amountMinor, bill.currency)}
                    {p.reference ? ` · ${p.reference}` : ''}{p.recordedBy ? ` · by ${p.recordedBy}` : ''}
                    {p.reversedAt ? <span className="no-underline"> — reversed{p.reversalReason ? `: ${p.reversalReason}` : ''}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* An issued bill can always be printed or downloaded, even by a role with
              no actions left on it (a paid bill, for billing staff). */}
          {bill.status !== 'draft' ? (
            <Link className="inline-flex h-9 items-center rounded-md border border-border-strong px-3 text-sm font-medium text-text hover:bg-surface-2"
              to={`/billing/${bill.id}/print`}>Print or PDF</Link>
          ) : null}

          {actions.length ? (
            <section aria-labelledby="bill-actions" className="space-y-3 border-t border-border pt-4">
              <h3 id="bill-actions" className="sr-only">Actions</h3>
              <div className="flex flex-wrap gap-2">
                {actions.includes('finalize') ? (
                  <Button size="sm" variant="primary" loading={busy === 'finalize'}
                    onClick={() => void run('finalize', () => billingApi.finalize(bill.id, bill.version))}>Finalize bill</Button>
                ) : null}
                {actions.includes('pay') ? <Button size="sm" variant="primary" onClick={() => setOpen('pay')}>Record payment</Button> : null}
                {actions.includes('discount') ? <Button size="sm" onClick={() => setOpen('discount')}>Discount</Button> : null}
                {actions.includes('discard') ? <Button size="sm" onClick={() => setOpen('discard')}>Discard draft</Button> : null}
                {actions.includes('reverse') ? <Button size="sm" variant="danger" onClick={() => setOpen('reverse')}>Reverse payment</Button> : null}
                {actions.includes('void') ? <Button size="sm" variant="danger" onClick={() => setOpen('void')}>Void bill</Button> : null}
              </div>

              {open === 'discount' ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Type">{({ id }) => (
                      <select id={id} className={selectClass} value={discountType}
                        onChange={(event) => setDiscountType(event.target.value as DiscountType)}>
                        <option value="percent">Percent</option><option value="fixed">Amount</option>
                      </select>)}</Field>
                    <Field label={discountType === 'percent' ? 'Percent off' : 'Amount off'}>{({ id }) => (
                      <Input id={id} inputMode="decimal" className="w-32" value={discountText}
                        onChange={(event) => setDiscountText(event.target.value)} />)}</Field>
                  </div>
                  {parsedDiscount && 'error' in parsedDiscount ? <p className="text-sm text-danger">{parsedDiscount.error}</p> : null}
                  {preview ? <p className="text-sm text-muted">New total <span className="font-semibold tabular text-text">
                    {formatMoney(preview.totalMinor, bill.currency)}</span></p> : null}
                  <Field label="Reason" required hint="Recorded on the bill and in the activity log.">{({ id, describedBy }) => (
                    <textarea id={id} aria-describedby={describedBy} rows={2} maxLength={200} className={textareaClass}
                      value={reason} onChange={(event) => setReason(event.target.value)} />)}</Field>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" loading={busy === 'discount'} onClick={() => {
                      if (!parsedDiscount || !('value' in parsedDiscount)) { setError('Enter a valid discount.'); return; }
                      if (!needReason(reason)) return;
                      void run('discount', () => billingApi.discount(bill.id,
                        { type: discountType, value: parsedDiscount.value, reason: reason.trim() }, bill.version));
                    }}>Apply discount</Button>
                    {bill.discount ? <Button size="sm" loading={busy === 'discount'}
                      onClick={() => void run('discount', () => billingApi.discount(bill.id, { type: null }, bill.version))}>
                      Remove discount</Button> : null}
                    <Button size="sm" onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}

              {open === 'pay' ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-sm text-muted">Amount: <span className="font-semibold tabular text-text">
                    {formatMoney(bill.totalMinor, bill.currency)}</span> (the bill total; partial payments are not supported)</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Method">{({ id }) => (
                      <select id={id} className={selectClass} value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                        {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                      </select>)}</Field>
                    <Field label="Reference (optional)">{({ id }) => (
                      <Input id={id} maxLength={80} value={reference} onChange={(event) => setReference(event.target.value)} />)}</Field>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" loading={busy === 'pay'}
                      onClick={() => void run('pay', () => billingApi.pay(bill.id, method, bill.totalMinor, reference.trim() || undefined))}>
                      Mark as paid</Button>
                    <Button size="sm" onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}

              {open === 'discard' ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-sm text-text">Discard this draft? Its orders can be billed again. No bill number is used.</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" loading={busy === 'discard'}
                      onClick={() => void run('discard', () => billingApi.discard(bill.id))}>Discard draft</Button>
                    <Button size="sm" onClick={() => setOpen(null)}>Keep it</Button>
                  </div>
                </div>
              ) : null}

              {open === 'void' || open === 'reverse' ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <Field label={open === 'void' ? 'Why is this bill being voided?' : 'Why is this payment being reversed?'} required
                    hint={open === 'void' ? 'The bill keeps its number and is shown as VOID. Its orders can then be billed again.'
                      : 'The payment stays on record, marked reversed.'}>
                    {({ id, describedBy }) => (
                      <textarea id={id} aria-describedby={describedBy} rows={2} maxLength={300} className={textareaClass}
                        value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />)}
                  </Field>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" loading={busy === open} onClick={() => {
                      if (!needReason(reason)) return;
                      if (open === 'void') void run('void', () => billingApi.void(bill.id, reason.trim(), bill.version));
                      else if (livePayment) void run('reverse', () => billingApi.reverse(livePayment.id, reason.trim()));
                    }}>{open === 'void' ? 'Void bill' : 'Reverse payment'}</Button>
                    <Button size="sm" onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
