import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function openMigratedMemoryDb() {
  const opened = new DatabaseSync(':memory:');
  opened.exec('PRAGMA foreign_keys = ON');
  migrate(opened);
  return opened;
}

function insertMeeting(database: DatabaseSync): number {
  const result = database
    .prepare(
      `INSERT INTO meetings (title, original_filename, raw_text, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run('Standup', 'standup.txt', 'raw transcript', 'processing');
  return Number(result.lastInsertRowid);
}

test('migrate is idempotent and sets user_version to 1', () => {
  const opened = new DatabaseSync(':memory:');
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
