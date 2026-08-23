import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type EmptyStateProps = Omit<ComponentProps<'div'>, 'title'> & {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  heading?: boolean;
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  heading = false,
  className,
  ...props
}: EmptyStateProps) {
  const Title = heading ? 'h1' : 'p';
  return (
    <div
      {...props}
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? <div className="flex items-center justify-center">{icon}</div> : null}
      <Title className="text-xl font-semibold tracking-tight text-foreground">{title}</Title>
      {description ? <p className="max-w-sm text-sm text-muted">{description}</p> : null}
      {action}
    </div>
  );
}
