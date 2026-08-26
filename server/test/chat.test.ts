import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { INSERT_BATCH_SIZE } from '../src/db/batch.ts';
import { ingestTranscript } from '../src/ingest/pipeline.ts';
import type { ChatMessage, Llm } from '../src/llm/types.ts';
import { reindexMeeting } from '../src/rag/chat.ts';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CHAT_MODEL',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'DATABASE_PATH',
  'FULL_CONTEXT_CHAR_THRESHOLD',
  'RETRIEVE_K',
  'FTS_K',
  'CHAT_HISTORY_TURNS',
  'PORT',
] as const;

const baseline = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  CHAT_MODEL: 'gpt-5-mini',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: '4',
  DATABASE_PATH: ':memory:',
  FULL_CONTEXT_CHAR_THRESHOLD: '24000',
  RETRIEVE_K: '8',
  FTS_K: '8',
  CHAT_HISTORY_TURNS: '8',
  PORT: '3000',
} as const;

const envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let app: FastifyInstance | undefined;
let db: DatabaseSync | undefined;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    process.env[key] = value;
  }
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
  for (const key of ENV_KEYS) {
    const previous = envSnapshot[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

function unitVectors(count: number, dimensions: number): number[][] {
  return Array.from({ length: count }, (_, index) => {
    const vector = Array.from({ length: dimensions }, () => 0);
    vector[index % dimensions] = 1;
    return vector;
  });
}

type FakeLlmOptions = {
  embedDocuments?: Llm['embedDocuments'];
  streamChat?: Llm['streamChat'];
};

function fakeLlm(options: FakeLlmOptions = {}): Llm {
  return {
    embedDocuments: options.embedDocuments ?? (async (texts) => unitVectors(texts.length, 4)),
    embedQueries: async () => [[1, 0, 0, 0]],
    completeJson: async () => '{"decisions":[],"actionItems":[]}',
    streamChat:
      options.streamChat ??
      async function* () {
        yield 'Hello';
        yield ' world';
      },
  };
}

async function openTestApp(llm: Llm) {
  db = openDb(':memory:');
  migrate(db);
  app = await buildApp({ logger: false, db, llm });
  return { app, db };
}

const embedConfig = {
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 4,
};

async function seedMeeting(database: DatabaseSync, llm: Llm, title: string, rawText: string) {
  return ingestTranscript(database, llm, embedConfig, {
    title,
    filename: `${title}.txt`,
    rawText,
  });
}

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) {
      continue;
    }
    events.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)),
    });
  }
  return events;
}

async function chat(instance: FastifyInstance, id: number, message: unknown) {
  return instance.inject({
    method: 'POST',
    url: `/api/meetings/${id}/chat`,
    headers: { 'content-type': 'application/json' },
    payload: { message },
  });
}

test('empty chat message returns 400', async () => {
  const llm = fakeLlm();
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  const res = await chat(instance, meetingId, '');
  assert.equal(res.statusCode, 400);
});

test('whitespace chat message returns 400', async () => {
  const llm = fakeLlm();
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  const res = await chat(instance, meetingId, '   ');
  assert.equal(res.statusCode, 400);
});

test('unknown meeting id returns 404', async () => {
  const { app: instance } = await openTestApp(fakeLlm());
  const res = await chat(instance, 99999, 'What happened?');
  assert.equal(res.statusCode, 404);
});

test('non-numeric meeting id returns 400', async () => {
  const { app: instance } = await openTestApp(fakeLlm());
  const res = await instance.inject({
    method: 'POST',
    url: '/api/meetings/abc/chat',
    headers: { 'content-type': 'application/json' },
    payload: { message: 'What happened?' },
  });
  assert.equal(res.statusCode, 400);
});

