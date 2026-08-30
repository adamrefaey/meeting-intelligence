import { cn, focusRing } from '../../lib/cn';

let flashTarget: HTMLElement | undefined;
let flashTimer = 0;

function scrollToCitation(startSeconds: number): void {
  if (!Number.isFinite(startSeconds)) {
    return;
  }
  const target = document.querySelector(
    `[data-turn-seconds="${CSS.escape(String(startSeconds))}"]`,
  );
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  if (flashTarget && flashTarget !== target) {
    flashTarget.classList.remove('turn-flash');
  }
  window.clearTimeout(flashTimer);
  flashTarget = target;
  target.classList.add('turn-flash');
  flashTimer = window.setTimeout(() => {
    if (target.isConnected) {
      target.classList.remove('turn-flash');
    }
    flashTarget = undefined;
  }, 1200);
}

export function CitationChip({
  label,
  title,
  startSeconds,
  className,
}: {
  label: string;
  title: string;
  startSeconds: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => scrollToCitation(startSeconds)}
      className={cn(
        focusRing,
        'inline-flex shrink-0 items-baseline rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0 font-mono text-[10px] leading-4 text-accent underline-offset-4 transition-colors duration-150 hover:border-accent/45 hover:bg-accent/15 hover:text-foreground hover:underline motion-reduce:transition-none',
        className,
      )}
    >
      {label}
    </button>
  );
}
