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

function packFrom(start: number, lines: string[], maxChars: number): FactWindow {
  const end = packedEnd(start, lines, maxChars);
  return { turnStart: start, turnEnd: end, text: lines.slice(start, end + 1).join('\n') };
}

function nextStart(previous: FactWindow, lines: string[], overlapRatio: number): number {
  if (previous.turnEnd === previous.turnStart) {
    return previous.turnEnd + 1;
  }
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

function splitOversizedTurn(
  turn: Turn,
  turnIndex: number,
  maxChars: number,
  overlapRatio: number,
): FactWindow[] {
  const prefix = turnPrefix(turn);
  const labeled = prefix.length < maxChars;
  const head = labeled ? prefix : '';
  const body = labeled ? turn.text : prefix + turn.text;
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
  if (turns.length === 0) {
    return [];
  }
  const lines = turns.map(renderTurn);
  const windows: FactWindow[] = [];
  let start = 0;
  while (start < turns.length) {
    if (lines[start].length > maxChars) {
      windows.push(...splitOversizedTurn(turns[start], start, maxChars, overlapRatio));
      start += 1;
      continue;
    }
    const packed = packFrom(start, lines, maxChars);
    windows.push(packed);
    if (packed.turnEnd + 1 >= turns.length) {
      break;
    }
    let next = nextStart(packed, lines, overlapRatio);
    if (next <= packed.turnStart || packedEnd(next, lines, maxChars) <= packed.turnEnd) {
      next = packed.turnEnd + 1;
    }
    start = next;
  }
  return windows;
}
