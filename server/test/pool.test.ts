import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPool } from '../src/extract/pool.ts';

test('mapPool preserves input order even when later items finish first', async () => {
  const started: number[] = [];
  const result = await mapPool([30, 10, 20], 2, async (item, index) => {
    started.push(index);
    await new Promise((resolve) => setTimeout(resolve, item));
    return item * 2;
  });
  assert.deepEqual(result, [60, 20, 40]);
  assert.equal(started[0], 0);
  assert.ok(started.includes(1));
  assert.ok(started.includes(2));
});

test('mapPool runs at most the requested number of workers at once', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapPool([1, 2, 3, 4, 5], 2, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
  });
  assert.equal(peak, 2);
});

test('mapPool with empty input does not call the mapper', async () => {
  let called = false;
  const result = await mapPool([], 4, async () => {
    called = true;
    return 1;
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('mapPool rejects when a mapper throws', async () => {
  await assert.rejects(
    () =>
      mapPool([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw new Error('boom');
        }
        return item;
      }),
    { message: 'boom' },
  );
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

test('mapPool concurrency larger than the list still maps every item', async () => {
  const result = await mapPool(['a', 'b'], 8, async (item) => item.toUpperCase());
  assert.deepEqual(result, ['A', 'B']);
});

test('mapPool rejects an AbortError from a mapper', async () => {
  await assert.rejects(
    () =>
      mapPool(['a', 'b'], 2, async (item) => {
        if (item === 'b') {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return item;
      }),
    { name: 'AbortError' },
  );
});
