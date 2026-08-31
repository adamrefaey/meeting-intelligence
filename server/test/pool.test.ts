import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPool } from '../src/extract/pool.ts';

test('mapPool preserves input order and caps in-flight work', async () => {
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const hold = Promise.withResolvers<void>();
  const done = mapPool([1, 2, 3], 2, async (item, index) => {
    started.push(index);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await hold.promise;
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(started, [0, 1]);
  assert.equal(peak, 2);
  hold.resolve();
  assert.deepEqual(await done, [2, 4, 6]);
  assert.deepEqual(started, [0, 1, 2]);
});

test('mapPool treats non-positive concurrency as 1', { timeout: 1000 }, async () => {
  let inFlight = 0;
  let peak = 0;
  const hold = Promise.withResolvers<void>();
  const done = mapPool([1, 2], 0, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await hold.promise;
    inFlight -= 1;
    return item;
  });
  assert.equal(peak, 1);
  hold.resolve();
  assert.deepEqual(await done, [1, 2]);
  assert.equal(peak, 1);
});

test('a failed item skips later batches without waiting for siblings', async () => {
  const seen: number[] = [];
  const sibling = Promise.withResolvers<void>();
  let siblingFinished = false;

  await assert.rejects(
    () =>
      mapPool([1, 2, 3, 4], 2, async (item) => {
        seen.push(item);
        if (item === 1) {
          throw new Error('boom');
        }
        await sibling.promise;
        siblingFinished = true;
        return item;
      }),
    { message: 'boom' },
  );

  assert.equal(siblingFinished, false);
  assert.deepEqual(seen, [1, 2]);
  sibling.resolve();
});

test('a sync throw does not orphan sibling rejections', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const sibling = Promise.withResolvers<void>();
  await assert.rejects(
    () =>
      mapPool([1, 2], 2, (item) => {
        if (item === 2) {
          throw new Error('sync');
        }
        return sibling.promise;
      }),
    { message: 'sync' },
  );
  sibling.reject(new Error('sibling'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandled.length, 0);
});
