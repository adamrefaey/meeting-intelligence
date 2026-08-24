import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
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
  isUploadCancelled,
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
  onCancel: () => void;
  uploadName: string | null;
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
  setUploadName: (value: string | null) => void,
  setError: (value: ShellError | null) => void,
  alive: { current: boolean },
  uploadSignal: AbortSignal,
  refreshSignal: AbortSignal,
  isCurrent: () => boolean,
) {
  setUploadName(file.name);
  setError(null);
  let created: { id: number } | undefined;
  try {
    created = await createMeeting(file, uploadSignal);
  } catch (cause) {
    if (alive.current && isCurrent() && !isUploadCancelled(cause)) {
      setError({ kind: 'action', message: errorMessage(cause, 'Upload failed') });
    }
  }
  if (!alive.current) {
    return;
  }
  if (isCurrent()) {
    setUploadName(null);
    if (created && !uploadSignal.aborted) {
      navigate(`/meetings/${created.id}`);
    }
  }
  try {
    await refresh(refreshSignal);
  } catch {
    // List refresh is best-effort; upload error (if any) is already shown.
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
  const uploadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      aliveRef.current = false;
      controller.abort();
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
    };
  }, []);
  return { aliveRef, abortRef, uploadAbortRef };
}

function queueUpload(
  file: File,
  refresh: (signal?: AbortSignal) => Promise<void>,
  navigate: ReturnType<typeof useNavigate>,
  setUploadName: (value: string | null) => void,
  setError: (value: ShellError | null) => void,
  aliveRef: { current: boolean },
  abortRef: { current: AbortController },
  uploadAbortRef: { current: AbortController | null },
) {
  uploadAbortRef.current?.abort();
  const controller = new AbortController();
  uploadAbortRef.current = controller;
  const isCurrent = () => uploadAbortRef.current === controller;
  void handleUpload(
    file,
    refresh,
    navigate,
    setUploadName,
    setError,
    aliveRef,
    controller.signal,
    abortRef.current.signal,
    isCurrent,
  ).finally(() => {
    if (isCurrent()) {
      uploadAbortRef.current = null;
    }
  });
}

function useDeleteAction(
  refresh: (signal?: AbortSignal) => Promise<void>,
  openId: string | undefined,
  closeRail: CloseRail,
  aliveRef: { current: boolean },
  abortRef: { current: AbortController },
  setMeetings: (update: (prev: MeetingSummary[]) => MeetingSummary[]) => void,
  setError: (value: ShellError | null) => void,
  navigate: ReturnType<typeof useNavigate>,
) {
  return useCallback(
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
}

function useShellActions(
  refresh: (signal?: AbortSignal) => Promise<void>,
  openId: string | undefined,
  closeRail: CloseRail,
  aliveRef: { current: boolean },
  abortRef: { current: AbortController },
  uploadAbortRef: { current: AbortController | null },
  setMeetings: (update: (prev: MeetingSummary[]) => MeetingSummary[]) => void,
  setUploadName: (value: string | null) => void,
  setError: (value: ShellError | null) => void,
) {
  const navigate = useNavigate();
  const onFile = useCallback(
    (file: File) => {
      queueUpload(
        file,
        refresh,
        navigate,
        setUploadName,
        setError,
        aliveRef,
        abortRef,
        uploadAbortRef,
      );
    },
    [refresh, navigate, setUploadName, setError, aliveRef, abortRef, uploadAbortRef],
  );
  const onReject = useCallback(
    (file: File) => {
      setError({ kind: 'action', message: `${file.name} is not a .txt transcript` });
    },
    [setError],
  );
  const onCancel = useCallback(() => {
    uploadAbortRef.current?.abort();
    setUploadName(null);
  }, [uploadAbortRef, setUploadName]);
  const onDelete = useDeleteAction(
    refresh,
    openId,
    closeRail,
    aliveRef,
    abortRef,
    setMeetings,
    setError,
    navigate,
  );
  return { onFile, onReject, onCancel, onDelete };
}

function useShellMeetings(openId: string | undefined, closeRail: CloseRail) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError | null>(null);
  const { aliveRef, abortRef, uploadAbortRef } = useAliveAbort();

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
    uploadAbortRef,
    setMeetings,
    setUploadName,
    setError,
  );

  return {
    meetings,
    uploadName,
    loading,
    error,
    ...actions,
  };
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
  showUpload: boolean;
  uploadName: string | null;
  loading: boolean;
  error: ShellError | null;
  meetings: MeetingSummary[];
  onFile: (file: File) => void;
  onReject: (file: File) => void;
  onCancel: () => void;
  onDelete: (meeting: MeetingSummary) => void;
  onSelect: () => void;
};

