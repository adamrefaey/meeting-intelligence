const SPEAKER_SWATCHES = [
  'bg-speaker-blue',
  'bg-speaker-cyan',
  'bg-speaker-green',
  'bg-speaker-violet',
  'bg-speaker-rose',
  'bg-speaker-gold',
] as const;

type SpeakerSwatch = (typeof SPEAKER_SWATCHES)[number];

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
  return point === undefined ? '?' : String.fromCodePoint(point).toUpperCase();
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts.at(-1);
  if (first === undefined || last === undefined) {
    return '?';
  }
  return parts.length === 1 ? firstLetter(first) : `${firstLetter(first)}${firstLetter(last)}`;
}
