import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks further clicks without changing the button's width. */
  loading?: boolean;
  iconLeft?: ReactNode;
};

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-inverse hover:bg-brand-hover disabled:bg-border-strong disabled:text-muted',
  secondary: 'bg-surface text-text border border-border hover:bg-surface-2 disabled:text-muted',
  ghost: 'bg-transparent text-text hover:bg-surface-2 disabled:text-muted',
  // Destructive actions look different from everything else, never adjacent to primary.
  danger: 'bg-danger text-inverse hover:bg-danger-hover disabled:bg-border-strong disabled:text-muted',
};

const SIZES: Record<Size, string> = {
  // Touch targets stay at 44px on md and lg; sm is for dense desktop toolbars only.
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  iconLeft,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      // A loading button is busy, not broken: it announces state rather than
      // silently swallowing the second click.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'iconLeft'> & {
  /** Required: an icon-only control with no accessible name is unusable. */
  label: string;
  icon: ReactNode;
};

export function IconButton({ label, icon, size = 'md', className, ...rest }: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      title={label}
      size={size}
      className={cn('px-0', size === 'sm' ? 'w-9' : size === 'md' ? 'w-11' : 'w-12', className)}
      {...rest}
    >
      {icon}
    </Button>
  );
}
