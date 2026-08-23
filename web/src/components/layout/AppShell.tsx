import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link, Outlet, useMatch, useNavigate } from 'react-router';
import { BrandMark } from '../ui/BrandMark';
import { FileDrop } from '../ui/FileDrop';
import { IconButton } from '../ui/IconButton';
import { cn, focusRing } from '../../lib/cn';
import {
  createMeeting,
  deleteMeeting,
  errorMessage,
  isAbortError,
  listMeetings,
  type MeetingSummary,
} from '../../lib/api';
import { MeetingList } from '../meeting/MeetingList';

export type ShellError = { kind: 'load' | 'action'; message: string };

type CloseRail = (restoreFocus?: boolean) => void;

export type ShellOutletContext = {
  meetings: MeetingSummary[];
  onFile: (file: File) => void;
  onReject: (file: File) => void;
  uploading: boolean;
  loading: boolean;
  error: ShellError | null;
};

function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M2 3h12v2H2zm0 4h12v2H2zm0 4h12v2H2z" />
    </svg>
  );
}

async function handleUpload(
  file: File,
  refresh: (signal?: AbortSignal) => Promise<void>,
  navigate: ReturnType<typeof useNavigate>,
  setUploading: (value: boolean) => void,
  setError: (value: ShellError | null) => void,
  alive: { current: boolean },
  signal: AbortSignal,
) {
  setUploading(true);
  setError(null);
  let created: { id: number } | undefined;
  try {
    created = await createMeeting(file, signal);
  } catch (cause) {
    if (alive.current && !isAbortError(cause)) {
      setError({ kind: 'action', message: errorMessage(cause, 'Upload failed') });
    }
  }
  if (!alive.current) {
    return;
  }
  try {
    await refresh(signal);
  } catch {
    // List refresh is best-effort; upload error (if any) is already shown.
  }
  if (alive.current && created) {
    navigate(`/meetings/${created.id}`);
  }
  if (alive.current) {
    setUploading(false);
  }
}

async function handleDelete(
  meeting: MeetingSummary,
  refresh: (signal?: AbortSignal) => Promise<void>,
  navigate: ReturnType<typeof useNavigate>,
  setMeetings: (update: (prev: MeetingSummary[]) => MeetingSummary[]) => void,
  setError: (value: ShellError | null) => void,
  openId: string | undefined,
  closeRail: CloseRail,
  alive: { current: boolean },
  signal: AbortSignal,
) {
  if (!window.confirm(`Delete “${meeting.title}”?`)) {
    return;
  }
  try {
    await deleteMeeting(meeting.id, signal);
  } catch (cause) {
    if (alive.current) {
      setError({ kind: 'action', message: errorMessage(cause, 'Delete failed') });
    }
    return;
  }
  if (!alive.current) {
    return;
  }
  setError(null);
  setMeetings((prev) => prev.filter((row) => row.id !== meeting.id));
  if (openId === String(meeting.id)) {
    closeRail(true);
    navigate('/');
  }
  try {
    await refresh(signal);
  } catch {
    // Local list already dropped the row; refresh is best-effort.
  }
}

function useLoadMeetings(
  refresh: (signal?: AbortSignal) => Promise<void>,
  setError: (value: ShellError | null) => void,
  setLoading: (value: boolean) => void,
) {
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal)
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) {
          setError({ kind: 'load', message: errorMessage(cause, 'Failed to load meetings') });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [refresh, setError, setLoading]);
}

function useAliveAbort() {
  const aliveRef = useRef(true);
  const abortRef = useRef(new AbortController());
  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, []);
  return { aliveRef, abortRef };
}

