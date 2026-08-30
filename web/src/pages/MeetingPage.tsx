import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ChatPanel } from '../components/chat/ChatPanel';
import { FactList } from '../components/meeting/FactList';
import { TranscriptView } from '../components/meeting/TranscriptView';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { cn, focusRing } from '../lib/cn';
import {
  ApiError,
  errorMessage,
  getMeeting,
  getMessages,
  getTranscript,
  isAbortError,
  parseMeetingId,
  type ChatMessage,
  type MeetingDetail,
  type Turn,
} from '../lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed'; message: string }
  | { status: 'ok'; meeting: MeetingDetail; turns: Turn[]; messages: ChatMessage[] };

async function fetchWorkspace(id: number, signal: AbortSignal): Promise<LoadState | undefined> {
  try {
    const [meeting, transcript, history] = await Promise.all([
      getMeeting(id, signal),
      getTranscript(id, signal),
      getMessages(id, signal),
    ]);
    return { status: 'ok', meeting, turns: transcript.turns, messages: history.messages };
  } catch (error) {
    if (isAbortError(error)) {
      return undefined;
    }
    if (error instanceof ApiError && error.status === 404) {
      return { status: 'missing' };
    }
    return {
      status: 'failed',
      message: errorMessage(error, 'Failed to load meeting'),
    };
  }
}

function useMeetingWorkspace(id: number): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchWorkspace(id, controller.signal).then((next) => {
      if (next) {
        setState(next);
      }
    });
    return () => controller.abort();
  }, [id]);

  return state;
}

function useFocusIfLost<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const lost =
      active === document.body ||
      active === document.documentElement ||
      !(active instanceof HTMLElement) ||
      !active.checkVisibility();
    if (lost) {
      ref.current?.focus({ preventScroll: true });
    }
  }, []);
  return ref;
}

function MeetingSkeleton() {
  const ref = useFocusIfLost<HTMLDivElement>();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-busy
      aria-label="Loading meeting"
      className="flex h-full flex-col gap-3 bg-canvas p-6 outline-hidden"
    >
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function MeetingHeader({ meeting }: { meeting: MeetingDetail }) {
  const headingRef = useFocusIfLost<HTMLHeadingElement>();

  return (
    <header className="relative z-10 shrink-0 border-b border-border bg-canvas px-6 py-3">
      <p className="mb-1 flex items-center gap-2 text-[10px] leading-none font-semibold tracking-[0.16em] text-muted uppercase">
        <span>Meeting workspace</span>
        <span className="h-1 w-1 rounded-full bg-border-strong" aria-hidden />
        <span>{meeting.status}</span>
      </p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="truncate text-xl leading-7 font-semibold tracking-tight text-foreground outline-hidden"
      >
        {meeting.title}
      </h1>
    </header>
  );
}

function MeetingWorkspace({
  meeting,
  turns,
  messages,
}: {
  meeting: MeetingDetail;
  turns: Turn[];
  messages: ChatMessage[];
}) {
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(10rem,1fr)_minmax(0,18rem)] bg-surface xl:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-border bg-canvas xl:border-r xl:border-b-0">
        <MeetingHeader meeting={meeting} />
        <TranscriptView
          turns={turns}
          leading={<FactList decisions={meeting.decisions} actionItems={meeting.actionItems} />}
        />
      </section>
      {meeting.status === 'ready' ? (
        <ChatPanel
          key={meeting.id}
          meetingId={meeting.id}
          initialMessages={messages}
          turns={turns}
        />
      ) : (
        <p className="min-h-0 overflow-auto px-6 py-4 text-sm text-muted">
          Chat is available when this meeting is ready.
        </p>
      )}
    </div>
  );
}

function MeetingUnavailable({ title, description }: { title: string; description: string }) {
  const ref = useFocusIfLost<HTMLDivElement>();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex h-full items-center justify-center px-4 outline-hidden"
    >
      <EmptyState
        title={title}
        description={description}
        action={
          <Link
            to="/"
            className={cn(focusRing, 'rounded-sm text-sm underline-offset-4 hover:underline')}
          >
            Back to meetings
          </Link>
        }
      />
    </div>
  );
}

function MeetingPageBody({ id }: { id: number }) {
  const state = useMeetingWorkspace(id);

  if (state.status === 'loading') {
    return <MeetingSkeleton />;
  }
  if (state.status === 'ok') {
    return (
      <MeetingWorkspace meeting={state.meeting} turns={state.turns} messages={state.messages} />
    );
  }

  return (
    <MeetingUnavailable
      title={state.status === 'missing' ? 'Meeting not found' : 'Could not load meeting'}
      description={state.status === 'failed' ? state.message : 'It may have been deleted.'}
    />
  );
}

export function MeetingPage() {
  const id = parseMeetingId(useParams().id);
  if (id === undefined) {
    return <MeetingUnavailable title="Meeting not found" description="It may have been deleted." />;
  }
  return <MeetingPageBody key={id} id={id} />;
}
