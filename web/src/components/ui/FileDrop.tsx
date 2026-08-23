import { useState } from 'react';
import { cn, focusRingWithin } from '../../lib/cn';

type FileDropProps = {
  onFile: (file: File) => void;
  onReject?: (file: File) => void;
  className?: string;
  label?: string;
  disabled?: boolean;
};

function isTxt(file: File): boolean {
  return file.name.toLowerCase().endsWith('.txt');
}

function takeFile(
  files: FileList | null,
  onFile: (file: File) => void,
  onReject?: (file: File) => void,
) {
  const txt = files ? [...files].find(isTxt) : undefined;
  if (txt) {
    onFile(txt);
    return;
  }
  const first = files?.[0];
  if (first) {
    onReject?.(first);
  }
}

export function FileDrop({
  onFile,
  onReject,
  className,
  label = 'Drop a .txt transcript',
  disabled = false,
}: FileDropProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <label
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) {
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) {
          takeFile(event.dataTransfer.files, onFile, onReject);
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-control-border bg-control px-6 py-10 text-center text-foreground transition-colors duration-150 hover:border-accent hover:bg-surface-raised motion-reduce:transition-none',
        focusRingWithin,
        dragging && 'border-accent bg-accent/10 text-accent',
        disabled &&
          'pointer-events-none cursor-not-allowed border-border bg-surface text-muted hover:border-border hover:bg-surface',
        className,
      )}
    >
      <input
        type="file"
        accept=".txt,text/plain"
        disabled={disabled}
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
