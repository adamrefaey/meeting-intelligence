import type { ReactNode } from 'react';
import { Avatar } from '../ui/Avatar';
import { ScrollArea } from '../ui/ScrollArea';
import { cn, focusRingInset } from '../../lib/cn';
import type { Turn } from '../../lib/api';

type TranscriptViewProps = {
  turns: Turn[];
  leading?: ReactNode;
};

function TranscriptTurn({ turn }: { turn: Turn }) {
  return (
    <article
      data-turn-seconds={String(turn.startSeconds)}
      className="grid grid-cols-[5.5rem_2.25rem_minmax(0,1fr)] items-start gap-3 rounded-md px-2 py-3 transition-colors duration-200 not-[.turn-flash]:hover:bg-surface/60 motion-reduce:transition-none"
    >
      <time className="min-w-0 truncate pt-1 font-mono text-xs text-muted">{turn.timestamp}</time>
      <Avatar name={turn.speaker} className="mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium wrap-break-word text-muted">{turn.speaker}</p>
        <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
          {turn.text}
        </p>
      </div>
    </article>
  );
}

export function TranscriptView({ turns, leading }: TranscriptViewProps) {
  return (
    <ScrollArea
      tabIndex={0}
      role="region"
      aria-label="Transcript"
      className={cn(focusRingInset, 'min-h-0 flex-1')}
    >
      {leading ? <div className="px-6">{leading}</div> : null}
      {turns.length > 0 ? (
        <div className="mx-6 mt-5 mb-8 border-l border-border">
          {turns.map((turn) => (
            <TranscriptTurn key={turn.id} turn={turn} />
          ))}
        </div>
      ) : null}
    </ScrollArea>
  );
}
