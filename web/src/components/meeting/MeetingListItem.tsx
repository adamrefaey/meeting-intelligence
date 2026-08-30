import { useLayoutEffect, useRef, type RefObject } from 'react';
import { NavLink } from 'react-router';
import { Badge } from '../ui/Badge';
import { IconButton } from '../ui/IconButton';
import { cn, focusRing } from '../../lib/cn';
import type { MeetingSummary } from '../../lib/api';

type MeetingListItemProps = {
  meeting: MeetingSummary;
  onDelete: (meeting: MeetingSummary) => void;
  onSelect: () => void;
};

function formatCreatedAt(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M6 2h4l1 1h3v2H2V3h3l1-1zm-2 4h8v8H4V6zm2 1v6h1V7H6zm3 0v6h1V7H9z"
      />
    </svg>
  );
}

// Deleting the focused row would drop focus to <body>, so hand it to a neighbour while
// the list is still mounted. Runs on layout cleanup, before React detaches the row.
function useFocusHandoff(deleteRef: RefObject<HTMLButtonElement | null>) {
  useLayoutEffect(() => {
    const button = deleteRef.current;
    return () => {
      if (!button || document.activeElement !== button) {
        return;
      }
      const row = button.closest('li');
      const sibling = row?.nextElementSibling ?? row?.previousElementSibling;
      const upload = row?.closest('aside')?.querySelector<HTMLElement>('input[type="file"]');
      (sibling?.querySelector('a') ?? upload)?.focus();
    };
  }, [deleteRef]);
}

export function MeetingListItem({ meeting, onDelete, onSelect }: MeetingListItemProps) {
  const deleteRef = useRef<HTMLButtonElement>(null);
  useFocusHandoff(deleteRef);

  return (
    <div className="flex items-start gap-1">
      <NavLink
        to={`/meetings/${meeting.id}`}
        onClick={onSelect}
        className={({ isActive }) =>
          cn(
            focusRing,
            'flex min-w-0 flex-1 flex-col gap-1 rounded-sm border-l-2 border-transparent bg-transparent px-2 py-2 text-foreground transition-colors duration-150 hover:bg-control motion-reduce:transition-none',
            isActive && 'border-l-2 border-accent bg-control text-foreground',
          )
        }
      >
        <span className="truncate text-sm font-medium">{meeting.title}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-foreground/75">
            {formatCreatedAt(meeting.createdAt)}
          </span>
          <Badge variant={meeting.status === 'ready' ? 'positive' : 'accent'}>
            {meeting.status}
          </Badge>
        </span>
      </NavLink>
      <IconButton
        ref={deleteRef}
        size="md"
        className="mt-1 text-muted hover:bg-danger/10 hover:text-danger"
        aria-label={`Delete ${meeting.title}`}
        onClick={() => onDelete(meeting)}
      >
        <TrashIcon />
      </IconButton>
    </div>
  );
}
