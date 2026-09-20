// DineFlow brand mark.
//
// The mark is a plate seen from above with a flow line through it: the plate says
// restaurant, the line says the order moving from table to kitchen to bill. It is
// drawn with currentColor so it inherits whatever surface it sits on, and it stays
// legible at 16px (favicon) because it is two shapes, not an illustration.

type LogoProps = {
  /** Height in pixels; the mark scales proportionally. */
  size?: number;
  className?: string;
};

export function LogoMark({ size = 28, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="DineFlow"
      className={className}
    >
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.5" />
      <path
        d="M9.5 19.5c2.2-3.4 4.4-5.1 6.5-5.1s4.3 1.7 6.5 5.1"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="9.5" r="2" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ size = 28, className }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark size={size} className="text-brand" />
      <span className="text-lg font-semibold tracking-tight text-text">
        Dine<span className="text-brand">Flow</span>
      </span>
    </span>
  );
}
