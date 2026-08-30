import { cn } from '../../lib/cn';
import { initialsFromName, speakerSwatch } from '../../lib/speaker';

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      title={name}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-foreground/15 text-xs font-medium text-foreground',
        speakerSwatch(name),
        className,
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}
