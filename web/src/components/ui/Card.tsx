import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

type CardProps = ComponentProps<'div'>;

export function Card({ className, ...props }: CardProps) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-lg border border-border bg-surface-raised p-4 shadow-raised',
        className,
      )}
    />
  );
}
