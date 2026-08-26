import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ParseError,
  parseTranscript,
  renderTurn,
  turnPrefix,
  type Turn,
} from '../src/transcript/parse.ts';

const standupPath = join(import.meta.dirname, '../../fixtures/transcripts/standup.txt');
const planningPath = join(import.meta.dirname, '../../fixtures/transcripts/planning.txt');

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

test('parses canonical [HH:MM:SS] Speaker: text', () => {
  const turns = parseTranscript('[00:01:02] Ada: hello');
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
});

test('parses [MM:SS] as seconds from zero', () => {
  const turns = parseTranscript('[01:02] Ada: hello');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].timestamp, '01:02');
  assert.equal(turns[0].startSeconds, 62);
  assert.equal(turns[0].speaker, 'Ada');
  assert.equal(turns[0].text, 'hello');
});

test('parses Speaker (HH:MM:SS): text', () => {
  const turns = parseTranscript('Ada (00:01:02): hello');
  assert.deepEqual(turns[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
});

test('parses HH:MM:SS Speaker: text', () => {
  const turns = parseTranscript('00:01:02 Ada: hello');
  assert.deepEqual(turns[0], {
    speaker: 'Ada',
    timestamp: '00:01:02',
    startSeconds: 62,
    text: 'hello',
  });
});

test('continuation line attaches with a newline', () => {
  const turns = parseTranscript('[00:00:01] Ada: hello\nworld');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'hello\nworld');
});

test('ignores blank lines between turns', () => {
  const turns = parseTranscript('[00:00:01] Ada: hello\n\n[00:00:05] Ben: hi');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'hello');
  assert.equal(turns[1].speaker, 'Ben');
  assert.equal(turns[1].text, 'hi');
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

test('standup fixture parses to more than 10 turns with at least 2 speakers', () => {
  const raw = readFileSync(standupPath, 'utf8');
  const turns = parseTranscript(raw);
  assert.ok(turns.length > 10);
  const speakers = new Set(turns.map((turn) => turn.speaker));
  assert.ok(speakers.size >= 2);
});

test('planning fixture has 40 turns with explicit decisions and owned action items', () => {
  const raw = readFileSync(planningPath, 'utf8');
  const turns = parseTranscript(raw);
  assert.equal(turns.length, 40);
  const texts = turns.map((turn) => turn.text);
  assert.ok(texts.some((text) => text.includes('Embeddings stay in SQLite')));
  assert.ok(texts.some((text) => text.includes('transcript upload only')));
  assert.ok(texts.some((text) => text.includes('Friday at 5pm')));
  assert.ok(
    texts.some((text) => text.includes('Omar') && text.includes('RFC') && text.includes('Monday')),
  );
  assert.ok(
    texts.some(
      (text) => text.includes('Priya') && text.includes('mockups') && text.includes('Wednesday'),
    ),
  );
  assert.ok(
    texts.some(
      (text) => text.includes('Sam') && text.includes('soak test') && text.includes('Thursday'),
    ),
  );
  assert.ok(
    texts.some((text) => text.includes('legal retention review') && text.includes('Tuesday')),
  );
});
