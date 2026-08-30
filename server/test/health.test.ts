import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { clearOptionalConfigEnv, useTestEnv } from './helpers.ts';

useTestEnv();

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

test('buildApp enables CORS for the Vite origin when no SPA is mounted', async () => {
  const instance = await buildApp({ logger: false });
  app = instance;
  const res = await instance.inject({
    method: 'OPTIONS',
    url: '/',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
});

test('GET /api/health returns 200 and echoes models from env', async () => {
  process.env.CHAT_MODEL = 'gpt-4.1-mini';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-large';
  const instance = await buildApp({ logger: false });
  app = instance;
  const res = await instance.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body, {
    ok: true,
    chatModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-large',
  });
});

test('loadConfig throws when OPENAI_API_KEY is missing', () => {
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => loadConfig(), /OPENAI_API_KEY/);
});

test('loadConfig throws on invalid EMBEDDING_DIMENSIONS or PORT', () => {
  process.env.EMBEDDING_DIMENSIONS = '0';
  assert.throws(() => loadConfig(), /EMBEDDING_DIMENSIONS/);
  process.env.EMBEDDING_DIMENSIONS = '4';
  process.env.PORT = 'abc';
  assert.throws(() => loadConfig(), /PORT/);
});

test('loadConfig applies spec defaults when optional env vars are unset', () => {
  clearOptionalConfigEnv();
  const config = loadConfig();
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.openaiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.chatModel, 'gpt-5.6-luna');
  assert.equal(config.embeddingModel, 'text-embedding-3-small');
  assert.equal(config.embeddingDimensions, 1536);
  assert.equal(config.databasePath, 'data/app.db');
  assert.equal(config.fullContextCharThreshold, 24000);
  assert.equal(config.retrieveK, 8);
  assert.equal(config.ftsK, 8);
  assert.equal(config.chatHistoryTurns, 8);
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
});
