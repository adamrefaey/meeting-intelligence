import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPool } from '../src/extract/pool.ts';

test('mapPool preserves input order and caps in-flight work', async () => {
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const result = await mapPool([30, 10, 20], 2, async (item, index) => {
    started.push(index);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, item));
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(result, [60, 20, 40]);
  assert.equal(started[0], 0);
  assert.equal(peak, 2);
});

test('mapPool stops claiming work after a failure', async () => {
  const seen: number[] = [];
  await assert.rejects(
    () =>
      mapPool([1, 2, 3, 4, 5], 1, async (item) => {
        seen.push(item);
        if (item === 1) {
          throw new Error('boom');
        }
        return item;
      }),
    { message: 'boom' },
  );
  assert.deepEqual(seen, [1]);
});
