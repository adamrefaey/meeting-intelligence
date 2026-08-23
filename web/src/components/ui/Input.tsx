import type { ComponentProps } from 'react';
import { cn, fieldBase, focusRing } from '../../lib/cn';

type InputProps = ComponentProps<'input'>;

export function Input({ className, type = 'text', ...props }: InputProps) {
  return (
    <input {...props} type={type} className={cn(fieldBase, 'h-9 px-3', focusRing, className)} />
  );
}
