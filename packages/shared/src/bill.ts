// Bill arithmetic (PRD FR-073, FR-075, FR-082, BR-BILL-04/05; design/01 §4.2).
//
// One implementation, in integer minor units (paise) with half-up rounding, used by
// the API to compute every bill. The database re-checks the stored result at
// finalization, so a bug here cannot silently produce an inconsistent bill.
import { roundHalfUp } from './money.ts';

export type RoundingMode = 'none' | 'nearest_50' | 'nearest_1';
export type DiscountType = 'percent' | 'fixed';

export type BillInput = {
  lines: readonly { unitPriceMinor: number; quantity: number }[];
  /** Prices on the menu already include tax (inclusive) or not (exclusive). */
  pricesIncludeTax: boolean;
  /** Active tax components, in display order. Rates in basis points (500 = 5 %). */
  taxes: readonly { name: string; rateBps: number }[];
  serviceChargeBps: number;
  /** Percent: value in basis points. Fixed: value in minor units. */
  discount: { type: DiscountType; value: number } | null;
  roundingMode: RoundingMode;
};

export type BillTotals = {
  subtotalMinor: number;
  discountMinor: number;
  /** Subtotal after discount: what service charge and tax are worked out on. */
  baseMinor: number;
  serviceChargeMinor: number;
  taxes: { name: string; rateBps: number; taxableMinor: number; amountMinor: number }[];
  taxTotalMinor: number;
  roundingMinor: number;
  totalMinor: number;
};

