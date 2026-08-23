import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

type LabelProps = ComponentProps<'label'>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      {...props}
      className={cn(
        'text-sm font-medium text-foreground aria-disabled:cursor-not-allowed aria-disabled:text-muted',
        className,
      )}
    />
  );
}