function RailUpload({
  uploadName,
  error,
  onFile,
  onReject,
  onCancel,
}: Pick<MeetingRailProps, 'uploadName' | 'error' | 'onFile' | 'onReject' | 'onCancel'>) {
  return (
    <div className="shrink-0 p-2.5">
      <FileDrop
        busy={uploadName !== null}
        busyLabel={uploadName ?? undefined}
        onCancel={onCancel}
        label="Upload transcript"
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

function MeetingRailHeading({ count }: { count: number }) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2">
      <h2
        id="meeting-rail-heading"
        className="font-mono text-[11px] font-medium tracking-[0.12em] text-muted uppercase"
      >
        Meetings
      </h2>
      <span
        className="min-w-5 rounded-full bg-control px-1.5 py-0.5 text-center font-mono text-[10px] leading-4 text-foreground/75"
        aria-label={`${count} ${count === 1 ? 'meeting' : 'meetings'}`}
      >
        {count}
      </span>
    </div>
  );
}

function MeetingRail({
  open,
  overlay,
  showUpload,
  uploadName,
  loading,
  error,
  meetings,
  onFile,
  onReject,
  onCancel,
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
      aria-busy={loading || undefined}
      className={cn(
        'flex w-64 shrink-0 flex-col border-r border-border-strong bg-surface',
        'fixed top-13 bottom-0 left-0 z-20 xl:static xl:z-auto',
        open ? undefined : 'hidden xl:flex',
      )}
    >
      {showUpload ? (
        <RailUpload
          uploadName={uploadName}
          error={error}
          onFile={onFile}
          onReject={onReject}
          onCancel={onCancel}
        />
      ) : null}
      <MeetingRailHeading count={meetings.length} />
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
  showUpload,
  shell,
  context,
}: {
  railOpen: boolean;
  overlay: boolean;
  closeRail: CloseRail;
  showUpload: boolean;
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
        showUpload={showUpload}
        uploadName={shell.uploadName}
        loading={shell.loading}
        error={shell.error}
        meetings={shell.meetings}
        onFile={shell.onFile}
        onReject={shell.onReject}
        onCancel={shell.onCancel}
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
  const emptyIndex = openId === undefined && shell.meetings.length === 0;
  const context = useMemo<ShellOutletContext>(
    () => ({
      meetings: shell.meetings,
      onFile: shell.onFile,
      onReject: shell.onReject,
      onCancel: shell.onCancel,
      uploadName: shell.uploadName,
      loading: shell.loading,
      error: shell.error,
    }),
    [
      shell.meetings,
      shell.onFile,
      shell.onReject,
      shell.onCancel,
      shell.uploadName,
      shell.loading,
      shell.error,
    ],
  );

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <ShellHeader
        railOpen={railOpen}
        overlay={overlay}
        menuRef={menuRef}
        onToggleRail={() => setRailOpen((open) => !open)}
      />
      <ActionErrorBanner error={shell.error} hidden={railOpen || emptyIndex} />
      <ShellWorkspace
        railOpen={railOpen}
        overlay={overlay}
        closeRail={closeRail}
        showUpload={!emptyIndex}
        shell={shell}
        context={context}
      />
    </div>
  );
}
