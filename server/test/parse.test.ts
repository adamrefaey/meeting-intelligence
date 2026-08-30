import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ParseError,
  parseTranscript,
  renderTurn,
  turnPrefix,
  type Turn,
} from '../src/transcript/parse.ts';

function t(speaker: string, timestamp: string, startSeconds: number, text: string): Turn {
  return { speaker, timestamp, startSeconds, text };
}

// The model cites [Speaker, timestamp]. If that marker is not already on the turn
// line, it has to rebuild it, and the rebuild grabs the speaker's first clock —
// Keiko's "Hi. Can you hear me?" at 00:04:14 instead of the remote-work question.
test('a turn prefix is the citation, so a later turn cannot yield an earlier clock', () => {
  const greeting = t('Keiko', '00:04:14', 254, 'Hi. Can you hear me?');
  const question = t(
    'Keiko',
    '00:04:17',
    257,
    "So my question is about the remote-first thing, and\nI wanted to ask what happens to people who've already moved.",
  );
  assert.equal(turnPrefix(greeting), '[Keiko, 00:04:14]: ');
  assert.equal(turnPrefix(question), '[Keiko, 00:04:17]: ');
  assert.equal(renderTurn(question).startsWith('[Keiko, 00:04:17]:'), true);
  assert.equal(
    renderTurn(question).includes('[Keiko, 00:04:14]'),
    false,
    'citing the question turn by copying its marker cannot produce the greeting clock',
  );
});

test('parses the supported transcript header shapes', () => {
  assert.deepEqual(parseTranscript('[00:01:02] Ada: hello')[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
  assert.deepEqual(parseTranscript('[01:02] Ada: hello')[0], {
    speaker: 'Ada',
    timestamp: '01:02',
    startSeconds: 62,
    text: 'hello',
  });
  assert.deepEqual(parseTranscript('Ada (00:01:02): hello')[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
  assert.deepEqual(parseTranscript('00:01:02 Ada: hello')[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
});

test('continuation lines attach; blank lines between turns do not', () => {
  const continued = parseTranscript('[00:00:01] Ada: hello\nworld');
  assert.equal(continued.length, 1);
  assert.equal(continued[0].text, 'hello\nworld');

  const two = parseTranscript('[00:00:01] Ada: hello\n\n[00:00:05] Ben: hi');
  assert.equal(two.length, 2);
  assert.equal(two[1].speaker, 'Ben');
  assert.equal(two[1].text, 'hi');
});

test('whitespace-only speaker is not a header', () => {
  assert.throws(
    () => parseTranscript('[00:00:01] : a'),
    (error: unknown) => error instanceof ParseError,
  );

  const turns = parseTranscript('[00:00:01] Ada: hello\n[00:00:02] : a');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'hello\n[00:00:02] : a');
});

test('garbage-only input throws ParseError', () => {
  assert.throws(
    () => parseTranscript('not a transcript\nat all'),
    (error: unknown) => {
      assert.ok(error instanceof ParseError);
      assert.equal(
        error.message,
        'Could not parse speaker labels and timestamps. Expected lines like [HH:MM:SS] Speaker: text',
      );
      return true;
    },
  );
});
