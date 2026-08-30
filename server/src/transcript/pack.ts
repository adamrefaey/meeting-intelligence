/**
 * Both packers walk turns the same way: fill a window greedily from `start`, then restart a
 * little earlier so neighbours share context. The restart is only taken when repacking from
 * it clears the previous window's end -- otherwise `cursor` would not advance.
 */
export function packAll<T extends { turnStart: number; turnEnd: number }>(
  turnCount: number,
  packFrom: (start: number) => T,
  overlapFrom: (previous: T) => number,
): T[] {
  const packed: T[] = [];
  let cursor = 0;
  while (cursor < turnCount) {
    const previous = packed.at(-1);
    const overlap = previous ? packFrom(overlapFrom(previous)) : undefined;
    const next = overlap && overlap.turnEnd >= cursor ? overlap : packFrom(cursor);
    packed.push(next);
    cursor = next.turnEnd + 1;
  }
  return packed;
}
