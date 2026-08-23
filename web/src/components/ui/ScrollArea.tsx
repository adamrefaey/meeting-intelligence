import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

type ScrollAreaProps = ComponentProps<'div'>;

export function ScrollArea({ className, ...props }: ScrollAreaProps) {
  return <div {...props} className={cn('overflow-auto scrollbar-thin-muted', className)} />;
}