function useShellActions(
  refresh: (signal?: AbortSignal) => Promise<void>,
  openId: string | undefined,
  closeRail: CloseRail,
  aliveRef: { current: boolean },
  abortRef: { current: AbortController },
  setMeetings: (update: (prev: MeetingSummary[]) => MeetingSummary[]) => void,
  setUploading: (value: boolean) => void,
  setError: (value: ShellError | null) => void,
) {
  const navigate = useNavigate();
  const onFile = useCallback(
    (file: File) => {
      void handleUpload(
        file,
        refresh,
        navigate,
        setUploading,
        setError,
        aliveRef,
        abortRef.current.signal,
      );
    },
    [refresh, navigate, setUploading, setError, aliveRef, abortRef],
  );
  const onReject = useCallback(
    (file: File) => {
      setError({ kind: 'action', message: `${file.name} is not a .txt transcript` });
    },
    [setError],
  );
  const onDelete = useCallback(
    (meeting: MeetingSummary) => {
      void handleDelete(
        meeting,
        refresh,
        navigate,
        setMeetings,
        setError,
        openId,
        closeRail,
        aliveRef,
        abortRef.current.signal,
      );
    },
    [refresh, navigate, openId, closeRail, setMeetings, setError, aliveRef, abortRef],
  );
  return { onFile, onReject, onDelete };
}

function useShellMeetings(openId: string | undefined, closeRail: CloseRail) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError | null>(null);
  const { aliveRef, abortRef } = useAliveAbort();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const rows = await listMeetings(signal);
      if (aliveRef.current) {
        setMeetings(rows);
      }
    },
    [aliveRef],
  );

  useLoadMeetings(refresh, setError, setLoading);
  const actions = useShellActions(
    refresh,
    openId,
    closeRail,
    aliveRef,
    abortRef,
    setMeetings,
    setUploading,
    setError,
  );

  return { meetings, uploading, loading, error, ...actions };
}

function ShellHeader({
  railOpen,
  overlay,
  onToggleRail,
  menuRef,
}: {
  railOpen: boolean;
  overlay: boolean;
  onToggleRail: () => void;
  menuRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="z-30 flex h-13 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <IconButton
        ref={menuRef}
        size="md"
        className="xl:hidden"
        aria-label={railOpen ? 'Close meetings' : 'Open meetings'}
        aria-expanded={railOpen}
        aria-controls="meeting-rail"
        onClick={onToggleRail}
      >
        <MenuIcon />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-2" inert={overlay}>
        <Link
          to="/"
          className={cn(
            focusRing,
            'flex items-center gap-2 rounded-sm text-sm font-semibold tracking-tight text-foreground',
          )}
        >
          <BrandMark size="sm" />
          <span>Meeting Intelligence</span>
        </Link>
      </div>
    </header>
  );
}

