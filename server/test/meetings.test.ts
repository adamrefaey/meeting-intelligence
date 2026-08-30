import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { Llm } from '../src/llm/types.ts';
import {
  abortError,
  fakeLlm,
  openMigratedMemoryDb,
  unused,
  useTestEnv,
  waitForAbort,
} from './helpers.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');
const standupText = readFileSync(standupPath, 'utf8');

useTestEnv();

let app: FastifyInstance | undefined;
let db: DatabaseSync | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
});

async function openTestApp(llm: Llm = fakeLlm({ streamChat: unused })) {
  db = openMigratedMemoryDb();
  app = await buildApp({ logger: false, db, llm });
  return { app, db };
}

function txtForm(filename: string, content: string, type = 'text/plain'): FormData {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  return form;
}

async function upload(instance: FastifyInstance, form: FormData) {
  return instance.inject({ method: 'POST', url: '/api/meetings', payload: form });
}

test('upload, list, get, and transcript round-trip a fixture', async () => {
  const { app: instance } = await openTestApp();
  const created = await upload(instance, txtForm('standup.txt', standupText));
  assert.equal(created.statusCode, 201);
  const body = created.json() as { id: number };
  assert.ok(body.id > 0);
  assert.equal('status' in body, false);

  const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal(listed.statusCode, 200);
  const meetings = listed.json() as Array<Record<string, unknown>>;
  assert.equal(meetings.length, 1);
  assert.deepEqual(Object.keys(meetings[0] ?? {}).sort(), ['createdAt', 'id', 'status', 'title']);

  const meetingRes = await instance.inject({ method: 'GET', url: `/api/meetings/${body.id}` });
  assert.equal(meetingRes.statusCode, 200);
  const meeting = meetingRes.json() as {
    title: string;
    decisions: unknown;
    actionItems: unknown;
  };
  assert.equal(meeting.title, 'standup');
  assert.ok(Array.isArray(meeting.decisions));
  assert.ok(Array.isArray(meeting.actionItems));

  const transcriptRes = await instance.inject({
    method: 'GET',
    url: `/api/meetings/${body.id}/transcript`,
  });
  assert.equal(transcriptRes.statusCode, 200);
  const transcript = transcriptRes.json() as { turns: Array<Record<string, unknown>> };
  assert.equal(transcript.turns.length, 15);
  assert.equal(typeof transcript.turns[0]?.startSeconds, 'number');
  assert.equal('turnIndex' in (transcript.turns[0] ?? {}), false);
});

test('unknown meeting id returns 404', async () => {
  const { app: instance } = await openTestApp();
  for (const path of [
    '/api/meetings/99999',
    '/api/meetings/99999/transcript',
    '/api/meetings/99999/messages',
  ]) {
    const res = await instance.inject({ method: 'GET', url: path });
    assert.equal(res.statusCode, 404);
    assert.equal(typeof (res.json() as { error: string }).error, 'string');
  }
});

test('non-numeric meeting id returns 400', async () => {
  const { app: instance } = await openTestApp();
  const res = await instance.inject({ method: 'GET', url: '/api/meetings/abc' });
  assert.equal(res.statusCode, 400);
});

test('upload rejects missing, misnamed, non-txt, and unparseable files', async () => {
  const { app: instance } = await openTestApp();

  const missing = new FormData();
  missing.append('note', 'no file');
  assert.equal((await upload(instance, missing)).statusCode, 400);

  const misnamed = new FormData();
  misnamed.append('attachment', new Blob([standupText], { type: 'text/plain' }), 'standup.txt');
  assert.equal((await upload(instance, misnamed)).statusCode, 400);

  assert.equal((await upload(instance, txtForm('notes.md', standupText))).statusCode, 400);

  const garbage = await upload(instance, txtForm('garbage.txt', 'not a transcript\nat all'));
  assert.equal(garbage.statusCode, 400);
  assert.match((garbage.json() as { error: string }).error, /\[HH:MM:SS\] Speaker/);
});

test('file over 5 MiB returns 413', async () => {
  const { app: instance } = await openTestApp();
  const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
  const res = await upload(instance, txtForm('huge.txt', oversized));
  assert.equal(res.statusCode, 413);
  assert.equal((res.json() as { error: string }).error, 'file too large');
});

test('delete returns 204 and cascades turns', async () => {
  const { app: instance, db: database } = await openTestApp();
  const created = await upload(instance, txtForm('standup.txt', standupText));
  const { id } = created.json() as { id: number };

  const deleted = await instance.inject({ method: 'DELETE', url: `/api/meetings/${id}` });
  assert.equal(deleted.statusCode, 204);

  const missing = await instance.inject({ method: 'GET', url: `/api/meetings/${id}` });
  assert.equal(missing.statusCode, 404);

  const turns = database
    .prepare('SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?')
    .get(id) as { n: number };
  assert.equal(turns.n, 0);
});

test('failed ingest returns 500 and does not leave a meeting', async () => {
  const llm = fakeLlm({
    embed: async () => {
      throw new Error('embed exploded');
    },
    completeJson: unused,
    streamChat: unused,
  });
  const { app: instance } = await openTestApp(llm);
  const res = await upload(instance, txtForm('standup.txt', standupText));
  assert.equal(res.statusCode, 500);
  assert.equal((res.json() as { error: string }).error, 'failed to ingest transcript');
  const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal((listed.json() as unknown[]).length, 0);
});

test('aborted ingest does not report 500 or leave a meeting', async () => {
  const llm = fakeLlm({
    embed: async () => {
      throw abortError();
    },
    completeJson: unused,
    streamChat: unused,
  });
  const { app: instance } = await openTestApp(llm);
  const res = await upload(instance, txtForm('standup.txt', standupText));
  assert.equal(res.statusCode, 204);
  const listed = await instance.inject({ method: 'GET', url: '/api/meetings' });
  assert.equal((listed.json() as unknown[]).length, 0);
});

test('HTTP client abort during ingest does not leave a meeting', async () => {
  let started!: () => void;
  const embedStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const llm = fakeLlm({
    embed: async (_texts, signal) => {
      started();
      await waitForAbort(signal);
      return [];
    },
    completeJson: unused,
    streamChat: unused,
  });
  const { app: instance } = await openTestApp(llm);
  const origin = await instance.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const pending = fetch(`${origin}/api/meetings`, {
    method: 'POST',
    body: txtForm('standup.txt', standupText),
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