export class BillError extends Error {
  readonly code: 'DISCOUNT_TOO_LARGE' | 'INVALID_INPUT';
  constructor(code: BillError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const isWhole = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min;

/** Rounds to the nearest `step` minor units, half up. Integer maths only. */
function roundTo(value: number, step: number): number {
  return Math.floor((value + step / 2) / step) * step;
}

/**
 * Works out a bill.
 *
 * - Discount: a percentage of the subtotal (half-up) or a fixed amount; never more
 *   than the subtotal (BR-BILL-05).
 * - Service charge: on the post-discount base, and not taxed (approved design).
 * - Exclusive prices: each tax is its rate applied to the base, added on top.
 * - Inclusive prices: the combined rate is extracted from the base once, split
 *   across components by rate, with any paise remainder on the last component, so
 *   taxable amount + taxes = base exactly. The total does not change.
 * - Rounding: the configured step, shown as its own (possibly negative) line.
 */
export function computeBill(input: BillInput): BillTotals {
  for (const line of input.lines) {
    if (!isWhole(line.unitPriceMinor) || !isWhole(line.quantity, 1)) {
      throw new BillError('INVALID_INPUT', 'Line prices and quantities must be whole, non-negative numbers.');
    }
  }
  for (const tax of input.taxes) {
    if (!isWhole(tax.rateBps) || tax.rateBps > 10_000) throw new BillError('INVALID_INPUT', 'Tax rates must be 0–100 %.');
  }
  if (!isWhole(input.serviceChargeBps) || input.serviceChargeBps > 10_000) {
    throw new BillError('INVALID_INPUT', 'The service charge must be 0–100 %.');
  }

  const subtotalMinor = input.lines.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
  if (!Number.isSafeInteger(subtotalMinor)) throw new BillError('INVALID_INPUT', 'The bill is too large.');

  let discountMinor = 0;
  if (input.discount) {
    const { type, value } = input.discount;
    if (!isWhole(value)) throw new BillError('INVALID_INPUT', 'The discount must be a whole, non-negative number.');
    if (type === 'percent') {
      if (value > 10_000) throw new BillError('DISCOUNT_TOO_LARGE', 'A discount cannot be more than 100 %.');
      discountMinor = roundHalfUp((subtotalMinor * value) / 10_000);
    } else {
      discountMinor = value;
    }
    if (discountMinor > subtotalMinor) {
      throw new BillError('DISCOUNT_TOO_LARGE', 'The discount cannot be more than the bill subtotal.');
    }
  }

  const baseMinor = subtotalMinor - discountMinor;
  const serviceChargeMinor = roundHalfUp((baseMinor * input.serviceChargeBps) / 10_000);

  let taxes: BillTotals['taxes'];
  if (!input.pricesIncludeTax) {
    taxes = input.taxes.map((tax) => ({
      name: tax.name, rateBps: tax.rateBps, taxableMinor: baseMinor,
      amountMinor: roundHalfUp((baseMinor * tax.rateBps) / 10_000),
    }));
  } else {
    const combined = input.taxes.reduce((total, tax) => total + tax.rateBps, 0);
    const taxableMinor = combined === 0 ? baseMinor : roundHalfUp((baseMinor * 10_000) / (10_000 + combined));
    const extracted = baseMinor - taxableMinor;
    let allotted = 0;
    taxes = input.taxes.map((tax, index) => {
      const last = index === input.taxes.length - 1;
      const amountMinor = last ? extracted - allotted : roundHalfUp((extracted * tax.rateBps) / (combined || 1));
      allotted += amountMinor;
      return { name: tax.name, rateBps: tax.rateBps, taxableMinor, amountMinor };
    });
  }
  const taxTotalMinor = taxes.reduce((total, tax) => total + tax.amountMinor, 0);

  const preRound = baseMinor + serviceChargeMinor + (input.pricesIncludeTax ? 0 : taxTotalMinor);
  const rounded = input.roundingMode === 'nearest_50' ? roundTo(preRound, 50)
    : input.roundingMode === 'nearest_1' ? roundTo(preRound, 100)
    : preRound;

  return {
    subtotalMinor, discountMinor, baseMinor, serviceChargeMinor, taxes, taxTotalMinor,
    roundingMinor: rounded - preRound, totalMinor: rounded,
  };
}

/** The identity the database re-checks at finalization. */
export function billIdentityHolds(t: Pick<BillTotals, 'subtotalMinor' | 'discountMinor' | 'serviceChargeMinor'
  | 'taxTotalMinor' | 'roundingMinor' | 'totalMinor'>, pricesIncludeTax: boolean): boolean {
  return t.totalMinor === t.subtotalMinor - t.discountMinor + t.serviceChargeMinor
    + (pricesIncludeTax ? 0 : t.taxTotalMinor) + t.roundingMinor;
}

// ------------------------------------------------------------- content hash
/**
 * The canonical text of a finalized bill (Stage-2 condition 5.2). Its SHA-256 is
 * stored on the bill and recorded in the billing ledger, so a paper or PDF copy —
 * and every row behind it — can be checked later. Key order is fixed by
 * construction; timestamps are deliberately left out (the ledger holds them).
 */
export type CanonicalBill = {
  restaurantId: string; billNo: number; billRef: string; series: string; currency: string;
  pricesIncludeTax: boolean; issuer: Record<string, unknown>; tableNumber: string; orderRefs: string[];
  lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  taxes: { name: string; rateBps: number; taxableMinor: number; amountMinor: number }[];
  subtotalMinor: number; discountType: DiscountType | null; discountValue: number | null; discountMinor: number;
  discountReason: string | null; serviceChargeBps: number; serviceChargeMinor: number; taxTotalMinor: number;
  roundingMode: RoundingMode; roundingMinor: number; totalMinor: number;
};

const sortedObject = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key] ?? null]));

export function canonicalBillText(bill: CanonicalBill): string {
  return JSON.stringify({
    v: 1,
    restaurantId: bill.restaurantId, series: bill.series, billNo: bill.billNo, billRef: bill.billRef,
    currency: bill.currency, pricesIncludeTax: bill.pricesIncludeTax, issuer: sortedObject(bill.issuer),
    tableNumber: bill.tableNumber, orderRefs: [...bill.orderRefs].sort(),
    lines: bill.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })),
    taxes: bill.taxes.map((t) => ({ name: t.name, rateBps: t.rateBps, taxableMinor: t.taxableMinor, amountMinor: t.amountMinor })),
    subtotalMinor: bill.subtotalMinor, discountType: bill.discountType, discountValue: bill.discountValue,
    discountMinor: bill.discountMinor, discountReason: bill.discountReason, serviceChargeBps: bill.serviceChargeBps,
    serviceChargeMinor: bill.serviceChargeMinor, taxTotalMinor: bill.taxTotalMinor, roundingMode: bill.roundingMode,
    roundingMinor: bill.roundingMinor, totalMinor: bill.totalMinor,
  });
}
