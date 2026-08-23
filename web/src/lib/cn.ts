import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['raised'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const focusRing =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent';

// For scroll containers: an outset ring would be clipped by their overflow-hidden parents.
export const focusRingInset =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset';

export const focusRingWithin =
  'has-[:focus-visible]:outline-hidden has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent';

export const controlBase =
  'inline-flex items-center justify-center rounded-md border border-transparent font-medium transition-colors duration-150 motion-reduce:transition-none';

export const fieldBase =
  'w-full rounded-md border border-control-border bg-control text-sm text-foreground placeholder:text-foreground/75 transition-colors duration-150 hover:border-accent disabled:cursor-not-allowed disabled:text-muted enabled:read-only:cursor-not-allowed enabled:read-only:border-border-strong enabled:read-only:bg-control enabled:read-only:text-muted enabled:read-only:hover:border-border-strong motion-reduce:transition-none';
