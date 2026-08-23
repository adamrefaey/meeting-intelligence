import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

type SkeletonProps = ComponentProps<'div'>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      {...props}
      aria-hidden
      className={cn(
        'animate-pulse rounded-md bg-linear-to-r from-surface-raised via-control to-surface-raised motion-reduce:animate-none',
        className,
      )}
    />
  );
}
