import { memo } from 'react';
import { cn } from '../../lib/cn';
import type { ChatCitation } from '../../lib/api';
import { CitationList } from './CitationChip';

type ChatBubbleProps = {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: string;
  citations: ChatCitation[];
  useFullTranscript: boolean;
};

export const ChatBubble = memo(function ChatBubble({
  role,
  content,
  streaming,
  error,
  citations,
  useFullTranscript,
}: ChatBubbleProps) {
  const isUser = role === 'user';
  const showPulse = streaming && content === '' && !error;

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'min-w-0 max-w-[92%] rounded-lg border px-3 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'border-accent/45 bg-accent/10 text-foreground'
            : 'border-border bg-surface-raised text-foreground shadow-raised',
        )}
      >
        {showPulse ? (
          <span className="inline-block h-2.5 w-9 animate-pulse rounded-full bg-accent/50 motion-reduce:animate-none" />
        ) : (
          <p className="wrap-break-word whitespace-pre-wrap">{content}</p>
        )}
        {error ? <p className="mt-2 text-sm leading-5 font-medium text-danger">{error}</p> : null}
        {role === 'assistant' ? (
          <CitationList citations={citations} useFullTranscript={useFullTranscript} />
        ) : null}
      </div>
    </div>
  );
});
