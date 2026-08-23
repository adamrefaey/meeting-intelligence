export const SPEAKER_SWATCHES = [
  'bg-speaker-blue',
  'bg-speaker-cyan',
  'bg-speaker-green',
  'bg-speaker-violet',
  'bg-speaker-rose',
  'bg-speaker-gold',
] as const;

export type SpeakerSwatch = (typeof SPEAKER_SWATCHES)[number];

function hashName(name: string): number {
  const key = name.trim().toLowerCase();
  let hash = 5381;
  for (const char of key) {
    hash = (hash * 33 + (char.codePointAt(0) ?? 0)) | 0;
  }
  return Math.abs(hash);
}

export function speakerSwatch(name: string): SpeakerSwatch {
  const index = hashName(name) % SPEAKER_SWATCHES.length;
  return SPEAKER_SWATCHES[index] ?? 'bg-speaker-blue';
}

function firstLetter(value: string): string {
  const point = value.codePointAt(0);
  if (point === undefined) {
    return '?';
  }
  return String.fromCodePoint(point).toUpperCase();
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  const first = parts[0] ?? '';
  if (parts.length === 1) {
    return firstLetter(first);
  }
  const last = parts[parts.length - 1] ?? first;
  return `${firstLetter(first)}${firstLetter(last)}`;
}
