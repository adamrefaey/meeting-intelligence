import { useOutletContext } from 'react-router';
import { BrandMark } from '../components/ui/BrandMark';
import { EmptyState } from '../components/ui/EmptyState';
import { FileDrop } from '../components/ui/FileDrop';
import { Skeleton } from '../components/ui/Skeleton';
import type { ShellOutletContext } from '../components/layout/AppShell';

function GlowingBrandMark() {
  return (
    <div className="relative flex h-14 w-14 items-center justify-center" aria-hidden>
      <span className="absolute inset-2 rounded-full bg-accent/20 blur-xl" />
      <span className="relative flex h-11 w-11 items-center justify-center rounded-lg border border-accent/20 bg-accent/10">
        <BrandMark size="md" />
      </span>
    </div>
  );
}

function EmptyMeetings({
  onFile,
  onReject,
  onCancel,
  uploadName,
  error,
}: Pick<ShellOutletContext, 'onFile' | 'onReject' | 'onCancel' | 'uploadName' | 'error'>) {
  const listFailed = error?.kind === 'load';
  return (
    <EmptyState
      heading
      icon={<GlowingBrandMark />}
      title={listFailed ? 'Could not load meetings' : 'Upload a transcript to start'}
      description={
        listFailed
          ? 'Check that the API is running, then drop a transcript to try again.'
          : 'Drop a speaker-labeled .txt transcript to read it and ask questions about that meeting.'
      }
      action={
        <div className="flex w-full max-w-sm flex-col">
          <FileDrop
            busy={uploadName !== null}
            busyLabel={uploadName ?? undefined}
            onCancel={onCancel}
            className="w-full"
            label="Drop a .txt transcript"
            onFile={onFile}
            onReject={onReject}
          />
          {error?.kind === 'action' ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error.message}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

export function MeetingsPage() {
  const { meetings, onFile, onReject, onCancel, uploadName, loading, error } =
    useOutletContext<ShellOutletContext>();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-4" aria-busy>
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <EmptyMeetings
          onFile={onFile}
          onReject={onReject}
          onCancel={onCancel}
          uploadName={uploadName}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <EmptyState
        heading
        icon={<GlowingBrandMark />}
        title="Select a meeting"
        description="Choose a meeting from the rail to open its transcript and chat."
      />
    </div>
  );
}
