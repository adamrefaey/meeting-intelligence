import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

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

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    process.env[key] = value;
  }
  delete process.env.WEB_ROOT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = envSnapshot[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

test('buildApp sets a 600s request timeout', async () => {
  const app = await buildApp({ logger: false });
  assert.equal(app.server.requestTimeout, 600_000);
  await app.close();
});

test('buildApp enables CORS for the Vite origin', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  await app.close();
});

test('GET /api/health returns 200 and echoes models from env', async () => {
  process.env.CHAT_MODEL = 'gpt-4.1-mini';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-large';
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body, {
    ok: true,
    chatModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-large',
  });
  assert.equal('llmMode' in body, false);
  await app.close();
});

test('loadConfig throws when OPENAI_API_KEY is missing', () => {
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => loadConfig(), /OPENAI_API_KEY/);
});

test('loadConfig throws when OPENAI_API_KEY is empty', () => {
  process.env.OPENAI_API_KEY = '';
  assert.throws(() => loadConfig(), /OPENAI_API_KEY/);
});

test('loadConfig throws when embeddingDimensions is not a positive integer', () => {
  process.env.EMBEDDING_DIMENSIONS = '0';
  assert.throws(() => loadConfig(), /EMBEDDING_DIMENSIONS/);
});

test('loadConfig applies spec defaults when optional env vars are unset', () => {
  for (const key of ENV_KEYS) {
    if (key !== 'OPENAI_API_KEY') {
      delete process.env[key];
    }
  }

  const config = loadConfig();
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.openaiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.chatModel, 'gpt-5-mini');
  assert.equal(config.embeddingModel, 'text-embedding-3-small');
  assert.equal(config.embeddingDimensions, 1536);
  assert.equal(config.databasePath, 'data/app.db');
  assert.equal(config.fullContextCharThreshold, 24000);
  assert.equal(config.retrieveK, 8);
  assert.equal(config.ftsK, 8);
  assert.equal(config.chatHistoryTurns, 8);
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal('llmMode' in config, false);
});

test('loadConfig throws when PORT is not a valid port', () => {
  process.env.PORT = 'abc';
  assert.throws(() => loadConfig(), /PORT/);
});

test('loadConfig reads HOST', () => {
  process.env.HOST = '0.0.0.0';
  const config = loadConfig();
  assert.equal(config.host, '0.0.0.0');
});

test('loadConfig reads OPENAI_BASE_URL as openaiBaseUrl', () => {
  process.env.OPENAI_BASE_URL = 'https://proxy.example/v1';
  const config = loadConfig();
  assert.equal(config.openaiBaseUrl, 'https://proxy.example/v1');
});
