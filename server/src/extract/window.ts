import { renderTurn, turnPrefix, type Turn } from '../transcript/parse.ts';

export const WINDOW_MAX_CHARS = 12_000;
export const WINDOW_OVERLAP_RATIO = 0.2;

export type FactWindow = {
  turnStart: number;
  turnEnd: number;
  text: string;
};

function packedEnd(start: number, lines: string[], maxChars: number): number {
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
  return end;
}

function nextWindowStart(
  packed: FactWindow,
  lines: string[],
  maxChars: number,
  overlapRatio: number,
): number {
  if (packed.turnEnd === packed.turnStart || packed.turnEnd + 1 >= lines.length) {
    return packed.turnEnd + 1;
  }
  const target = packed.text.length * overlapRatio;
  let acc = 0;
  let overlapped = packed.turnEnd;
  for (let index = packed.turnEnd; index > packed.turnStart; index -= 1) {
    acc += lines[index].length + (acc === 0 ? 0 : 1);
    if (acc >= target) {
      overlapped = index;
      break;
    }
  }
  if (packedEnd(overlapped, lines, maxChars) <= packed.turnEnd) {
    return packed.turnEnd + 1;
  }
  return overlapped;
}

function splitOversizedTurn(
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

export function packWindows(
  turns: Turn[],
  maxChars = WINDOW_MAX_CHARS,
  overlapRatio = WINDOW_OVERLAP_RATIO,
): FactWindow[] {
  const lines = turns.map(renderTurn);
  const windows: FactWindow[] = [];
  let start = 0;
  while (start < turns.length) {
    if (lines[start].length > maxChars) {
      windows.push(...splitOversizedTurn(turns[start], start, maxChars, overlapRatio));
      start += 1;
      continue;
    }
    const end = packedEnd(start, lines, maxChars);
    const packed = {
      turnStart: start,
      turnEnd: end,
      text: lines.slice(start, end + 1).join('\n'),
    };
    windows.push(packed);
    start = nextWindowStart(packed, lines, maxChars, overlapRatio);
  }
  return windows;
}
