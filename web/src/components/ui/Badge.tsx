import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-semibold tracking-[0.1em] uppercase ring-1 ring-inset',
  {
    variants: {
      variant: {
        neutral: 'bg-control text-foreground/75 ring-border',
        accent: 'bg-accent/12 text-accent ring-accent/30',
        positive: 'bg-positive/12 text-positive ring-positive/30',
        danger: 'bg-danger/12 text-danger ring-danger/30',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span {...props} className={cn(badgeVariants({ variant }), className)} />;
}