test('chat against a non-ready meeting returns 409', async () => {
  const { app: instance, db: database } = await openTestApp(fakeLlm());
  const inserted = database
    .prepare(
      `INSERT INTO meetings (title, original_filename, raw_text, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run('Broken', 'broken.txt', 'raw', 'error');
  const res = await chat(instance, Number(inserted.lastInsertRowid), 'What happened?');
  assert.equal(res.statusCode, 409);
});

test('chat streams tokens and persists user then assistant messages', async () => {
  const llm = fakeLlm();
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  const res = await chat(instance, meetingId, 'Who spoke first?');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);
  assert.match(res.headers['content-type'] ?? '', /charset=utf-8/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.headers['connection'], 'keep-alive');
  const events = parseSse(res.body);
  assert.ok(events.some((event) => event.event === 'token'));
  const streamed = events
    .filter((event) => event.event === 'token')
    .map((event) => (event.data as { text: string }).text)
    .join('');
  assert.equal(streamed, 'Hello world');

  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  assert.equal(history.statusCode, 200);
  const body = history.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content, 'Who spoke first?');
  assert.equal(body.messages[1]?.role, 'assistant');
  assert.equal(body.messages[1]?.content, 'Hello world');
});

function chunkTexts(database: DatabaseSync, meetingId: number): string[] {
  return (
    database.prepare('SELECT text FROM chunks WHERE meeting_id = ?').all(meetingId) as Array<{
      text: string;
    }>
  ).map((row) => row.text);
}

// Retrieval is scoped by meeting, and the prompt is where a leak would do damage, so the
// assertion is on the excerpts the model actually saw rather than on any side channel.
test('chat against meeting A prompts with no chunk from meeting B', async () => {
  process.env.FULL_CONTEXT_CHAR_THRESHOLD = '0';
  const prompts: ChatMessage[][] = [];
  const llm = fakeLlm({
    streamChat: async function* (messages) {
      prompts.push(messages);
      yield 'Hello';
      yield ' world';
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const a = await seedMeeting(database, llm, 'A', '[00:00:01] Ada: Project Phoenix ships Friday');
  const b = await seedMeeting(database, llm, 'B', '[00:00:01] Omar: Project Zephyr is cancelled');

  const res = await chat(instance, a.meetingId, 'What ships Friday?');
  assert.equal(res.statusCode, 200);
  const context = parseSse(res.body).find((event) => event.event === 'context');
  assert.ok(context);
  assert.equal((context.data as { useFullTranscript: boolean }).useFullTranscript, false);

  const asked = prompts[0]?.at(-1)?.content ?? '';
  assert.ok(chunkTexts(database, a.meetingId).some((text) => asked.includes(text)));
  assert.ok(chunkTexts(database, b.meetingId).every((text) => !asked.includes(text)));
  assert.doesNotMatch(JSON.stringify(prompts), /Zephyr/);
});

test('chat reindexes when stored embedding model does not match config', async () => {
  process.env.FULL_CONTEXT_CHAR_THRESHOLD = '0';
  let embedCalls = 0;
  const llm = fakeLlm({
    embedDocuments: async (texts) => {
      embedCalls += 1;
      return unitVectors(texts.length, 4);
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  const afterIngest = embedCalls;
  database
    .prepare('UPDATE meetings SET embedding_model = ? WHERE id = ?')
    .run('old-model', meetingId);

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  assert.ok(embedCalls > afterIngest);

  const meeting = database
    .prepare('SELECT embedding_model, embedding_dimensions FROM meetings WHERE id = ?')
    .get(meetingId) as { embedding_model: string; embedding_dimensions: number };
  assert.equal(meeting.embedding_model, 'text-embedding-3-small');
  assert.equal(meeting.embedding_dimensions, 4);

  const counts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM chunks WHERE meeting_id = ?) AS chunks,
         (SELECT COUNT(*) FROM chunk_embeddings WHERE meeting_id = ?) AS embeddings`,
    )
    .get(meetingId, meetingId) as { chunks: number; embeddings: number };
  assert.equal(counts.embeddings, counts.chunks);
});

