import type { ComponentProps } from 'react';
import { cn, controlBase, focusRing } from '../../lib/cn';

const buttonVariant = {
  primary: 'border-accent/70 bg-accent text-canvas hover:bg-accent/90',
  ghost: 'text-muted hover:bg-control hover:text-foreground',
} as const;

const buttonSize = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
  icon: 'h-9 w-9 shrink-0',
} as const;

type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof buttonVariant;
} & ({ size?: 'sm' | 'md' } | { size: 'icon'; 'aria-label': string });

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        controlBase,
        focusRing,
        'cursor-pointer whitespace-nowrap',
        'disabled:cursor-not-allowed disabled:border-border disabled:bg-control disabled:text-muted disabled:hover:bg-control disabled:hover:text-muted',
        buttonVariant[variant],
        buttonSize[size],
        className,
      )}
    />
  );
}
