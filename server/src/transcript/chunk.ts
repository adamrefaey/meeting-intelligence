import { renderTurn, type Turn } from './parse.ts';

export type Chunk = {
  chunkIndex: number;
  text: string;
  speakerLabel: string;
  startTimestamp: string;
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  turnStartIndex: number;
  turnEndIndex: number;
};

/** Covers the `[Speaker, timestamp]: ` prefixes too, so it buys ~1800 chars of speech. */
export const DEFAULT_MAX_CHARS = 2000;

type Packed = {
  start: number;
  end: number;
  speakerLabel: string;
  text: string;
};

/**
 * Deliberately carries no clock. Every timestamp a model can see in an excerpt has to
 * belong to a turn, or it will pair a speaker from this roster with a window boundary.
 * The window range stays available to callers on startTimestamp/endTimestamp.
 */
function header(speakerLabel: string): string {
  return `Speakers: ${speakerLabel}`;
}

function candidateLength(speakerLabel: string, bodyLen: number, lineCount: number): number {
  return header(speakerLabel).length + 1 + bodyLen + (lineCount - 1);
}

function nextSpeakerLabel(label: string, speaker: string, seen: Set<string>): string {
  if (seen.has(speaker)) {
    return label;
  }
  return label.length === 0 ? speaker : `${label}, ${speaker}`;
}

function packNext(
  cursor: number,
  chunks: Chunk[],
  turns: Turn[],
  lines: string[],
  maxChars: number,
): Packed {
  if (chunks.length === 0) {
    return packFrom(cursor, turns, lines, maxChars);
  }
  const previous = chunks[chunks.length - 1];
  // Overlap the previous last turn only when the new window both adds a turn and
  // isn't a copy of the previous chunk; otherwise cursor would not advance.
  if (previous.turnEndIndex > previous.turnStartIndex) {
    const overlapped = packFrom(previous.turnEndIndex, turns, lines, maxChars);
    if (overlapped.end >= cursor) {
      return overlapped;
    }
  }
  return packFrom(cursor, turns, lines, maxChars);
}

function packFrom(start: number, turns: Turn[], lines: string[], maxChars: number): Packed {
  const first = turns[start];
  const seen = new Set<string>([first.speaker]);
  let speakerLabel = first.speaker;
  const windowLines = [lines[start]];
  let bodyLen = lines[start].length;
  let end = start;

  for (let i = start + 1; i < turns.length; i += 1) {
    const turn = turns[i];
    const line = lines[i];
    const nextLabel = nextSpeakerLabel(speakerLabel, turn.speaker, seen);
    const nextLen = candidateLength(nextLabel, bodyLen + line.length, windowLines.length + 1);
    if (nextLen > maxChars) {
      break;
    }
    seen.add(turn.speaker);
    speakerLabel = nextLabel;
    windowLines.push(line);
    bodyLen += line.length;
    end = i;
  }

  const text = `${header(speakerLabel)}\n${windowLines.join('\n')}`;
  return { start, end, speakerLabel, text };
}

function toChunk(packed: Packed, turns: Turn[], chunkIndex: number): Chunk {
  const first = turns[packed.start];
  const last = turns[packed.end];
  return {
    chunkIndex,
    text: packed.text,
    speakerLabel: packed.speakerLabel,
    startTimestamp: first.timestamp,
    endTimestamp: last.timestamp,
    startSeconds: first.startSeconds,
    endSeconds: last.startSeconds,
    turnStartIndex: packed.start,
    turnEndIndex: packed.end,
  };
}

export function chunkTurns(turns: Turn[], maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  if (turns.length === 0) {
    return [];
  }
  const lines = turns.map(renderTurn);
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < turns.length) {
    const packed = packNext(cursor, chunks, turns, lines, maxChars);
    chunks.push(toChunk(packed, turns, chunks.length));
    cursor = packed.end + 1;
  }
  return chunks;
}
