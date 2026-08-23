import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn, controlBase, focusRing } from '../../lib/cn';

const buttonVariants = cva(
  [
    controlBase,
    'cursor-pointer whitespace-nowrap',
    focusRing,
    'disabled:cursor-not-allowed disabled:border-border disabled:bg-control disabled:text-muted disabled:hover:bg-control disabled:hover:text-muted',
  ],
  {
    variants: {
      variant: {
        primary: 'border-accent/70 bg-accent text-canvas hover:bg-accent/90',
        ghost: 'text-muted hover:bg-control hover:text-foreground',
        danger: 'border-danger/40 bg-danger/15 text-danger hover:bg-danger/25',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-9 px-4 text-sm',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button {...props} type={type} className={cn(buttonVariants({ variant, size }), className)} />
  );
}
