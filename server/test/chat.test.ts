import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { ingestTranscript } from '../src/ingest/pipeline.ts';
import type { ChatMessage, Llm } from '../src/llm/types.ts';
import {
  abortError,
  embedConfig,
  fakeLlm,
  openMigratedMemoryDb,
  unitVectors,
  useTestEnv,
  waitForAbort,
} from './helpers.ts';

useTestEnv();

let app: FastifyInstance | undefined;
let db: DatabaseSync | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
});

async function openTestApp(llm: Llm) {
  db = openMigratedMemoryDb();
  app = await buildApp({ logger: false, db, llm });
  return { app, db };
}

async function seedMeeting(database: DatabaseSync, llm: Llm, title: string, rawText: string) {
  return ingestTranscript(database, llm, embedConfig, { title, rawText });
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

async function messages(instance: FastifyInstance, meetingId: number) {
  const history = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${meetingId}/messages`,
  });
  return history.json() as { messages: Array<{ role: string; content: string }> };
}

test('empty or whitespace chat message returns 400', async () => {
  const llm = fakeLlm();
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  assert.equal((await chat(instance, meetingId, '')).statusCode, 400);
  assert.equal((await chat(instance, meetingId, '   ')).statusCode, 400);
});

test('unknown or non-numeric meeting id is rejected', async () => {
  const { app: instance } = await openTestApp(fakeLlm());
  assert.equal((await chat(instance, 99999, 'What happened?')).statusCode, 404);
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
    .prepare(`INSERT INTO meetings (title, status) VALUES (?, ?)`)
    .run('Broken', 'processing');
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
  assert.equal(res.headers['x-accel-buffering'], 'no');
  const events = parseSse(res.body);
  assert.ok(events.some((event) => event.event === 'token'));
  assert.ok(events.some((event) => event.event === 'done'));
  const streamed = events
    .filter((event) => event.event === 'token')
    .map((event) => (event.data as { text: string }).text)
    .join('');
  assert.equal(streamed, 'Hello world');

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content, 'Who spoke first?');
  assert.equal(body.messages[1]?.role, 'assistant');
  assert.equal(body.messages[1]?.content, 'Hello world');
});

test('assistant persist failure still sends done and keeps the user message', async () => {
  const llm = fakeLlm();
  const { app: instance, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');
  database.exec(`
    CREATE TRIGGER fail_assistant BEFORE INSERT ON messages
    WHEN new.role = 'assistant'
    BEGIN
      SELECT RAISE(ABORT, 'nope');
    END;
  `);

  const res = await chat(instance, meetingId, 'Who spoke first?');
  assert.equal(res.statusCode, 200);
  const events = parseSse(res.body);
  assert.ok(events.some((event) => event.event === 'done'));
  assert.equal(
    events.some((event) => event.event === 'error'),
    false,
  );

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
});

// History rows come back from node:sqlite as null-prototype objects, so rebuild them
// as plain ones to keep deepEqual focused on the role/content pairs the model sees.
function askedTurns(prompt: ChatMessage[] | undefined): ChatMessage[] {
  return (prompt ?? [])
    .filter((message) => message.role !== 'system')
    .map(({ role, content }) => ({ role, content }));
}

test('prior turns reach the prompt oldest-first unless CHAT_HISTORY_TURNS is 0', async () => {
  const prompts: ChatMessage[][] = [];
  const llm = fakeLlm({
    streamChat: async function* (messages) {
      prompts.push(messages);
      yield 'Hello';
      yield ' world';
    },
  });
  const { app: withHistory, db: database } = await openTestApp(llm);
  const { meetingId } = await seedMeeting(database, llm, 'Short', '[00:00:01] Ada: hello');

  assert.equal((await chat(withHistory, meetingId, 'Who spoke first?')).statusCode, 200);
  assert.equal((await chat(withHistory, meetingId, 'What did we cover?')).statusCode, 200);
  assert.deepEqual(askedTurns(prompts[1]), [
    { role: 'user', content: 'Who spoke first?' },
    { role: 'assistant', content: 'Hello world' },
    { role: 'user', content: 'What did we cover?' },
  ]);

  // Config is read once per app, so each setting needs a fresh app over the same rows.
  // SQLite reads a negative LIMIT as unbounded, so -1 has to be refused before the query.
  await withHistory.close();
  for (const turns of ['0', '-1']) {
    process.env.CHAT_HISTORY_TURNS = turns;
    app = await buildApp({ logger: false, db: database, llm });
    prompts.length = 0;

    assert.equal((await chat(app, meetingId, 'And after that?')).statusCode, 200);
    assert.deepEqual(
      askedTurns(prompts[0]),
      [{ role: 'user', content: 'And after that?' }],
      `CHAT_HISTORY_TURNS=${turns} leaked prior turns`,
    );
    await app.close();
  }
  app = undefined;
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
    embed: async (texts) => {
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
});

test('full-transcript chat skips reindex when embeddings are stale', async () => {
  let embedCalls = 0;
  const llm = fakeLlm({
    embed: async (texts) => {
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
  const errorEvent = parseSse(res.body).find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.doesNotMatch(JSON.stringify(errorEvent.data), /sk-secret/);
  assert.equal((errorEvent.data as { error: string }).error, 'failed to generate answer');

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 2);
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

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
});

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

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
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
  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, 'user');
});

test('abort during reindex does not persist a user message', async () => {
  process.env.FULL_CONTEXT_CHAR_THRESHOLD = '0';
  let embedStarted = false;
  const llm = fakeLlm({
    embed: async (texts) => {
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

  const body = await messages(instance, meetingId);
  assert.equal(body.messages.length, 0);
});
