import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

const badgeClass = {
  accent: 'bg-accent/12 text-accent ring-accent/30',
  positive: 'bg-positive/12 text-positive ring-positive/30',
} as const;

type BadgeProps = ComponentProps<'span'> & {
  variant: keyof typeof badgeClass;
};

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-semibold tracking-widest uppercase ring-1 ring-inset',
        badgeClass[variant],
        className,
      )}
    />
  );
}