test('full-transcript chat skips reindex when embeddings are stale', async () => {
  let embedCalls = 0;
  const llm = fakeLlm({
    embedDocuments: async (texts) => {
      embedCalls += 1;
      return unitVectors(texts.length, 4);
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  const afterIngest = embedCalls;
  database
    .prepare('UPDATE meetings SET embedding_model = ? WHERE id = ?')
    .run('old-model', meetingId);

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  assert.equal(embedCalls, afterIngest);
  const context = parseSse(res.body).find((event) => event.event === 'context');
  assert.ok(context);
  assert.equal((context.data as { useFullTranscript: boolean }).useFullTranscript, true);
});

test('full-transcript prompt renders turns as copyable citations', async () => {
  const prompts: ChatMessage[][] = [];
  const llm = fakeLlm({
    streamChat: async function* (messages) {
      prompts.push(messages);
      yield 'ok';
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  const system = prompts[0]?.find((message) => message.role === 'system')?.content ?? '';
  assert.match(system, /\[Ada, 00:00:01\]: hello/);
  assert.doesNotMatch(system, /\[00:00:01\] Ada:/);
});

test('stream failure persists partial answer and hides internal errors', async () => {
  const llm = fakeLlm({
    streamChat: async function* () {
      yield 'Hello';
      throw new Error('OPENAI_API_KEY sk-secret-123 rejected');
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  const events = parseSse(res.body);
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.doesNotMatch(JSON.stringify(errorEvent.data), /sk-secret/);
  assert.equal((errorEvent.data as { error: string }).error, 'failed to generate answer');

  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  const body = history.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[1]?.role, 'assistant');
  assert.equal(body.messages[1]?.content, 'Hello');
});

test('empty model stream does not persist an assistant message', async () => {
  const llm = fakeLlm({
    streamChat: async function* () {
      // Model returned no tokens.
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  const errorEvent = parseSse(res.body).find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.equal((errorEvent.data as { error: string }).error, 'failed to generate answer');

  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  const body = history.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
});

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => reject(new Error('disconnect signal did not abort')), 5_000);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

async function abortLiveChat(instance: FastifyInstance, meetingId: number): Promise<void> {
  const origin = await instance.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/meetings/${meetingId}/chat`, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Who spoke?' }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  controller.abort();
  await reader.read().catch(() => undefined);
}

test('stream abort persists the user message but not a partial assistant reply', async () => {
  const llm = fakeLlm({
    streamChat: async function* () {
      yield 'Hello';
      throw abortError();
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 200);
  const events = parseSse(res.body);
  assert.equal(
    events.some((event) => event.event === 'error'),
    false,
  );

  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  const body = history.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content, 'Who spoke?');
});

test('HTTP client abort persists the user message but not a partial assistant reply', async () => {
  const llm = fakeLlm({
    streamChat: async function* (_messages, signal) {
      yield 'Hello';
      await waitForAbort(signal);
      yield ' world';
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  await abortLiveChat(instance, meetingId);
  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  const body = history.json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content, 'Who spoke?');
});

test('abort during reindex does not persist a user message', async () => {
  process.env.FULL_CONTEXT_CHAR_THRESHOLD = '0';
  let embedStarted = false;
  const llm = fakeLlm({
    embedDocuments: async (texts) => {
      if (embedStarted) {
        throw abortError();
      }
      return unitVectors(texts.length, 4);
    },
  });
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  database
    .prepare('UPDATE meetings SET embedding_model = ? WHERE id = ?')
    .run('old-model', meetingId);
  embedStarted = true;

  const res = await chat(instance, meetingId, 'Who spoke?');
  assert.equal(res.statusCode, 204);

  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  const body = history.json() as { messages: unknown[] };
  assert.equal(body.messages.length, 0);
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

test('reindexMeeting keeps embeddings that spill past a 100-row batch', async () => {
  db = openDb(':memory:');
  migrate(db);
  const llm = fakeLlm();
  const rowCount = INSERT_BATCH_SIZE + 1;
  const { meetingId } = await ingestTranscript(db, llm, embedConfig, {
    title: 'Long',
    filename: 'long.txt',
    rawText: oversizedTurnsTranscript(rowCount),
  });
  db.prepare('UPDATE meetings SET embedding_model = ? WHERE id = ?').run('old-model', meetingId);

  await reindexMeeting(db, llm, embedConfig, meetingId);

  const meeting = db
    .prepare('SELECT embedding_model, embedding_dimensions FROM meetings WHERE id = ?')
    .get(meetingId) as { embedding_model: string; embedding_dimensions: number };
  assert.equal(meeting.embedding_model, embedConfig.embeddingModel);
  assert.equal(meeting.embedding_dimensions, embedConfig.embeddingDimensions);

  const chunks = db
    .prepare(`SELECT id FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint }>;
  const embeddings = db
    .prepare(`SELECT chunk_id FROM chunk_embeddings WHERE meeting_id = ?`)
    .all(meetingId) as Array<{ chunk_id: number | bigint }>;
  assert.equal(chunks.length, rowCount);
  assert.deepEqual(
    embeddings.map((row) => Number(row.chunk_id)).sort((a, b) => a - b),
    chunks.map((chunk) => Number(chunk.id)),
  );
});
