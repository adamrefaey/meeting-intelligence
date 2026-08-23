import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn, controlBase, focusRing } from '../../lib/cn';

const iconButtonVariants = cva(
  [
    controlBase,
    'shrink-0 cursor-pointer',
    focusRing,
    'disabled:cursor-not-allowed disabled:border-border disabled:bg-control disabled:text-muted disabled:hover:bg-control disabled:hover:text-muted',
  ],
  {
    variants: {
      variant: {
        ghost: 'text-muted hover:bg-control hover:text-foreground',
        primary: 'border-accent/70 bg-accent text-canvas hover:bg-accent/90',
      },
      size: {
        sm: 'h-8 w-8',
        md: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'md',
    },
  },
);

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> &
  VariantProps<typeof iconButtonVariants> & {
    'aria-label': string;
  };

export function IconButton({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(iconButtonVariants({ variant, size }), className)}
    />
  );
}
