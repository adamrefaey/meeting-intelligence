import { Badge } from '../ui/Badge';
import { cn, focusRing } from '../../lib/cn';
import type { ChatCitation } from '../../lib/api';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let flashTarget: HTMLElement | undefined;
let flashTimer = 0;

export function scrollToCitation(startSeconds: number): void {
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
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
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

export function CitationChip({ citation }: { citation: ChatCitation }) {
  const label = `${citation.speakerLabel} ${citation.startTimestamp}`;
  return (
    <button
      type="button"
      title={label}
      onClick={() => scrollToCitation(citation.startSeconds)}
      className={cn(
        focusRing,
        'min-w-0 max-w-full truncate rounded-sm border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-accent underline-offset-4 transition-colors duration-150 hover:border-accent/45 hover:bg-accent/15 hover:text-foreground hover:underline motion-reduce:transition-none',
      )}
    >
      {label}
    </button>
  );
}

export function CitationList({
  citations,
  useFullTranscript,
}: {
  citations: ChatCitation[];
  useFullTranscript: boolean;
}) {
  if (useFullTranscript) {
    return (
      <div className="mt-2.5">
        <Badge variant="accent">Full transcript</Badge>
      </div>
    );
  }
  if (citations.length === 0) {
    return null;
  }
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {citations.map((citation) => (
        <CitationChip key={citation.id} citation={citation} />
      ))}
    </div>
  );
}
