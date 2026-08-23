import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { fromVectorBlob, openDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestTranscript } from '../src/ingest/pipeline.ts';
import { EmbeddingDimensionError } from '../src/llm/embed.ts';
import type { Llm } from '../src/llm/types.ts';
import { ParseError } from '../src/transcript/parse.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');
const oneTurn = '[00:00:01] Ada: hello';

const embedConfig = {
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 4,
};

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

function unitVectors(count: number, dimensions: number): number[][] {
  return Array.from({ length: count }, (_, index) => {
    const vector = Array.from({ length: dimensions }, () => 0);
    vector[index % dimensions] = 1;
    return vector;
  });
}

function unused(): never {
  throw new Error('not used in ingest');
}

function emptyFactsJson(): string {
  return '{"decisions":[],"actionItems":[]}';
}

function fakeLlm(
  embedDocuments: Llm['embedDocuments'],
  completeJson: Llm['completeJson'] = async () => emptyFactsJson(),
): Llm {
  return {
    embedDocuments,
    embedQueries: unused,
    completeJson,
    streamChat: unused,
  };
}

function count(database: DatabaseSync, sql: string, param?: number): number {
  const row = (
    param === undefined ? database.prepare(sql).get() : database.prepare(sql).get(param)
  ) as { n: number };
  return row.n;
}

function derivedRowCounts(database: DatabaseSync, meetingId: number) {
  return {
    turns: count(database, 'SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?', meetingId),
    chunks: count(database, 'SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', meetingId),
    embeddings: count(
      database,
      'SELECT COUNT(*) AS n FROM chunk_embeddings WHERE meeting_id = ?',
      meetingId,
    ),
    fts: count(database, 'SELECT COUNT(*) AS n FROM chunks_fts'),
    decisions: count(
      database,
      'SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?',
      meetingId,
    ),
    actionItems: count(
      database,
      'SELECT COUNT(*) AS n FROM action_items WHERE meeting_id = ?',
      meetingId,
    ),
  };
}

type MeetingRow = {
  id: number | bigint;
  title: string;
  original_filename: string;
  raw_text: string;
  status: string;
  error_message: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  char_count: number;
};

test('standup fixture ingest creates turns, chunks, embeddings, and status ready', async () => {
  db = openMigratedMemoryDb();
  const rawText = readFileSync(standupPath, 'utf8');
  let extractCalled = false;
  const llm = fakeLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => {
      extractCalled = true;
      return emptyFactsJson();
    },
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Standup',
    filename: 'standup.txt',
    rawText,
  });

  assert.equal(typeof meetingId, 'number');
  assert.ok(meetingId > 0);

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as MeetingRow;
  assert.equal(meeting.title, 'Standup');
  assert.equal(meeting.original_filename, 'standup.txt');
  assert.equal(meeting.raw_text, rawText);
  assert.equal(meeting.status, 'ready');
  assert.equal(meeting.error_message, null);
  assert.equal(meeting.char_count, rawText.length);
  assert.equal(meeting.embedding_model, embedConfig.embeddingModel);
  assert.equal(meeting.embedding_dimensions, embedConfig.embeddingDimensions);

  const turns = db
    .prepare(`SELECT turn_index, speaker FROM turns WHERE meeting_id = ? ORDER BY turn_index`)
    .all(meetingId) as Array<{ turn_index: number; speaker: string }>;
  assert.equal(turns.length, 15);
  assert.deepEqual(
    turns.map((turn) => turn.turn_index),
    Array.from({ length: 15 }, (_, index) => index),
  );
  const speakers = new Set(turns.map((turn) => turn.speaker));
  assert.ok(speakers.has('Ada'));
  assert.ok(speakers.has('Ben'));
  assert.ok(speakers.has('Chen'));

  const chunks = db
    .prepare(`SELECT id, chunk_index, text FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint; chunk_index: number; text: string }>;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
  assert.ok(chunks[0].text.includes('Ada: Morning, I am shipping the health endpoint today.'));

  const embeddings = db
    .prepare(`SELECT chunk_id, embedding FROM chunk_embeddings WHERE meeting_id = ?`)
    .all(meetingId) as Array<{ chunk_id: number | bigint; embedding: Uint8Array }>;
  assert.equal(embeddings.length, 1);
  assert.equal(Number(embeddings[0].chunk_id), Number(chunks[0].id));
  const vector = fromVectorBlob(embeddings[0].embedding);
  assert.equal(vector.length, 4);
  assert.deepEqual([...vector], [1, 0, 0, 0]);

  assert.equal(
    count(db, `SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'health'`),
    1,
  );
  assert.equal(extractCalled, true);
  assert.equal(derivedRowCounts(db, meetingId).decisions, 0);
  assert.equal(derivedRowCounts(db, meetingId).actionItems, 0);
});

test('parse failure throws ParseError and does not create a meeting', async () => {
  db = openMigratedMemoryDb();
  let embedCalled = false;
  const llm = fakeLlm(async () => {
    embedCalled = true;
    return [];
  });

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Garbage',
        filename: 'garbage.txt',
        rawText: 'not a transcript\nat all',
      }),
    ParseError,
  );

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
  assert.equal(embedCalled, false);
});

test('meeting is processing while embeddings are requested', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(async (texts) => {
    const row = db!.prepare('SELECT status FROM meetings').get() as { status: string };
    assert.equal(row.status, 'processing');
    return unitVectors(texts.length, embedConfig.embeddingDimensions);
  });

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Short',
    filename: 'short.txt',
    rawText: oneTurn,
  });

  const row = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId) as {
    status: string;
  };
  assert.equal(row.status, 'ready');
});

test('embedding length mismatch deletes the meeting instead of leaving it in error', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(async (texts) => texts.map(() => [1, 0, 0]));

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        filename: 'short.txt',
        rawText: oneTurn,
      }),
    EmbeddingDimensionError,
  );

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM turns'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM chunks'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM chunk_embeddings'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM chunks_fts'), 0);
});

test('embedding count mismatch deletes the meeting instead of leaving it in error', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(async () => []);

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        filename: 'short.txt',
        rawText: oneTurn,
      }),
    /Expected 1 embeddings, got 0/,
  );

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
});

test('abort during embed deletes the meeting instead of leaving it in error', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        filename: 'short.txt',
        rawText: oneTurn,
      }),
    { name: 'AbortError' },
  );

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
});

test('abort during fact extraction keeps a ready meeting', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  );

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        filename: 'short.txt',
        rawText: oneTurn,
      }),
    { name: 'AbortError' },
  );

  const meetings = db.prepare('SELECT id, status FROM meetings').all() as Array<{
    id: number | bigint;
    status: string;
  }>;
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].status, 'ready');
  assert.deepEqual(derivedRowCounts(db, Number(meetings[0].id)), {
    turns: 1,
    chunks: 1,
    embeddings: 1,
    fts: 1,
    decisions: 0,
    actionItems: 0,
  });
});

test('valid extract JSON inserts decisions and action items and stays ready', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () =>
      JSON.stringify({
        decisions: [{ text: 'Ship health', speaker: 'Ada', timestamp: '00:00:01' }],
        actionItems: [
          { text: 'Review PR', owner: 'Ben', due: 'Tuesday', timestamp: '00:00:01' },
          { text: 'Follow up', timestamp: '00:00:01' },
        ],
      }),
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Short',
    filename: 'short.txt',
    rawText: oneTurn,
  });

  const meeting = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId) as {
    status: string;
  };
  assert.equal(meeting.status, 'ready');

  const decisions = db
    .prepare(`SELECT text, speaker, timestamp FROM decisions WHERE meeting_id = ?`)
    .all(meetingId) as Array<{ text: string; speaker: string; timestamp: string }>;
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].text, 'Ship health');
  assert.equal(decisions[0].speaker, 'Ada');
  assert.equal(decisions[0].timestamp, '00:00:01');

  const actionItems = db
    .prepare(`SELECT text, owner, due, timestamp FROM action_items WHERE meeting_id = ?`)
    .all(meetingId) as Array<{
    text: string;
    owner: string | null;
    due: string | null;
    timestamp: string;
  }>;
  assert.equal(actionItems.length, 2);
  assert.equal(actionItems[0].text, 'Review PR');
  assert.equal(actionItems[0].owner, 'Ben');
  assert.equal(actionItems[0].due, 'Tuesday');
  assert.equal(actionItems[0].timestamp, '00:00:01');
  assert.equal(actionItems[1].text, 'Follow up');
  assert.equal(actionItems[1].owner, null);
  assert.equal(actionItems[1].due, null);
  assert.equal(actionItems[1].timestamp, '00:00:01');
});

function oversizedTurnsTranscript(count: number): string {
  const body = 'x'.repeat(1800);
  return Array.from({ length: count }, (_, index) => {
    const hours = String(Math.floor(index / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((index % 3600) / 60)).padStart(2, '0');
    const seconds = String(index % 60).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}] Ada: ${body}`;
  }).join('\n');
}

