import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { cosineQuery, fromVectorBlob, openDb, toVectorBlob } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';

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

function insertMeeting(database: DatabaseSync): number {
  const result = database
    .prepare(
      `INSERT INTO meetings (title, status)
       VALUES (?, ?)`,
    )
    .run('Standup', 'processing');
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

test('migrate is idempotent and sets user_version to 1', () => {
  const opened = openDb(':memory:');
  db = opened;
  migrate(opened);
  assert.doesNotThrow(() => migrate(opened));
  const row = opened.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, 1);
});

test('deleting a meeting cascades to turns', () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db);
  db.prepare(
    `INSERT INTO turns (meeting_id, turn_index, speaker, timestamp, start_seconds, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(meetingId, 0, 'Ada', '00:00:00', 0, 'hello');

  db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);

  const row = db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
  assert.equal(row.n, 0);
});

test('vector blob round-trip preserves values within 1e-6', () => {
  const values = [0.1, -0.2, 0.3, 0.4];
  const restored = fromVectorBlob(toVectorBlob(values));
  assert.equal(restored.length, values.length);
  for (let i = 0; i < values.length; i++) {
    assert.ok(Math.abs(restored[i] - values[i]) < 1e-6);
  }
});

test('cosine distance of a vector with itself is ~0', () => {
  db = openMigratedMemoryDb();
  const blob = toVectorBlob([1, 0, 0, 0]);
  const row = db.prepare('SELECT vec_distance_cosine(?, ?) AS d').get(blob, blob) as { d: number };
  assert.ok(Math.abs(row.d) < 1e-6);
});

test('cosineQuery returns the nearer neighbor first', () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db);
  const nearId = insertChunk(db, meetingId, 0, 'near');
  const farId = insertChunk(db, meetingId, 1, 'far');

  db.prepare('INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding) VALUES (?, ?, ?)').run(
    nearId,
    meetingId,
    toVectorBlob([1, 0, 0, 0]),
  );
  db.prepare('INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding) VALUES (?, ?, ?)').run(
    farId,
    meetingId,
    toVectorBlob([0, 1, 0, 0]),
  );

  const hits = cosineQuery(db, meetingId, [1, 0, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].chunkId, nearId);
  assert.ok(Math.abs(hits[0].distance) < 1e-6);
  assert.ok(hits[0].distance < hits[1].distance);
});

test('chunk insert and delete keep chunks_fts in sync', () => {
  db = openMigratedMemoryDb();
  const meetingId = insertMeeting(db);
  const chunkId = insertChunk(db, meetingId, 0, 'yesterday standup notes');

  const afterInsert = db
    .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'standup'`)
    .get() as { n: number };
  assert.equal(afterInsert.n, 1);

  db.prepare('DELETE FROM chunks WHERE id = ?').run(chunkId);

  const afterDelete = db
    .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'standup'`)
    .get() as { n: number };
  assert.equal(afterDelete.n, 0);
});
