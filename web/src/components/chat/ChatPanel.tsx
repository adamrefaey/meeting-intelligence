import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '../ui/Button';
import { ScrollArea } from '../ui/ScrollArea';
import { Textarea } from '../ui/Textarea';
import { cn, focusRingInset } from '../../lib/cn';
import {
  chat,
  errorMessage,
  isAbortError,
  type ChatEvent,
  type ChatMessage,
  type Turn,
} from '../../lib/api';
import { ChatBubble } from './ChatBubble';

type Bubble = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  useFullTranscript: boolean;
  error?: string;
  streaming?: boolean;
};

function toBubbles(messages: ChatMessage[]): Bubble[] {
  return messages.map((message) => ({
    key: String(message.id),
    role: message.role,
    content: message.content,
    useFullTranscript: false,
  }));
}

function patchLastAssistant(bubbles: Bubble[], patch: Partial<Bubble>): Bubble[] {
  const last = bubbles.at(-1);
  if (!last || last.role !== 'assistant') {
    return bubbles;
  }
  return [...bubbles.slice(0, -1), { ...last, ...patch }];
}

function applyChatEvent(bubbles: Bubble[], event: ChatEvent): Bubble[] {
  if (event.type === 'token') {
    const last = bubbles.at(-1);
    if (!last || last.role !== 'assistant') {
      return bubbles;
    }
    return patchLastAssistant(bubbles, { content: last.content + event.text });
  }
  if (event.type === 'context') {
    return patchLastAssistant(bubbles, { useFullTranscript: event.useFullTranscript });
  }
  if (event.type === 'error') {
    return patchLastAssistant(bubbles, { error: event.error, streaming: false });
  }
  return patchLastAssistant(bubbles, { streaming: false });
}

