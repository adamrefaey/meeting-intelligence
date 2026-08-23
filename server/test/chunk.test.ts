import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chunkTurns } from '../src/transcript/chunk.ts';
import { parseTranscript, type Turn } from '../src/transcript/parse.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');

function t(speaker: string, timestamp: string, startSeconds: number, text: string): Turn {
  return { speaker, timestamp, startSeconds, text };
}

test('empty input returns no chunks', () => {
  assert.deepEqual(chunkTurns([]), []);
});

test('two short turns pack into one chunk with default maxChars', () => {
  const turns = [t('Ada', '00:00:01', 1, 'hi'), t('Ben', '00:00:05', 5, 'yo')];
  const chunks = chunkTurns(turns);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    chunkIndex: 0,
    text: '[00:00:01–00:00:05] Ada, Ben\nAda: hi\nBen: yo',
    speakerLabel: 'Ada, Ben',
    startTimestamp: '00:00:01',
    endTimestamp: '00:00:05',
    startSeconds: 1,
    endSeconds: 5,
    turnStartIndex: 0,
    turnEndIndex: 1,
  });
});

test('a turn that exceeds maxChars stays whole', () => {
  const utterance = 'x'.repeat(50);
  const chunks = chunkTurns([t('Ada', '00:00:01', 1, utterance)], 10);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes(utterance));
  assert.equal(chunks[0].turnStartIndex, 0);
  assert.equal(chunks[0].turnEndIndex, 0);
});

test('adjacent chunks overlap by exactly one turn', () => {
  const twoTurnText = '[00:00:01–00:00:02] Ada, Ben\nAda: xx\nBen: xx';
  const turns = [
    t('Ada', '00:00:01', 1, 'xx'),
    t('Ben', '00:00:02', 2, 'xx'),
    t('Cam', '00:00:03', 3, 'xx'),
    t('Deb', '00:00:04', 4, 'xx'),
  ];
  const chunks = chunkTurns(turns, twoTurnText.length);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[1].turnStartIndex, chunks[0].turnEndIndex);
  assert.ok(chunks[1].turnEndIndex > chunks[1].turnStartIndex);
  assert.equal(chunks[0].startTimestamp, turns[chunks[0].turnStartIndex].timestamp);
  assert.equal(chunks[0].endTimestamp, turns[chunks[0].turnEndIndex].timestamp);
  assert.equal(chunks[1].startTimestamp, turns[chunks[1].turnStartIndex].timestamp);
  assert.equal(chunks[1].endTimestamp, turns[chunks[1].turnEndIndex].timestamp);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunkIndex, index);
  }
  const covered = new Set<number>();
  for (const chunk of chunks) {
    for (let i = chunk.turnStartIndex; i <= chunk.turnEndIndex; i += 1) {
      covered.add(i);
    }
  }
  assert.deepEqual(
    [...covered].sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
});

test('skips overlap after a solo oversized chunk', () => {
  const utterance = 'x'.repeat(50);
  const chunks = chunkTurns(
    [t('Ada', '00:00:01', 1, utterance), t('Ben', '00:00:02', 2, utterance)],
    10,
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].turnStartIndex, 0);
  assert.equal(chunks[0].turnEndIndex, 0);
  assert.equal(chunks[1].turnStartIndex, 1);
});

test('skips overlap when the overlapped pair cannot grow', () => {
  const twoTurnText = '[00:00:01–00:00:02] Ada, Ben\nAda: xx\nBen: xx';
  const turns = [
    t('Ada', '00:00:01', 1, 'xx'),
    t('Ben', '00:00:02', 2, 'xx'),
    t('Cam', '00:00:03', 3, 'x'.repeat(500)),
  ];
  const chunks = chunkTurns(turns, twoTurnText.length);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].turnStartIndex, 0);
  assert.equal(chunks[0].turnEndIndex, 1);
  assert.equal(chunks[1].turnStartIndex, 2);
  assert.equal(chunks[1].turnEndIndex, 2);
});

test('same speaker twice uses a unique speakerLabel', () => {
  const chunks = chunkTurns([t('Ada', '00:00:01', 1, 'first'), t('Ada', '00:00:05', 5, 'second')]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].speakerLabel, 'Ada');
  assert.equal(chunks[0].text, '[00:00:01–00:00:05] Ada\nAda: first\nAda: second');
});

test('standup fixture packs into one chunk at default maxChars', () => {
  const raw = readFileSync(standupPath, 'utf8');
  const turns = parseTranscript(raw);
  const chunks = chunkTurns(turns);
  assert.equal(chunks.length, 1);
});
