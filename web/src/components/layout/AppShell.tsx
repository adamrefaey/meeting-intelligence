import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link, Outlet, useMatch, useNavigate, type NavigateFunction } from 'react-router';
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

type ShellDeps = {
  navigate: NavigateFunction;
  setMeetings: (value: MeetingSummary[] | ((prev: MeetingSummary[]) => MeetingSummary[])) => void;
  setUploadName: (value: string | null) => void;
  setError: (value: ShellError | null) => void;
  openId: string | undefined;
  closeRail: CloseRail;
};

async function runUpload(file: File, signal: AbortSignal, deps: ShellDeps) {
  const { navigate, setMeetings, setUploadName, setError } = deps;
  setUploadName(file.name);
  setError(null);
  let created: { id: number } | undefined;
  try {
    created = await createMeeting(file, signal);
  } catch (cause) {
    if (!signal.aborted) {
      setError({ kind: 'action', message: errorMessage(cause, 'Upload failed') });
    }
  }
  if (!signal.aborted) {
    setUploadName(null);
    if (created) {
      navigate(`/meetings/${created.id}`);
    }
  }
  if (created) {
    try {
      setMeetings(await listMeetings());
    } catch {
      // Navigation already happened; the rail will catch up on the next load.
    }
  }
}

async function runDelete(meeting: MeetingSummary, deps: ShellDeps) {
  const { navigate, setMeetings, setError, openId, closeRail } = deps;
  if (!window.confirm(`Delete “${meeting.title}”?`)) {
    return;
  }
  try {
    await deleteMeeting(meeting.id);
  } catch (cause) {
    setError({ kind: 'action', message: errorMessage(cause, 'Delete failed') });
    return;
  }
  setError(null);
  setMeetings((prev) => prev.filter((row) => row.id !== meeting.id));
  if (openId === String(meeting.id)) {
    closeRail(true);
    navigate('/');
  }
}

function useLoadMeetings(
  setMeetings: (rows: MeetingSummary[]) => void,
  setError: (value: ShellError | null) => void,
  setLoading: (value: boolean) => void,
) {
  useEffect(() => {
    const controller = new AbortController();
    void listMeetings(controller.signal)
      .then(setMeetings)
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
  }, [setMeetings, setError, setLoading]);
}

function useShellMeetings(openId: string | undefined, closeRail: CloseRail) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError | null>(null);
  const navigate = useNavigate();
  const uploadAbortRef = useRef<AbortController | null>(null);
  const deps: ShellDeps = { navigate, setMeetings, setUploadName, setError, openId, closeRail };

  useLoadMeetings(setMeetings, setError, setLoading);

  function onFile(file: File) {
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    void runUpload(file, controller.signal, deps).finally(() => {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
      }
    });
  }

  return {
    meetings,
    uploadName,
    loading,
    error,
    onFile,
    onReject(file: File) {
      setError({ kind: 'action', message: `${file.name} is not a .txt transcript` });
    },
    onCancel() {
      uploadAbortRef.current?.abort();
      setUploadName(null);
    },
    onDelete(meeting: MeetingSummary) {
      void runDelete(meeting, deps);
    },
  };
}

export type ShellOutletContext = ReturnType<typeof useShellMeetings>;

function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M2 3h12v2H2zm0 4h12v2H2zm0 4h12v2H2z" />
    </svg>
  );
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

const DESKTOP_QUERY = '(min-width: 80rem)';

function useDesktop() {
  const [matches, setMatches] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return matches;
}

function useRailOpen(openId: string | undefined, desktop: boolean) {
  const [railOpen, setRailOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRail = useCallback<CloseRail>((restoreFocus) => {
    const menu = menuRef.current;
    setRailOpen(false);
    if (restoreFocus && menu?.offsetParent) {
      menu.focus();
    }
  }, []);

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

function RailUpload({ shell }: { shell: ShellOutletContext }) {
  return (
    <div className="shrink-0 p-2.5">
      <FileDrop
        busy={shell.uploadName !== null}
        busyLabel={shell.uploadName ?? undefined}
        onCancel={shell.onCancel}
        label="Upload transcript"
        className="px-3 py-4"
        onFile={shell.onFile}
        onReject={shell.onReject}
      />
      {shell.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {shell.error.message}
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
  shell,
  onSelect,
}: {
  open: boolean;
  overlay: boolean;
  showUpload: boolean;
  shell: ShellOutletContext;
  onSelect: () => void;
}) {
  return (
    <aside
      id="meeting-rail"
      tabIndex={overlay ? -1 : undefined}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay || undefined}
      aria-labelledby="meeting-rail-heading"
      aria-busy={shell.loading || undefined}
      className={cn(
        'flex w-64 shrink-0 flex-col border-r border-border-strong bg-surface',
        'fixed top-13 bottom-0 left-0 z-20 xl:static xl:z-auto',
        open ? undefined : 'hidden xl:flex',
      )}
    >
      {showUpload ? <RailUpload shell={shell} /> : null}
      <MeetingRailHeading count={shell.meetings.length} />
      <MeetingList
        meetings={shell.meetings}
        loading={shell.loading}
        onDelete={shell.onDelete}
        onSelect={onSelect}
      />
    </aside>
  );
}

function ShellWorkspace({
  railOpen,
  overlay,
  closeRail,
  showUpload,
  shell,
}: {
  railOpen: boolean;
  overlay: boolean;
  closeRail: CloseRail;
  showUpload: boolean;
  shell: ShellOutletContext;
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
        shell={shell}
        onSelect={() => closeRail()}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={overlay}>
        <Outlet context={shell} />
      </div>
    </div>
  );
}

export function AppShell() {
  const openId = useMatch('/meetings/:id')?.params.id;
  const desktop = useDesktop();
  const { railOpen, setRailOpen, closeRail, menuRef } = useRailOpen(openId, desktop);
  const shell = useShellMeetings(openId, closeRail);
  const overlay = railOpen && !desktop;
  const emptyIndex = openId === undefined && shell.meetings.length === 0;

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <ShellHeader
        railOpen={railOpen}
        overlay={overlay}
        menuRef={menuRef}
        onToggleRail={() => setRailOpen((open) => !open)}
      />
      {shell.error?.kind === 'action' && !railOpen && !emptyIndex ? (
        <p role="alert" className="px-3 py-2 text-sm text-danger xl:hidden">
          {shell.error.message}
        </p>
      ) : null}
      <ShellWorkspace
        railOpen={railOpen}
        overlay={overlay}
        closeRail={closeRail}
        showUpload={!emptyIndex}
        shell={shell}
      />
    </div>
  );
}
