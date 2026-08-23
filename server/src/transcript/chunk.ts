import { type Turn } from './parse.ts';

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

export const DEFAULT_MAX_CHARS = 1800;

type Packed = {
  start: number;
  end: number;
  speakerLabel: string;
  text: string;
};

function header(startTs: string, endTs: string, speakerLabel: string): string {
  return `[${startTs}\u2013${endTs}] ${speakerLabel}`;
}

function candidateLength(
  startTs: string,
  endTs: string,
  speakerLabel: string,
  bodyLen: number,
  lineCount: number,
): number {
  return header(startTs, endTs, speakerLabel).length + 1 + bodyLen + (lineCount - 1);
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
    const nextLen = candidateLength(
      first.timestamp,
      turn.timestamp,
      nextLabel,
      bodyLen + line.length,
      windowLines.length + 1,
    );
    if (nextLen > maxChars) {
      break;
    }
    seen.add(turn.speaker);
    speakerLabel = nextLabel;
    windowLines.push(line);
    bodyLen += line.length;
    end = i;
  }

  const last = turns[end];
  const text = `${header(first.timestamp, last.timestamp, speakerLabel)}\n${windowLines.join('\n')}`;
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
  const lines = turns.map((turn) => `${turn.speaker}: ${turn.text}`);
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < turns.length) {
    const packed = packNext(cursor, chunks, turns, lines, maxChars);
    chunks.push(toChunk(packed, turns, chunks.length));
    cursor = packed.end + 1;
  }
  return chunks;
}