function finishAssistant(bubbles: Bubble[]): Bubble[] {
  const last = bubbles.at(-1);
  if (!last || last.role !== 'assistant' || last.streaming !== true) {
    return bubbles;
  }
  return patchLastAssistant(bubbles, {
    streaming: false,
    error: last.error ?? 'Answer was interrupted',
  });
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function optimisticPair(seq: number, text: string): Bubble[] {
  return [
    { key: `local-user-${seq}`, role: 'user', content: text, useFullTranscript: false },
    {
      key: `local-assistant-${seq}`,
      role: 'assistant',
      content: '',
      useFullTranscript: false,
      streaming: true,
    },
  ];
}

async function sendQuestion(
  meetingId: number,
  text: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  try {
    await chat(meetingId, text, onEvent, signal);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    const message = errorMessage(error, 'failed to answer');
    onEvent({ type: 'error', error: message });
  }
}

function assistantStatus(bubbles: Bubble[], streaming: boolean): string {
  if (streaming) {
    return 'Answering…';
  }
  const last = bubbles.at(-1);
  if (!last || last.role !== 'assistant' || !last.key.startsWith('local-assistant-')) {
    return '';
  }
  if (last.error) {
    return last.error;
  }
  return last.content === '' ? '' : 'Answer ready';
}

function ComposerButton({
  streaming,
  disabled,
  onStop,
}: {
  streaming: boolean;
  disabled: boolean;
  onStop: () => void;
}) {
  if (streaming) {
    return (
      <Button type="button" variant="ghost" className="mt-2 w-full" onClick={onStop}>
        Stop
      </Button>
    );
  }
  return (
    <Button type="submit" className="mt-2 w-full" disabled={disabled}>
      Ask
    </Button>
  );
}

const ChatComposer = memo(function ChatComposer({
  draft,
  streaming,
  onDraft,
  onSend,
  onStop,
}: {
  draft: string;
  streaming: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const draftId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    onSend();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend();
  }

  return (
    <form className="shrink-0 border-t border-border bg-surface p-3" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={draftId}>
        Ask about this meeting
      </label>
      <div className="rounded-lg border border-border bg-surface-raised p-2 shadow-raised">
        <Textarea
          id={draftId}
          value={draft}
          readOnly={streaming}
          placeholder="Ask about this meeting"
          className="min-h-16 resize-none"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ComposerButton streaming={streaming} disabled={draft.trim() === ''} onStop={onStop} />
      </div>
    </form>
  );
});

function useStickScroll(bubbles: Bubble[]) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const countRef = useRef(bubbles.length);
  const attachedRef = useRef(false);

  useLayoutEffect(() => {
    const grew = bubbles.length > countRef.current;
    if (grew) {
      stickRef.current = true;
    }
    countRef.current = bubbles.length;
    const el = scrollerRef.current;
    if (!el || !stickRef.current) {
      attachedRef.current = false;
      return;
    }
    const jump = grew || !attachedRef.current;
    attachedRef.current = true;
    if (jump) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (stickRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [bubbles]);

  return { scrollerRef, stickRef };
}

/** An answer's chips are grounded against the question, which is the bubble just above it. */
function askedBefore(bubbles: Bubble[], index: number): string {
  const bubble = bubbles[index];
  const previous = bubbles[index - 1];
  if (bubble?.role !== 'assistant' || previous?.role !== 'user') {
    return '';
  }
  return previous.content;
}

function ChatThread({ bubbles, turns }: { bubbles: Bubble[]; turns: Turn[] }) {
  const { scrollerRef, stickRef } = useStickScroll(bubbles);

  if (bubbles.length === 0) {
    return (
      <p className="min-h-0 flex-1 bg-surface-raised/30 px-5 py-8 text-center text-sm leading-6 text-muted">
        Ask a question about this meeting’s discussion, decisions, or action items.
      </p>
    );
  }

  return (
    <ScrollArea
      ref={scrollerRef}
      tabIndex={0}
      role="region"
      aria-label="Conversation"
      className={cn(focusRingInset, 'min-h-0 flex-1 bg-surface-raised/30 px-3 py-4')}
      onScroll={(event) => {
        stickRef.current = isNearBottom(event.currentTarget);
      }}
    >
      <div className="flex flex-col gap-3">
        {bubbles.map((bubble, index) => (
          <ChatBubble
            key={bubble.key}
            role={bubble.role}
            content={bubble.content}
            question={askedBefore(bubbles, index)}
            streaming={bubble.streaming}
            error={bubble.error}
            useFullTranscript={bubble.useFullTranscript}
            turns={turns}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function startQuestion(
  meetingId: number,
  text: string,
  seqRef: { current: number },
  abortRef: { current: AbortController | null },
  alive: { current: boolean },
  setDraft: (value: string) => void,
  setStreaming: (value: boolean) => void,
  setBubbles: (update: (prev: Bubble[]) => Bubble[]) => void,
) {
  if (text === '' || abortRef.current !== null) {
    return;
  }
  const controller = new AbortController();
  const seq = ++seqRef.current;
  abortRef.current = controller;
  setDraft('');
  setStreaming(true);
  setBubbles((prev) => [...prev, ...optimisticPair(seq, text)]);
  void sendQuestion(meetingId, text, controller.signal, (event) => {
    if (alive.current) {
      setBubbles((prev) => applyChatEvent(prev, event));
    }
  }).finally(() => {
    if (!alive.current) {
      return;
    }
    setStreaming(false);
    abortRef.current = null;
    setBubbles(finishAssistant);
  });
}

function useChatSession(meetingId: number, initialMessages: ChatMessage[]) {
  const [bubbles, setBubbles] = useState(() => toBubbles(initialMessages));
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const send = useCallback(() => {
    startQuestion(
      meetingId,
      draft.trim(),
      seqRef,
      abortRef,
      aliveRef,
      setDraft,
      setStreaming,
      setBubbles,
    );
  }, [draft, meetingId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    bubbles,
    draft,
    setDraft,
    streaming,
    send,
    stop,
    status: assistantStatus(bubbles, streaming),
  };
}

export function ChatPanel({
  meetingId,
  initialMessages,
  turns,
}: {
  meetingId: number;
  initialMessages: ChatMessage[];
  turns: Turn[];
}) {
  const session = useChatSession(meetingId, initialMessages);
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-foreground">
      <h2 className="shrink-0 border-b border-border bg-surface px-4 py-3 text-xs leading-4 font-semibold tracking-[0.12em] text-foreground uppercase">
        Ask this meeting
      </h2>
      <p className="sr-only" aria-live="polite">
        {session.status}
      </p>
      <ChatThread bubbles={session.bubbles} turns={turns} />
      <ChatComposer
        draft={session.draft}
        streaming={session.streaming}
        onDraft={session.setDraft}
        onSend={session.send}
        onStop={session.stop}
      />
    </section>
  );
}
