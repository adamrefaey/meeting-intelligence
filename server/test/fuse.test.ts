import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reciprocalRankFusion } from '../src/rag/fuse.ts';

test('rank inside a list orders hits, and appearing in both lists outranks either', () => {
  // Descending ids so the id tiebreak cannot stand in for a rank that is being ignored.
  assert.deepEqual(
    reciprocalRankFusion([[30, 20, 10]]).map((row) => row.id),
    [30, 20, 10],
  );

  const fused = reciprocalRankFusion([
    [10, 20],
    [10, 30],
  ]);
  assert.equal(fused[0]?.id, 10);
  assert.ok(fused[0].score > (fused.find((row) => row.id === 20)?.score ?? 0));
  assert.ok(fused[0].score > (fused.find((row) => row.id === 30)?.score ?? 0));
});

test('empty lists yield an empty result', () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion([[], []]), []);
});
