import { memo } from 'react';
import { cn } from '../../lib/cn';
import { segmentAnswer, type CitationTurn } from '../../lib/citations';
import { Badge } from '../ui/Badge';
import { CitationChip } from './CitationChip';

type ChatBubbleProps = {
  role: 'user' | 'assistant';
  content: string;
  question: string;
  streaming?: boolean;
  error?: string;
  useFullTranscript: boolean;
  turns: CitationTurn[];
};

function AnswerContent({
  content,
  question,
  turns,
}: {
  content: string;
  question: string;
  turns: CitationTurn[];
}) {
  return (
    <p className="wrap-break-word whitespace-pre-wrap">
      {segmentAnswer(content, turns, question).map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.text}</span>;
        }
        const { citation } = segment;
        const range =
          citation.endTimestamp !== undefined
            ? `${citation.startTimestamp}\u2013${citation.endTimestamp}`
            : citation.startTimestamp;
        return (
          <CitationChip
            key={index}
            label={citation.startTimestamp}
            title={citation.speaker === '' ? range : `${citation.speaker} ${range}`}
            startSeconds={citation.startSeconds}
            className="mx-0.5 align-baseline"
          />
        );
      })}
    </p>
  );
}

export const ChatBubble = memo(function ChatBubble({
  role,
  content,
  question,
  streaming,
  error,
  useFullTranscript,
  turns,
}: ChatBubbleProps) {
  const isUser = role === 'user';
  const showPulse = streaming && content === '' && !error;
  const complete = role === 'assistant' && streaming !== true && !error;

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
        ) : complete ? (
          <AnswerContent content={content} question={question} turns={turns} />
        ) : (
          <p className="wrap-break-word whitespace-pre-wrap">{content}</p>
        )}
        {error ? <p className="mt-2 text-sm leading-5 font-medium text-danger">{error}</p> : null}
        {complete && useFullTranscript ? (
          <div className="mt-2.5">
            <Badge variant="accent">Full transcript</Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});
