import type { ReactNode } from 'react';
import { ScrollArea } from '../ui/ScrollArea';
import { cn, focusRingInset } from '../../lib/cn';
import type { Turn } from '../../lib/api';
import { TranscriptTurn } from './TranscriptTurn';

type TranscriptViewProps = {
  turns: Turn[];
  leading?: ReactNode;
};

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
