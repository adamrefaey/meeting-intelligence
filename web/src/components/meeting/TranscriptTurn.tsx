import { Avatar } from '../ui/Avatar';
import type { Turn } from '../../lib/api';

type TranscriptTurnProps = {
  turn: Turn;
};

export function TranscriptTurn({ turn }: TranscriptTurnProps) {
  return (
    <article
      data-turn-seconds={String(turn.startSeconds)}
      className="grid grid-cols-[5.5rem_2.25rem_minmax(0,1fr)] items-start gap-3 rounded-md px-2 py-3 transition-colors duration-200 not-[.turn-flash]:hover:bg-surface/60 motion-reduce:transition-none"
    >
      <time className="min-w-0 truncate pt-1 font-mono text-xs text-muted">{turn.timestamp}</time>
      <Avatar name={turn.speaker} size="sm" className="mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium wrap-break-word text-muted">{turn.speaker}</p>
        <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
          {turn.text}
        </p>
      </div>
    </article>
  );
}
