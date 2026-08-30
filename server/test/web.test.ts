import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { useTestEnv } from './helpers.ts';

useTestEnv();

let webRoot: string | undefined;
let app: FastifyInstance | undefined;

beforeEach(() => {
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
});

test('SPA index is served for / and client routes, and is not immutably cached', async () => {
  const instance = await buildApp({ logger: false });
  app = instance;
  for (const url of ['/', '/meetings/1', '/index.html']) {
    const res = await instance.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /<title>spa<\/title>/);
    assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable/);
  }
});

test('hashed assets are served immutable; missing assets stay JSON 404', async () => {
  const instance = await buildApp({ logger: false });
  app = instance;
  const asset = await instance.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, 'console.log(1)');
  assert.match(asset.headers['cache-control'] ?? '', /immutable/);

  const missing = await instance.inject({ method: 'GET', url: '/assets/missing.js' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'Not found' });
});

test('unknown API and non-GET paths stay JSON 404', async () => {
  const instance = await buildApp({ logger: false });
  app = instance;
  const api = await instance.inject({ method: 'GET', url: '/api/missing' });
  assert.equal(api.statusCode, 404);
  assert.deepEqual(api.json(), { error: 'Not found' });

  const post = await instance.inject({ method: 'POST', url: '/meetings/1' });
  assert.equal(post.statusCode, 404);
  assert.deepEqual(post.json(), { error: 'Not found' });
});

test('production SPA does not send the Vite CORS origin', async () => {
  const instance = await buildApp({ logger: false });
  app = instance;
  const res = await instance.inject({
    method: 'OPTIONS',
    url: '/api/health',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
