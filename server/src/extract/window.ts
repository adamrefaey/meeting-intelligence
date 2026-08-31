import { packAll } from '../transcript/pack.ts';
import { renderTurn, turnPrefix, type Turn } from '../transcript/parse.ts';

export const WINDOW_MAX_CHARS = 12_000;
export const WINDOW_OVERLAP_RATIO = 0.2;

export type FactWindow = {
  turnStart: number;
  turnEnd: number;
  text: string;
};

/** Always includes `lines[start]`, even if that line is already over budget. */
function packWindowFrom(start: number, lines: string[], maxChars: number): FactWindow {
  let end = start;
  let length = lines[start].length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLength = length + 1 + lines[index].length;
    if (nextLength > maxChars) {
      break;
    }
    length = nextLength;
    end = index;
  }
  return { turnStart: start, turnEnd: end, text: lines.slice(start, end + 1).join('\n') };
}

/**
 * Walk back from the previous window's end until ~`overlapRatio` of its text is
 * reused, never including its first turn. If that suffix is too small
 * (including a single-turn window), start at `previous.turnEnd` and let packAll
 * skip it when the restart would not advance.
 */
function overlapStart(previous: FactWindow, lines: string[], overlapRatio: number): number {
  const target = previous.text.length * overlapRatio;
  let acc = 0;
  for (let index = previous.turnEnd; index > previous.turnStart; index -= 1) {
    acc += lines[index].length + (acc === 0 ? 0 : 1);
    if (acc >= target) {
      return index;
    }
  }
  return previous.turnEnd;
}

/**
 * One turn already over budget: keep the speaker/clock prefix on every slice
 * when it fits, and stride the body with the same overlap ratio.
 */
function sliceOversized(
  turn: Turn,
  turnIndex: number,
  maxChars: number,
  overlapRatio: number,
): FactWindow[] {
  const prefix = turnPrefix(turn);
  const head = prefix.length < maxChars ? prefix : '';
  const body = head.length > 0 ? turn.text : prefix + turn.text;
  const budget = maxChars - head.length;
  const stride = Math.max(1, budget - Math.floor(budget * overlapRatio));
  const windows: FactWindow[] = [];
  for (let offset = 0; offset < body.length; offset += stride) {
    windows.push({
      turnStart: turnIndex,
      turnEnd: turnIndex,
      text: head + body.slice(offset, offset + budget),
    });
    if (offset + budget >= body.length) {
      break;
    }
  }
  return windows;
}

/**
 * Overlapping windows for the extract LLM. Turn-aligned except when a single
 * turn exceeds `maxChars`, in which case that turn is sliced.
 */
export function packWindows(
  turns: Turn[],
  maxChars = WINDOW_MAX_CHARS,
  overlapRatio = WINDOW_OVERLAP_RATIO,
): FactWindow[] {
  const lines = turns.map(renderTurn);
  return packAll(
    turns.length,
    (start) => packWindowFrom(start, lines, maxChars),
    (previous) => overlapStart(previous, lines, overlapRatio),
  ).flatMap((window) =>
    window.text.length > maxChars
      ? sliceOversized(turns[window.turnStart], window.turnStart, maxChars, overlapRatio)
      : [window],
  );
}
