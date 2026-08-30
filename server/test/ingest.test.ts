import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { fromVectorBlob } from '../src/db/client.ts';
import { INSERT_BATCH_SIZE } from '../src/db/batch.ts';
import { ingestTranscript } from '../src/ingest/pipeline.ts';
import { EmbeddingDimensionError } from '../src/llm/embed.ts';
import type { Llm } from '../src/llm/types.ts';
import { ParseError } from '../src/transcript/parse.ts';
import {
  abortError,
  embedConfig,
  fakeLlm,
  numberedTurns,
  openMigratedMemoryDb,
  transcriptText,
  unitVectors,
  unused,
} from './helpers.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');
const oneTurn = '[00:00:01] Ada: hello';

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function ingestLlm(
  embed: Llm['embed'],
  completeJson: Llm['completeJson'] = async () => '{"decisions":[],"actionItems":[]}',
): Llm {
  return fakeLlm({ embed, completeJson, streamChat: unused });
}

function count(database: DatabaseSync, sql: string, param?: number): number {
  const row = (
    param === undefined ? database.prepare(sql).get() : database.prepare(sql).get(param)
  ) as { n: number };
  return row.n;
}

test('standup fixture ingest creates turns, chunks, embeddings, and status ready', async () => {
  db = openMigratedMemoryDb();
  const rawText = readFileSync(standupPath, 'utf8');
  let extractCalled = false;
  const llm = ingestLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => {
      extractCalled = true;
      return '{"decisions":[],"actionItems":[]}';
    },
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Standup',
    rawText,
  });

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as {
    title: string;
    status: string;
    char_count: number;
    embedding_model: string;
    embedding_dimensions: number;
  };
  assert.equal(meeting.title, 'Standup');
  assert.equal(meeting.status, 'ready');
  assert.equal(meeting.char_count, rawText.length);
  assert.equal(meeting.embedding_model, embedConfig.embeddingModel);
  assert.equal(meeting.embedding_dimensions, embedConfig.embeddingDimensions);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?', meetingId), 15);
  const chunks = db
    .prepare(`SELECT id, chunk_index, text FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint; chunk_index: number; text: string }>;
  assert.equal(chunks.length, 1);
  assert.ok(
    chunks[0].text.includes('[Ada, 00:00:03]: Morning, I am shipping the health endpoint today.'),
  );

  const embeddings = db
    .prepare(`SELECT chunk_id, embedding FROM chunk_embeddings WHERE meeting_id = ?`)
    .all(meetingId) as Array<{ chunk_id: number | bigint; embedding: Uint8Array }>;
  assert.equal(embeddings.length, 1);
  assert.equal(Number(embeddings[0].chunk_id), Number(chunks[0].id));
  assert.deepEqual([...fromVectorBlob(embeddings[0].embedding)], [1, 0, 0, 0]);
  assert.equal(
    count(db, `SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'health'`),
    1,
  );
  assert.equal(extractCalled, true);
});

test('parse failure throws ParseError and does not create a meeting', async () => {
  db = openMigratedMemoryDb();
  let embedCalled = false;
  const llm = ingestLlm(async () => {
    embedCalled = true;
    return [];
  });

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Garbage',
        rawText: 'not a transcript\nat all',
      }),
    ParseError,
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
  assert.equal(embedCalled, false);
});

test('embedding mismatch deletes the meeting instead of leaving it in error', async () => {
  db = openMigratedMemoryDb();
  const llm = ingestLlm(async (texts) => texts.map(() => [1, 0, 0]));

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        rawText: oneTurn,
      }),
    EmbeddingDimensionError,
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM turns'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM chunks'), 0);
});

test('abort during embed deletes the meeting', async () => {
  db = openMigratedMemoryDb();
  const llm = ingestLlm(async () => {
    throw abortError();
  });

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        rawText: oneTurn,
      }),
    { name: 'AbortError' },
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
});

test('abort after facts are stored still deletes the meeting', async () => {
  db = openMigratedMemoryDb();
  const controller = new AbortController();
  const llm = ingestLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => {
      controller.abort();
      return JSON.stringify({
        decisions: [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }],
        actionItems: [],
      });
    },
  );

  await assert.rejects(
    () =>
      ingestTranscript(
        db!,
        llm,
        embedConfig,
        { title: 'Short', rawText: oneTurn },
        controller.signal,
      ),
    { name: 'AbortError' },
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM decisions'), 0);
});

test('valid extract JSON inserts decisions and action items and stays ready', async () => {
  db = openMigratedMemoryDb();
  const llm = ingestLlm(
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

  const actionItems = db
    .prepare(`SELECT text, owner, due, timestamp FROM action_items WHERE meeting_id = ?`)
    .all(meetingId) as Array<{
    text: string;
    owner: string | null;
    due: string | null;
    timestamp: string;
  }>;
  assert.equal(actionItems.length, 2);
  assert.equal(actionItems[0].owner, 'Ben');
  assert.equal(actionItems[1].owner, null);
});

test('turns, chunks, and embeddings keep rows that spill past a 100-row batch', async () => {
  db = openMigratedMemoryDb();
  const rowCount = INSERT_BATCH_SIZE + 1;
  const llm = ingestLlm(async (texts) =>
    unitVectors(texts.length, embedConfig.embeddingDimensions),
  );

  // Each turn is longer than DEFAULT_MAX_CHARS, so it becomes its own chunk and every
  // derived table has to survive the same batched insert.
  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Long',
    rawText: transcriptText(numberedTurns(rowCount, 'x'.repeat(1800))),
  });

  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?', meetingId),
    rowCount,
  );
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', meetingId),
    rowCount,
  );
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM chunk_embeddings WHERE meeting_id = ?', meetingId),
    rowCount,
  );
});

test('malformed extract JSON leaves meeting ready with zero facts', async () => {
  db = openMigratedMemoryDb();
  const llm = ingestLlm(
    async (texts) => unitVectors(texts.length, embedConfig.embeddingDimensions),
    async () => '<<<',
  );

  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Short',
    rawText: oneTurn,
  });

  const meeting = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId) as {
    status: string;
  };
  assert.equal(meeting.status, 'ready');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?', meetingId), 0);
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM action_items WHERE meeting_id = ?', meetingId),
    0,
  );
});

test('embed failure aborts in-flight fact extraction', async () => {
  db = openMigratedMemoryDb();
  let extractAborted = false;
  const llm = ingestLlm(
    async () => {
      throw new EmbeddingDimensionError(3, embedConfig.embeddingDimensions);
    },
    async (_messages, signal) => {
      await new Promise<void>((_resolve, reject) => {
        const fail = () => {
          extractAborted = true;
          reject(abortError());
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
      return '{"decisions":[],"actionItems":[]}';
    },
  );

  await assert.rejects(
    () =>
      ingestTranscript(db!, llm, embedConfig, {
        title: 'Short',
        rawText: oneTurn,
      }),
    EmbeddingDimensionError,
  );
  assert.equal(extractAborted, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM meetings'), 0);
});
