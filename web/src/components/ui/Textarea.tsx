import type { ComponentProps } from 'react';
import { cn, fieldBase, focusRing } from '../../lib/cn';

type TextareaProps = ComponentProps<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      {...props}
      className={cn(fieldBase, 'min-h-24 resize-y px-3 py-2', focusRing, className)}
    />
  );
}
