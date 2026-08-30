import type { ComponentProps } from 'react';
import { cn, controlBase, focusRing } from '../../lib/cn';

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & {
  'aria-label': string;
};

export function IconButton({ className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        controlBase,
        focusRing,
        'h-9 w-9 shrink-0 cursor-pointer text-muted hover:bg-control hover:text-foreground',
        className,
      )}
    />
  );
}
