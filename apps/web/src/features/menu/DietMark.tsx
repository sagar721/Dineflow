import type { Diet } from './api.ts';

const LABEL: Record<Exclude<Diet, 'none'>, string> = { veg: 'Vegetarian', non_veg: 'Non-vegetarian', egg: 'Contains egg' };
const COLOR: Record<Exclude<Diet, 'none'>, string> = { veg: '#17863a', non_veg: '#b3261e', egg: '#b8860b' };

/**
 * The familiar square food mark: a dot for vegetarian, a triangle otherwise. Shape
 * as well as colour, so it reads for colour-blind customers, and named for screen
 * readers. Nothing is shown when the restaurant has not said.
 */
export function DietMark({ diet, className }: { diet: Diet; className?: string }) {
  if (diet === 'none') return null;
  const color = COLOR[diet];
  return (
    <span role="img" aria-label={LABEL[diet]} title={LABEL[diet]} className={className}>
      <svg viewBox="0 0 16 16" className="inline-block size-4 align-[-2px]" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke={color} strokeWidth="1.6" />
        {diet === 'veg'
          ? <circle cx="8" cy="8" r="3.6" fill={color} />
          : <path d="M8 4 L12.2 11.5 H3.8 Z" fill={color} />}
      </svg>
    </span>
  );
}
