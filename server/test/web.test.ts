import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

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
  'HOST',
  'WEB_ROOT',
] as const;

const baseline = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  CHAT_MODEL: 'gpt-5-mini',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: '1536',
  DATABASE_PATH: ':memory:',
  FULL_CONTEXT_CHAR_THRESHOLD: '24000',
  RETRIEVE_K: '8',
  FTS_K: '8',
  CHAT_HISTORY_TURNS: '8',
  PORT: '3000',
  HOST: '127.0.0.1',
} as const;

const envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let webRoot: string | undefined;
let app: FastifyInstance | undefined;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    process.env[key] = value;
  }
  delete process.env.WEB_ROOT;
  webRoot = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  process.env.WEB_ROOT = webRoot;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (webRoot !== undefined) {
    rmSync(webRoot, { recursive: true, force: true });
    webRoot = undefined;
  }
  for (const key of ENV_KEYS) {
    const previous = envSnapshot[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

test('GET / serves the SPA index', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /<title>spa<\/title>/);
});

test('GET client route serves the SPA index', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/meetings/1' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>spa<\/title>/);
});

test('GET hashed asset is served from WEB_ROOT', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'console.log(1)');
  assert.match(res.headers['cache-control'] ?? '', /immutable/);
});

test('SPA index is not immutably cached', async () => {
  app = await buildApp({ logger: false });
  const root = await app.inject({ method: 'GET', url: '/' });
  const index = await app.inject({ method: 'GET', url: '/index.html' });
  for (const res of [root, index]) {
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable/);
  }
});

test('GET missing hashed asset is 404 not the SPA', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/assets/missing.js' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
});

test('GET unknown /api path stays JSON 404', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/api/missing' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
});

test('POST unknown path stays JSON 404', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/meetings/1' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
});

test('production SPA does not send the Vite CORS origin', async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/health',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
