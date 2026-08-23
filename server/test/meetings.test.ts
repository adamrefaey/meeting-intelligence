import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import type { Llm } from '../src/llm/types.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');
const standupText = readFileSync(standupPath, 'utf8');

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

function unused(): never {
  throw new Error('not used in meetings tests');
}

function fakeLlm(): Llm {
  return {
    embedDocuments: async (texts) => unitVectors(texts.length, 4),
    embedQueries: unused,
    completeJson: async () => '{"decisions":[],"actionItems":[]}',
    streamChat: unused,
  };
}

async function openTestApp(llm: Llm = fakeLlm()) {
  db = openDb(':memory:');
  migrate(db);
  app = await buildApp({ logger: false, db, llm });
  return { app, db };
}

function txtForm(filename: string, content: string, title?: string, type = 'text/plain'): FormData {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  if (title !== undefined) {
    form.append('title', title);
  }
  return form;
}

async function upload(instance: FastifyInstance, form: FormData) {
  return instance.inject({ method: 'POST', url: '/api/meetings', payload: form });
}

test('upload fixture returns 201 with id and status ready', async () => {
  const { app: instance } = await openTestApp();
  const res = await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  assert.equal(res.statusCode, 201);
  const body = res.json() as { id: number; status: string };
  assert.equal(typeof body.id, 'number');
  assert.ok(body.id > 0);
  assert.equal(body.status, 'ready');
});

test('list has length 1 after upload and omits raw_text', async () => {
  const { app: instance } = await openTestApp();
  await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  const res = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  assert.equal(body[0]?.title, 'Standup');
  assert.equal('raw_text' in body[0], false);
});

test('get meeting includes decisions and actionItems; transcript has 15 turns', async () => {
  const { app: instance } = await openTestApp();
  const created = await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  const { id } = created.json() as { id: number };

  const meetingRes = await instance.inject({ method: 'GET', url: `/api/meetings/${id}` });
  assert.equal(meetingRes.statusCode, 200);
  const meeting = meetingRes.json() as { decisions: unknown; actionItems: unknown };
  assert.ok(Array.isArray(meeting.decisions));
  assert.ok(Array.isArray(meeting.actionItems));
  assert.equal('raw_text' in meeting, false);

  const transcriptRes = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${id}/transcript`,
  });
  assert.equal(transcriptRes.statusCode, 200);
  const transcript = transcriptRes.json() as { turns: unknown[] };
  assert.equal(transcript.turns.length, 15);
});

test('unknown meeting id returns 404', async () => {
  const { app: instance } = await openTestApp();
  const res = await instance.inject({ method: 'GET', url: '/api/meetings/99999' });
  assert.equal(res.statusCode, 404);
  assert.equal(typeof (res.json() as { error: string }).error, 'string');
});

test('non-numeric meeting id returns 400', async () => {
  const { app: instance } = await openTestApp();
  const res = await instance.inject({ method: 'GET', url: '/api/meetings/abc' });
  assert.equal(res.statusCode, 400);
});

test('file field with a different name returns 400', async () => {
  const { app: instance } = await openTestApp();
  const form = new FormData();
  form.append('attachment', new Blob([standupText], { type: 'text/plain' }), 'standup.txt');
  const res = await upload(instance, form);
  assert.equal(res.statusCode, 400);
});

test('file over 5 MiB returns 413', async () => {
  const { app: instance } = await openTestApp();
  const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
  const res = await upload(instance, txtForm('huge.txt', oversized));
  assert.equal(res.statusCode, 413);
  assert.equal((res.json() as { error: string }).error, 'file too large');
});

test('non-txt filename returns 400', async () => {
  const { app: instance } = await openTestApp();
  const res = await upload(instance, txtForm('notes.md', standupText));
  assert.equal(res.statusCode, 400);
});

test('missing file field returns 400', async () => {
  const { app: instance } = await openTestApp();
  const form = new FormData();
  form.append('title', 'No File');
  const res = await upload(instance, form);
  assert.equal(res.statusCode, 400);
});

test('unparseable transcript returns 400 with parse error', async () => {
  const { app: instance } = await openTestApp();
  const res = await upload(instance, txtForm('garbage.txt', 'not a transcript\nat all'));
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /\[HH:MM:SS\] Speaker/);
});

test('delete returns 204 and cascades turns', async () => {
  const { app: instance, db: database } = await openTestApp();
  const created = await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  const { id } = created.json() as { id: number };

  const deleted = await instance.inject({ method: 'DELETE', url: `/api/meetings/${id}` });
  assert.equal(deleted.statusCode, 204);

  const missing = await instance.inject({ method: 'GET', url: `/api/meetings/${id}` });
  assert.equal(missing.statusCode, 404);

  const turns = database
    .prepare('SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?')
    .get(id) as {
    n: number;
  };
  assert.equal(turns.n, 0);
});

test('title defaults to the filename without .txt', async () => {
  const { app: instance } = await openTestApp();
  const created = await upload(instance, txtForm('standup.txt', standupText));
  assert.equal(created.statusCode, 201);
  const { id } = created.json() as { id: number };
  const meeting = await instance.inject({ method: 'GET', url: `/api/meetings/${id}` });
  assert.equal((meeting.json() as { title: string }).title, 'standup');
});

test('failed ingest returns 500 and does not leave a meeting', async () => {
  const llm: Llm = {
    embedDocuments: async () => {
      throw new Error('embed exploded');
    },
    embedQueries: unused,
    completeJson: unused,
    streamChat: unused,
  };
  const { app: instance } = await openTestApp(llm);
  const res = await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  assert.equal(res.statusCode, 500);
  assert.equal((res.json() as { error: string }).error, 'failed to ingest transcript');
  const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal((listed.json() as unknown[]).length, 0);
});

test('aborted ingest does not report 500', async () => {
  const llm: Llm = {
    embedDocuments: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
    embedQueries: unused,
    completeJson: unused,
    streamChat: unused,
  };
  const { app: instance } = await openTestApp(llm);
  const res = await upload(instance, txtForm('standup.txt', standupText, 'Standup'));
  assert.equal(res.statusCode, 204);
  const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal((listed.json() as unknown[]).length, 0);
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

test('HTTP client abort during ingest does not leave a meeting', async () => {
  let started!: () => void;
  const embedStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const llm: Llm = {
    embedDocuments: async (_texts, signal) => {
      started();
      await waitForAbort(signal);
      return unitVectors(_texts.length, 4);
    },
    embedQueries: unused,
    completeJson: unused,
    streamChat: unused,
  };
  const { app: instance } = await openTestApp(llm);
  const origin = await instance.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const pending = fetch(`${origin}/api/meetings`, {
    method: 'POST',
    body: txtForm('standup.txt', standupText, 'Standup'),
    signal: controller.signal,
  });
  await embedStarted;
  controller.abort();
  await pending.catch(() => undefined);
  const deadline = Date.now() + 2_000;
  let remaining = -1;
  while (Date.now() < deadline) {
    const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
    remaining = (listed.json() as unknown[]).length;
    if (remaining === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(remaining, 0);
});
