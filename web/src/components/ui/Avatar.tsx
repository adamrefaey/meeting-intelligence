import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { initialsFromName, speakerSwatch } from '../../lib/speaker';

const avatarVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full border border-foreground/15 font-medium text-foreground',
  {
    variants: {
      size: {
        sm: 'h-7 w-7 text-xs',
        md: 'h-9 w-9 text-sm',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
);

type AvatarProps = Omit<ComponentProps<'span'>, 'children'> &
  VariantProps<typeof avatarVariants> & {
    name: string;
  };

export function Avatar({ name, size, className, ...props }: AvatarProps) {
  return (
    <span
      {...props}
      aria-hidden
      title={name}
      className={cn(avatarVariants({ size }), speakerSwatch(name), className)}
    >
      {initialsFromName(name)}
    </span>
  );
}
