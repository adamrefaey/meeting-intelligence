import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { retrieveForMeeting, toFtsMatchQuery } from '../src/rag/retrieve.ts';
import type { Llm } from '../src/llm/types.ts';
import {
  fakeLlm,
  insertChunk,
  insertEmbedding,
  insertMeeting,
  openMigratedMemoryDb,
  unitVectors,
  unused,
} from './helpers.ts';

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const config = { retrieveK: 8, ftsK: 8 };

function retrieveLlm(embed: Llm['embed']): Llm {
  return fakeLlm({ embed, completeJson: unused, streamChat: unused });
}

test('retrieve never returns a chunk from another meeting_id', async () => {
  db = openMigratedMemoryDb();
  const meetingA = insertMeeting(db, 'A', 'ready');
  const meetingB = insertMeeting(db, 'B', 'ready');
  const chunkA = insertChunk(db, meetingA, 0, 'Project Phoenix launch date');
  const chunkB = insertChunk(db, meetingB, 0, 'Project Phoenix launch date');
  insertEmbedding(db, chunkA, meetingA, [1, 0, 0, 0]);
  insertEmbedding(db, chunkB, meetingB, [1, 0, 0, 0]);

  const hits = await retrieveForMeeting(
    db,
    retrieveLlm(async () => [[1, 0, 0, 0]]),
    meetingA,
    'Phoenix',
    config,
  );

  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.meetingId === meetingA));
  assert.ok(hits.some((hit) => hit.id === chunkA));
  assert.ok(hits.every((hit) => hit.id !== chunkB));
});

test('toFtsMatchQuery quotes tokens and joins with OR', () => {
  assert.equal(toFtsMatchQuery(''), undefined);
  assert.equal(toFtsMatchQuery('   '), undefined);
  assert.equal(toFtsMatchQuery('Phoenix'), '"Phoenix"');
  assert.equal(toFtsMatchQuery('What about Phoenix?'), '"What" OR "about" OR "Phoenix?"');
  assert.equal(toFtsMatchQuery('Cost OR Savings'), '"Cost" OR "OR" OR "Savings"');
  assert.equal(toFtsMatchQuery('follow-up items'), '"follow-up" OR "items"');
  assert.equal(toFtsMatchQuery('" * ( )'), undefined);
  assert.equal(toFtsMatchQuery('???'), undefined);
});

test('a natural-language question still retrieves a lexically matching chunk', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A', 'ready');
  const phoenixId = insertChunk(db, meetingId, 0, 'Project Phoenix launch date');
  const fillerId = insertChunk(db, meetingId, 1, 'unrelated standup chatter');
  insertEmbedding(db, phoenixId, meetingId, [0, 1, 0, 0]);
  insertEmbedding(db, fillerId, meetingId, [1, 0, 0, 0]);

  const hits = await retrieveForMeeting(
    db,
    retrieveLlm(async () => [[1, 0, 0, 0]]),
    meetingId,
    'What about Phoenix?',
    config,
  );

  assert.ok(
    hits.some((hit) => hit.id === phoenixId),
    'FTS should surface the Phoenix chunk even when its embedding is far from the query',
  );
});

test('lexical hits are kept when embed throws, but abort is not swallowed', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A', 'ready');
  const phoenixId = insertChunk(db, meetingId, 0, 'Project Phoenix launch date');
  insertEmbedding(db, phoenixId, meetingId, [1, 0, 0, 0]);

  const hits = await retrieveForMeeting(
    db,
    retrieveLlm(async () => {
      throw new Error('embed down');
    }),
    meetingId,
    'Phoenix',
    config,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, phoenixId);

  const aborted = retrieveLlm(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  await assert.rejects(() => retrieveForMeeting(db!, aborted, meetingId, 'Phoenix', config), {
    name: 'AbortError',
  });
});

test('operator-only query skips FTS and still returns vector neighbors', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A', 'ready');
  const nearId = insertChunk(db, meetingId, 0, 'near neighbor discussion');
  const farId = insertChunk(db, meetingId, 1, 'unrelated far text');
  insertEmbedding(db, nearId, meetingId, [1, 0, 0, 0]);
  insertEmbedding(db, farId, meetingId, [0, 1, 0, 0]);

  const hits = await retrieveForMeeting(
    db,
    retrieveLlm(async () => [[1, 0, 0, 0]]),
    meetingId,
    '" * ( )',
    config,
  );

  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.id, nearId);
  assert.ok(hits.every((hit) => hit.meetingId === meetingId));
});

// Both knobs default to 8, so they only stay distinguishable if a test drives them apart:
// ftsK is the per-retriever candidate depth and retrieveK is the cap on the fused result.
test('ftsK bounds each retriever and retrieveK bounds the fused result', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A', 'ready');
  for (const [index, vector] of unitVectors(6, 4).entries()) {
    const chunkId = insertChunk(db, meetingId, index, `Phoenix budget line ${index}`);
    insertEmbedding(db, chunkId, meetingId, vector);
  }
  const llm = retrieveLlm(async () => [[1, 0, 0, 0]]);

  // An operator-only query skips FTS, leaving the vector budget alone to decide the count.
  const vectorOnly = await retrieveForMeeting(db, llm, meetingId, '" * ( )', {
    retrieveK: 6,
    ftsK: 2,
  });
  assert.equal(vectorOnly.length, 2);

  const fused = await retrieveForMeeting(db, llm, meetingId, 'Phoenix', {
    retrieveK: 3,
    ftsK: 6,
  });
  assert.equal(fused.length, 3);
});