function useMinWidth(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(`(min-width: ${query})`).matches);
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${query})`);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function useRailOpen(openId: string | undefined, desktop: boolean) {
  const [railOpen, setRailOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const railOpenRef = useRef(false);
  const closeRail = useCallback<CloseRail>((restoreFocus) => {
    const restore = restoreFocus === true && railOpenRef.current;
    const menu = menuRef.current;
    setRailOpen(false);
    if (restore && menu?.offsetParent) {
      menu.focus();
    }
  }, []);

  useEffect(() => {
    railOpenRef.current = railOpen;
  }, [railOpen]);

  useEffect(() => {
    if (openId !== undefined || desktop) {
      closeRail();
    }
  }, [openId, desktop, closeRail]);

  useLayoutEffect(() => {
    if (!railOpen || desktop) {
      return;
    }
    document.getElementById('meeting-rail')?.focus();
  }, [railOpen, desktop]);

  useEffect(() => {
    if (!railOpen || desktop) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRail(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railOpen, desktop, closeRail]);

  return { railOpen, setRailOpen, closeRail, menuRef };
}

type MeetingRailProps = {
  open: boolean;
  overlay: boolean;
  uploading: boolean;
  loading: boolean;
  error: ShellError | null;
  meetings: MeetingSummary[];
  onFile: (file: File) => void;
  onReject: (file: File) => void;
  onDelete: (meeting: MeetingSummary) => void;
  onSelect: () => void;
};

function RailUpload({
  uploading,
  error,
  onFile,
  onReject,
}: Pick<MeetingRailProps, 'uploading' | 'error' | 'onFile' | 'onReject'>) {
  return (
    <div className="shrink-0 p-2.5">
      <FileDrop
        disabled={uploading}
        label={uploading ? 'Ingesting…' : 'Upload transcript'}
        className="px-3 py-4"
        onFile={onFile}
        onReject={onReject}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

function MeetingRail({
  open,
  overlay,
  uploading,
  loading,
  error,
  meetings,
  onFile,
  onReject,
  onDelete,
  onSelect,
}: MeetingRailProps) {
  return (
    <aside
      id="meeting-rail"
      tabIndex={overlay ? -1 : undefined}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay || undefined}
      aria-labelledby="meeting-rail-heading"
      aria-busy={uploading || loading}
      className={cn(
        'flex w-64 shrink-0 flex-col border-r border-border-strong bg-surface',
        'fixed top-13 bottom-0 left-0 z-20 xl:static xl:z-auto',
        open ? undefined : 'hidden xl:flex',
      )}
    >
      <RailUpload uploading={uploading} error={error} onFile={onFile} onReject={onReject} />
      <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2">
        <h2
          id="meeting-rail-heading"
          className="font-mono text-[11px] font-medium tracking-[0.12em] text-muted uppercase"
        >
          Meetings
        </h2>
        <span
          className="min-w-5 rounded-full bg-control px-1.5 py-0.5 text-center font-mono text-[10px] leading-4 text-foreground/75"
          aria-label={`${meetings.length} ${meetings.length === 1 ? 'meeting' : 'meetings'}`}
        >
          {meetings.length}
        </span>
      </div>
      <MeetingList meetings={meetings} loading={loading} onDelete={onDelete} onSelect={onSelect} />
    </aside>
  );
}

function ActionErrorBanner({ error, hidden }: { error: ShellError | null; hidden: boolean }) {
  if (error?.kind !== 'action' || hidden) {
    return null;
  }
  return (
    <p role="alert" className="px-3 py-2 text-sm text-danger xl:hidden">
      {error.message}
    </p>
  );
}

function ShellWorkspace({
  railOpen,
  overlay,
  closeRail,
  shell,
  context,
}: {
  railOpen: boolean;
  overlay: boolean;
  closeRail: CloseRail;
  shell: ReturnType<typeof useShellMeetings>;
  context: ShellOutletContext;
}) {
  return (
    <div className="relative flex min-h-0 flex-1">
      {overlay ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close meetings overlay"
          className="fixed inset-0 z-10 bg-canvas/75 xl:hidden"
          onClick={() => closeRail(true)}
        />
      ) : null}
      <MeetingRail
        open={railOpen}
        overlay={overlay}
        uploading={shell.uploading}
        loading={shell.loading}
        error={shell.error}
        meetings={shell.meetings}
        onFile={shell.onFile}
        onReject={shell.onReject}
        onDelete={shell.onDelete}
        onSelect={() => closeRail()}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={overlay}>
        <Outlet context={context} />
      </div>
    </div>
  );
}

export function AppShell() {
  const openId = useMatch('/meetings/:id')?.params.id;
  const desktop = useMinWidth('80rem');
  const { railOpen, setRailOpen, closeRail, menuRef } = useRailOpen(openId, desktop);
  const shell = useShellMeetings(openId, closeRail);
  const overlay = railOpen && !desktop;
  const context: ShellOutletContext = {
    meetings: shell.meetings,
    onFile: shell.onFile,
    onReject: shell.onReject,
    uploading: shell.uploading,
    loading: shell.loading,
    error: shell.error,
  };

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <ShellHeader
        railOpen={railOpen}
        overlay={overlay}
        menuRef={menuRef}
        onToggleRail={() => setRailOpen((open) => !open)}
      />
      <ActionErrorBanner error={shell.error} hidden={railOpen} />
      <ShellWorkspace
        railOpen={railOpen}
        overlay={overlay}
        closeRail={closeRail}
        shell={shell}
        context={context}
      />
    </div>
  );
}
