import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, toVectorBlob } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import {
  retrieveForMeeting,
  shouldUseFullTranscript,
  toFtsMatchQuery,
} from '../src/rag/retrieve.ts';
import type { Llm } from '../src/llm/types.ts';

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function openMigratedMemoryDb() {
  const opened = openDb(':memory:');
  migrate(opened);
  return opened;
}

function insertMeeting(database: DatabaseSync, title: string): number {
  const result = database
    .prepare(
      `INSERT INTO meetings (title, original_filename, raw_text, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run(title, `${title}.txt`, 'raw transcript', 'ready');
  return Number(result.lastInsertRowid);
}

function insertChunk(
  database: DatabaseSync,
  meetingId: number,
  chunkIndex: number,
  text: string,
): number {
  const result = database
    .prepare(
      `INSERT INTO chunks (
         meeting_id, chunk_index, text, speaker_label,
         start_timestamp, end_timestamp, start_seconds, end_seconds,
         turn_start_index, turn_end_index
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(meetingId, chunkIndex, text, 'Ada', '00:00:00', '00:00:05', 0, 5, 0, 0);
  return Number(result.lastInsertRowid);
}

function insertEmbedding(
  database: DatabaseSync,
  chunkId: number,
  meetingId: number,
  vector: number[],
): void {
  database
    .prepare('INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding) VALUES (?, ?, ?)')
    .run(chunkId, meetingId, toVectorBlob(vector));
}

function unused(): never {
  throw new Error('not used in retrieve');
}

function fakeLlm(embed: Llm['embed']): Llm {
  return {
    embed,
    completeJson: unused,
    streamChat: unused,
  };
}

test('retrieve never returns a chunk from another meeting_id', async () => {
  db = openMigratedMemoryDb();
  const meetingA = insertMeeting(db, 'A');
  const meetingB = insertMeeting(db, 'B');
  const chunkA = insertChunk(db, meetingA, 0, 'Project Phoenix launch date');
  const chunkB = insertChunk(db, meetingB, 0, 'Project Phoenix launch date');
  insertEmbedding(db, chunkA, meetingA, [1, 0, 0, 0]);
  insertEmbedding(db, chunkB, meetingB, [1, 0, 0, 0]);

  const llm = fakeLlm(async () => [[1, 0, 0, 0]]);
  const hits = await retrieveForMeeting(db, llm, meetingA, 'Phoenix', {
    retrieveK: 8,
    ftsK: 8,
  });

  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.meetingId === meetingA));
  assert.ok(hits.some((hit) => hit.id === chunkA));
  assert.ok(hits.every((hit) => hit.id !== chunkB));
});

test('shouldUseFullTranscript is true only below the threshold', () => {
  assert.equal(shouldUseFullTranscript(23999, 24000), true);
  assert.equal(shouldUseFullTranscript(24000, 24000), false);
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
  const meetingId = insertMeeting(db, 'A');
  const phoenixId = insertChunk(db, meetingId, 0, 'Project Phoenix launch date');
  const fillerId = insertChunk(db, meetingId, 1, 'unrelated standup chatter');
  insertEmbedding(db, phoenixId, meetingId, [0, 1, 0, 0]);
  insertEmbedding(db, fillerId, meetingId, [1, 0, 0, 0]);

  const llm = fakeLlm(async () => [[1, 0, 0, 0]]);
  const hits = await retrieveForMeeting(db, llm, meetingId, 'What about Phoenix?', {
    retrieveK: 8,
    ftsK: 8,
  });

  assert.ok(
    hits.some((hit) => hit.id === phoenixId),
    'FTS should surface the Phoenix chunk even when its embedding is far from the query',
  );
});

test('lexical hits are kept when embed throws', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A');
  const phoenixId = insertChunk(db, meetingId, 0, 'Project Phoenix launch date');
  insertEmbedding(db, phoenixId, meetingId, [1, 0, 0, 0]);

  const llm = fakeLlm(async () => {
    throw new Error('embed down');
  });
  const hits = await retrieveForMeeting(db, llm, meetingId, 'Phoenix', {
    retrieveK: 8,
    ftsK: 8,
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, phoenixId);
});

test('embed abort is not swallowed as a lexical-only result', async () => {
  db = openMigratedMemoryDb();
  const database = db;
  const meetingId = insertMeeting(database, 'A');
  const phoenixId = insertChunk(database, meetingId, 0, 'Project Phoenix launch date');
  insertEmbedding(database, phoenixId, meetingId, [1, 0, 0, 0]);

  const llm = fakeLlm(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(
    () =>
      retrieveForMeeting(database, llm, meetingId, 'Phoenix', {
        retrieveK: 8,
        ftsK: 8,
      }),
    { name: 'AbortError' },
  );
});

test('operator-only query skips FTS and still returns vector neighbors', async () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db, 'A');
  const nearId = insertChunk(db, meetingId, 0, 'near neighbor discussion');
  const farId = insertChunk(db, meetingId, 1, 'unrelated far text');
  insertEmbedding(db, nearId, meetingId, [1, 0, 0, 0]);
  insertEmbedding(db, farId, meetingId, [0, 1, 0, 0]);

  const llm = fakeLlm(async () => [[1, 0, 0, 0]]);
  const hits = await retrieveForMeeting(db, llm, meetingId, '" * ( )', {
    retrieveK: 8,
    ftsK: 8,
  });

  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.id, nearId);
  assert.ok(hits.every((hit) => hit.meetingId === meetingId));
});
