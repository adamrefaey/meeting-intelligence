import { packAll } from './pack.ts';
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

type PackedChunk = {
  turnStart: number;
  turnEnd: number;
  text: string;
  speakerLabel: string;
};

/**
 * Deliberately carries no clock. Every timestamp a model can see in an excerpt has to
 * belong to a turn, or it will pair a speaker from this roster with a window boundary.
 * The window range stays available to callers on startTimestamp/endTimestamp.
 */
function roster(speakers: readonly string[], body: string): string {
  return `Speakers: ${speakers.join(', ')}\n${body}`;
}

/** Greedy consecutive turns; roster length is part of the char budget. */
function packChunkFrom(
  start: number,
  turns: Turn[],
  lines: string[],
  maxChars: number,
): PackedChunk {
  let speakers = [turns[start].speaker];
  let body = lines[start];
  let end = start;

  for (let i = start + 1; i < turns.length; i += 1) {
    const speaker = turns[i].speaker;
    const nextSpeakers = speakers.includes(speaker) ? speakers : [...speakers, speaker];
    const nextBody = `${body}\n${lines[i]}`;
    if (roster(nextSpeakers, nextBody).length > maxChars) {
      break;
    }
    speakers = nextSpeakers;
    body = nextBody;
    end = i;
  }

  return {
    turnStart: start,
    turnEnd: end,
    text: roster(speakers, body),
    speakerLabel: speakers.join(', '),
  };
}

/**
 * Retrieval chunks. Restart on the previous chunk's last turn when that still
 * grows; packAll skips overlap after a solo oversized turn or when the pair
 * cannot grow. Unlike extract windows this is not a char-ratio overlap.
 */
export function chunkTurns(turns: Turn[], maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const lines = turns.map(renderTurn);
  return packAll(
    turns.length,
    (start) => packChunkFrom(start, turns, lines, maxChars),
    (previous) => previous.turnEnd,
  ).map((packed, chunkIndex) => {
    const first = turns[packed.turnStart];
    const last = turns[packed.turnEnd];
    return {
      chunkIndex,
      text: packed.text,
      speakerLabel: packed.speakerLabel,
      startTimestamp: first.timestamp,
      endTimestamp: last.timestamp,
      startSeconds: first.startSeconds,
      endSeconds: last.startSeconds,
      turnStartIndex: packed.turnStart,
      turnEndIndex: packed.turnEnd,
    };
  });
}
