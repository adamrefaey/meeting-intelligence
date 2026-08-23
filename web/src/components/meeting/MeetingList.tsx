import { ScrollArea } from '../ui/ScrollArea';
import type { MeetingSummary } from '../../lib/api';
import { MeetingListItem } from './MeetingListItem';

type MeetingListProps = {
  meetings: MeetingSummary[];
  loading?: boolean;
  onDelete: (meeting: MeetingSummary) => void;
  onSelect: () => void;
};

export function MeetingList({ meetings, loading = false, onDelete, onSelect }: MeetingListProps) {
  if (loading) {
    return <p className="px-3 py-2 text-sm text-muted">Loading…</p>;
  }
  if (meetings.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted">No meetings yet</p>;
  }

  return (
    <ScrollArea className="min-h-0 flex-1 px-2">
      <ul className="flex flex-col gap-0.5 pt-1 pb-3">
        {meetings.map((meeting) => (
          <li key={meeting.id}>
            <MeetingListItem meeting={meeting} onDelete={onDelete} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
