// The rules behind the billing screens, as pure functions so they can be unit
// tested. The server decides every one of them again; these only shape the UI.
import { computeBill, MoneyError, parseMoney, type Currency, type DiscountType, type StaffRole } from '@dineflow/shared';
import type { Bill, BillStatus, PaymentMethod } from './api.ts';

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', other: 'Other' };

/** One label and tone for a bill's state, e.g. "Paid", "Unpaid", "Draft", "Void". */
export function billState(bill: { status: BillStatus; paymentStatus: 'paid' | 'unpaid' | null }):
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  if (bill.status === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (bill.status === 'void') return { label: 'Void', tone: 'danger' };
  return bill.paymentStatus === 'paid' ? { label: 'Paid', tone: 'success' } : { label: 'Unpaid', tone: 'warning' };
}

export type BillAction = 'discount' | 'finalize' | 'discard' | 'pay' | 'reverse' | 'void';

/** What this role may do to this bill now (PRD §8 permissions, FR-075 … FR-081). */
export function billActions(role: StaffRole, bill: Pick<Bill, 'status' | 'paymentStatus'>): BillAction[] {
  const boss = role === 'owner' || role === 'manager';
  const biller = boss || role === 'billing';
  if (!biller) return [];
  if (bill.status === 'draft') return [...(boss ? ['discount' as const] : []), 'finalize', 'discard'];
  if (bill.status === 'void') return [];
  if (bill.paymentStatus === 'paid') return boss ? ['reverse'] : [];
  return ['pay', ...(boss ? ['void' as const] : [])];
}

export type DiscountInput = { type: DiscountType; text: string };

/**
 * Turns what was typed into the API's units: percent as basis points ("12.5" →
 * 1250), a fixed amount as minor units ("50" → 5000). Returns an error message
 * instead when the input is not usable.
 */
export function parseDiscount(input: DiscountInput, currency: Currency): { value: number } | { error: string } {
  const text = input.text.trim();
  if (!text) return { error: 'Enter a discount.' };
  if (input.type === 'percent') {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return { error: 'Enter a percentage such as 10 or 12.5.' };
    const [whole, fraction = ''] = text.split('.');
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (bps < 1 || bps > 10_000) return { error: 'A percentage must be more than 0 and at most 100.' };
    return { value: bps };
  }
  try {
    const minor = parseMoney(text, currency);
    if (minor < 1) return { error: 'Enter an amount above zero.' };
    return { value: minor };
  } catch (error) {
    if (error instanceof MoneyError) return { error: 'Enter an amount such as 50 or 49.50.' };
    throw error;
  }
}

/**
 * What the bill would total with this discount, worked out with the same shared
 * function the server uses, so the preview matches what will be saved.
 */
export function previewDiscount(bill: Bill, discount: { type: DiscountType; value: number } | null) {
  return computeBill({
    lines: bill.lines, pricesIncludeTax: bill.pricesIncludeTax, taxes: bill.taxes,
    serviceChargeBps: bill.serviceChargeBps, discount, roundingMode: bill.roundingMode,
  });
}

/** "5 %", "2.5 %": a rate in basis points for display. */
export const rateLabel = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')} %`;
