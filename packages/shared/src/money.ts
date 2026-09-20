// Money, in one place, for both the web app and the API.
//
// Amounts are integer minor units (paise, cents) end to end — never floats, never
// `numeric` strings passed around as numbers (D-07). v1 supports two-decimal
// currencies only; anything else must be added deliberately, with tests.

export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'SGD';

/** Minor units per major unit. Kept explicit so a new currency is a conscious change. */
const MINOR_UNITS: Record<Currency, number> = {
  INR: 100, USD: 100, EUR: 100, GBP: 100, AED: 100, SGD: 100,
};

export class MoneyError extends Error {}

function assertSafe(minor: number): void {
  if (!Number.isInteger(minor)) throw new MoneyError(`amount must be an integer in minor units, got ${minor}`);
  if (!Number.isSafeInteger(minor)) throw new MoneyError('amount exceeds the safe integer range');
}

/** Formats minor units for display, e.g. 24950 → "₹249.50". */
export function formatMoney(minor: number, currency: Currency, locale = 'en-IN'): string {
  assertSafe(minor);
  const divisor = MINOR_UNITS[currency];
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / divisor);
}

/** Parses typed input ("249.5", "1,249.50") into minor units. */
export function parseMoney(input: string, currency: Currency): number {
  const cleaned = input.replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) throw new MoneyError(`"${input}" is not a valid amount`);
  const [whole, fraction = ''] = cleaned.split('.');
  const sign = whole!.startsWith('-') ? -1 : 1;
  const digits = MINOR_UNITS[currency].toString().length - 1;
  const padded = fraction.padEnd(digits, '0');
  return sign * (Math.abs(Number(whole)) * MINOR_UNITS[currency] + Number(padded || 0));
}

/** Half-up rounding on minor units — the rule the bill and the database both use. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Applies a rate in basis points (500 = 5.00 %) to a minor-unit amount. */
export function applyBps(minor: number, bps: number): number {
  assertSafe(minor);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new MoneyError(`rate out of range: ${bps}`);
  return roundHalfUp((minor * bps) / 10_000);
}

export function sumMinor(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => {
    assertSafe(amount);
    return total + amount;
  }, 0);
}
