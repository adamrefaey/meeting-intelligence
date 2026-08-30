import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIUserAbortError } from 'openai';
import { isAbortError } from '../src/abort.ts';

test('isAbortError matches AbortError by name', () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  assert.equal(isAbortError(error), true);
});

test('isAbortError matches APIUserAbortError from the OpenAI SDK', () => {
  assert.equal(isAbortError(new APIUserAbortError()), true);
});

test('isAbortError rejects ordinary errors', () => {
  assert.equal(isAbortError(new Error('chat unavailable')), false);
});
