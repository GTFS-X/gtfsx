import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'toggle';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Pressed state for the `toggle` variant (coral-light fill). */
  on?: boolean;
  /** Red destructive treatment, layered over any variant. */
  danger?: boolean;
  /** Leading glyph/icon rendered before the label. */
  icon?: ReactNode;
  children?: ReactNode;
}

// The unified small/pill button treatment the brief (§5) says the app lacks.
// Colors/type/radii come from the Tailwind @theme tokens in index.css; coral's
// hover-deep shade (#d4603a) matches the value already used across the app.
const BASE =
  'inline-flex items-center gap-1.5 whitespace-nowrap font-heading font-bold text-xs ' +
  'h-[30px] px-3 rounded-md border border-transparent cursor-pointer transition-colors ' +
  'disabled:opacity-45 disabled:cursor-default';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-coral text-white hover:bg-[#d4603a] disabled:hover:bg-coral',
  secondary:
    'bg-white border-sand shadow-sm text-brown hover:border-coral hover:text-[#d4603a] ' +
    'disabled:hover:border-sand disabled:hover:text-brown',
  ghost: 'text-brown hover:bg-cream hover:text-dark-brown',
  toggle: 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]',
};

const TOGGLE_ON = 'bg-coral-light border-coral text-[#d4603a]';
const DANGER = 'text-red-500 hover:bg-red-50 hover:text-red-600 disabled:hover:bg-transparent';

/** Shared pill button. `variant` sets the base treatment; `danger` layers a red
 *  destructive palette; `on` fills the `toggle` variant when pressed. */
export function Button({
  variant = 'secondary',
  on = false,
  danger = false,
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [
    BASE,
    VARIANTS[variant],
    variant === 'toggle' && on ? TOGGLE_ON : '',
    danger ? DANGER : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon != null && (
        <span className="text-[13px] leading-none" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}
