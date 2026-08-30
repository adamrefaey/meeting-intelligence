import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIUserAbortError } from 'openai';
import { isAbortError } from '../src/abort.ts';

test('isAbortError matches abort errors and rejects ordinary ones', () => {
  const named = new Error('aborted');
  named.name = 'AbortError';
  assert.equal(isAbortError(named), true);
  assert.equal(isAbortError(new APIUserAbortError()), true);
  assert.equal(isAbortError(new Error('chat unavailable')), false);
});
