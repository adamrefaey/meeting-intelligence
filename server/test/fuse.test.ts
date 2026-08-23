import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reciprocalRankFusion } from '../src/rag/fuse.ts';

test('id ranked first in both lists beats id ranked first in one list', () => {
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

test('score is 1 / (60 + 1-based rank)', () => {
  assert.equal(reciprocalRankFusion([[10]])[0]?.score, 1 / 61);
});