test('turns, chunks, and embeddings keep rows that spill past a 100-row batch', async () => {
  db = openMigratedMemoryDb();
  const rowCount = 101;
  const llm = fakeLlm(async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions));

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Long',
    filename: 'long.txt',
    rawText: oversizedTurnsTranscript(rowCount),
  });

  assert.deepEqual(derivedRowCounts(db, meetingId), {
    turns: rowCount,
    chunks: rowCount,
    embeddings: rowCount,
    fts: rowCount,
    decisions: 0,
    actionItems: 0,
  });

  const chunks = db
    .prepare(`SELECT id, chunk_index FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint; chunk_index: number }>;
  const embeddings = db
    .prepare(`SELECT chunk_id FROM chunk_embeddings WHERE meeting_id = ?`)
    .all(meetingId) as Array<{ chunk_id: number | bigint }>;
  assert.deepEqual(
    chunks.map((chunk) => chunk.chunk_index),
    Array.from({ length: rowCount }, (_, index) => index),
  );
  assert.deepEqual(
    embeddings.map((row) => Number(row.chunk_id)).sort((a, b) => a - b),
    chunks.map((chunk) => Number(chunk.id)),
  );
});

test('fact inserts keep rows that spill past a 100-row batch', async () => {
  db = openMigratedMemoryDb();
  const decisionCount = 101;
  const llm = fakeLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () =>
      JSON.stringify({
        decisions: Array.from({ length: decisionCount }, (_, index) => ({
          text: `Decision ${index}`,
          speaker: 'Ada',
          timestamp: '00:00:01',
        })),
        actionItems: [],
      }),
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Short',
    filename: 'short.txt',
    rawText: oneTurn,
  });

  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?', meetingId),
    decisionCount,
  );
});

test('malformed extract JSON leaves meeting ready with zero facts', async () => {
  db = openMigratedMemoryDb();
  const llm = fakeLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => '<<<',
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Short',
    filename: 'short.txt',
    rawText: oneTurn,
  });

  const meeting = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId) as {
    status: string;
  };
  assert.equal(meeting.status, 'ready');
  assert.deepEqual(derivedRowCounts(db, meetingId), {
    turns: 1,
    chunks: 1,
    embeddings: 1,
    fts: 1,
    decisions: 0,
    actionItems: 0,
  });
});
