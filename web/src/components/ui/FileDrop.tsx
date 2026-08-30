import { useId, useLayoutEffect, useRef, useState } from 'react';
import { cn, focusRingWithin } from '../../lib/cn';
import { Button } from './Button';

type FileDropProps = {
  onFile: (file: File) => void;
  onReject: (file: File) => void;
  onCancel: () => void;
  className?: string;
  label?: string;
  busy?: boolean;
  busyLabel?: string;
};

function isTxt(file: File): boolean {
  return file.name.toLowerCase().endsWith('.txt');
}

function takeFile(
  files: FileList | null,
  onFile: (file: File) => void,
  onReject: (file: File) => void,
) {
  const txt = files ? [...files].find(isTxt) : undefined;
  if (txt) {
    onFile(txt);
    return;
  }
  const first = files?.[0];
  if (first) {
    onReject(first);
  }
}

const boxClassName =
  'flex flex-col items-center justify-center rounded-lg border border-dashed border-control-border bg-control px-6 py-10 text-center text-foreground transition-colors duration-150 motion-reduce:transition-none';

function IngestProgress({ label, onCancel }: { label?: string; onCancel: () => void }) {
  const labelId = useId();
  const fileId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex w-full flex-col items-center">
      <span id={labelId} className="text-sm font-medium">
        Ingesting…
      </span>
      {label ? (
        <span id={fileId} className="mt-1 block w-full truncate text-sm text-muted">
          {label}
        </span>
      ) : null}
      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-labelledby={labelId}
        aria-describedby={label ? fileId : undefined}
      >
        <div className="ingest-progress-fill h-full rounded-full bg-accent" />
      </div>
      <Button
        ref={cancelRef}
        variant="ghost"
        size="sm"
        className="mt-3"
        aria-label={label ? `Cancel ingesting ${label}` : 'Cancel ingest'}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </div>
  );
}

function IdleFileDrop({
  onFile,
  onReject,
  className,
  label,
}: Pick<FileDropProps, 'onFile' | 'onReject' | 'className'> & { label: string }) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        takeFile(event.dataTransfer.files, onFile, onReject);
      }}
      className={cn(
        boxClassName,
        'cursor-pointer hover:border-accent hover:bg-surface-raised',
        focusRingWithin,
        dragging && 'border-accent bg-accent/10 text-accent',
        className,
      )}
    >
      <input
        type="file"
        accept=".txt,text/plain"
        className="pointer-events-none sr-only outline-hidden"
        onChange={(event) => {
          takeFile(event.target.files, onFile, onReject);
          event.target.value = '';
        }}
      />
      <span className="pointer-events-none text-sm font-medium">{label}</span>
      <span className="pointer-events-none mt-1 text-sm text-muted">Click or drag a .txt file</span>
    </label>
  );
}

export function FileDrop({
  onFile,
  onReject,
  className,
  label = 'Drop a .txt transcript',
  busy = false,
  busyLabel,
  onCancel,
}: FileDropProps) {
  if (busy) {
    return (
      <div className={cn(boxClassName, 'cursor-default border-border bg-surface', className)}>
        <IngestProgress label={busyLabel} onCancel={onCancel} />
      </div>
    );
  }
  return <IdleFileDrop onFile={onFile} onReject={onReject} className={className} label={label} />;
}
