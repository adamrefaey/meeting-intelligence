import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { packWindows, WINDOW_MAX_CHARS, WINDOW_OVERLAP_RATIO } from '../src/extract/window.ts';
import {
  parseTranscript,
  renderTurn,
  renderTurns,
  turnPrefix,
  type Turn,
} from '../src/transcript/parse.ts';
import { numberedTurns } from './helpers.ts';

const marathonPath = join(import.meta.dirname, '../../fixtures/transcripts/all-hands-marathon.txt');

function t(speaker: string, timestamp: string, startSeconds: number, text: string): Turn {
  return { speaker, timestamp, startSeconds, text };
}

function coveredTurns(windows: Array<{ turnStart: number; turnEnd: number }>): number[] {
  const covered = new Set<number>();
  for (const window of windows) {
    for (let index = window.turnStart; index <= window.turnEnd; index += 1) {
      covered.add(index);
    }
  }
  return [...covered].sort((a, b) => a - b);
}

test('renderTurns writes a canonical timestamped line per turn', () => {
  const turns = [t('Ada', '00:00:01', 1, 'hi'), t('Ben', '00:00:05', 5, 'yo')];
  assert.equal(renderTurns(turns), '[Ada, 00:00:01]: hi\n[Ben, 00:00:05]: yo');
});

test('turns that fit in one budget pack into a single window', () => {
  const turns = [t('Ada', '00:00:01', 1, 'hi'), t('Ben', '00:00:05', 5, 'yo')];
  const windows = packWindows(turns);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].text, renderTurns(turns));
});

test('a turn that exceeds maxChars is sliced with overlap and keeps the speaker label', () => {
  const turn = t('Ada', '00:00:01', 1, 'x'.repeat(50));
  const line = renderTurn(turn);
  const prefix = turnPrefix(turn);
  const maxChars = prefix.length + 10;
  const windows = packWindows([turn], maxChars);
  assert.ok(windows.length > 1);
  assert.ok(windows.every((window) => window.text.length <= maxChars));
  assert.ok(windows.every((window) => window.turnStart === 0 && window.turnEnd === 0));
  assert.ok(windows.every((window) => window.text.startsWith(prefix)));
  assert.equal(windows[0].text, line.slice(0, maxChars));
  assert.equal(windows[windows.length - 1].text.slice(-1), line.slice(-1));
});

test('adjacent windows overlap by about 20% of the previous window', () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const windows = packWindows(turns, 3000, 0.2);
  assert.ok(windows.length >= 2);

  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const next = windows[index];
    assert.ok(next.turnStart > previous.turnStart);
    assert.ok(next.turnEnd > previous.turnEnd);
    assert.ok(next.turnStart <= previous.turnEnd);

    const shared = renderTurns(turns.slice(next.turnStart, previous.turnEnd + 1));
    const ratio = shared.length / previous.text.length;
    assert.ok(
      ratio >= WINDOW_OVERLAP_RATIO,
      `overlap ratio ${ratio} should be at least ${WINDOW_OVERLAP_RATIO}`,
    );
    if (next.turnStart < previous.turnEnd) {
      const tighter = renderTurns(turns.slice(next.turnStart + 1, previous.turnEnd + 1));
      assert.ok(
        tighter.length < previous.text.length * WINDOW_OVERLAP_RATIO,
        'overlap should be the smallest suffix that still meets 20%',
      );
    }
  }

  assert.deepEqual(
    coveredTurns(windows),
    Array.from({ length: turns.length }, (_, index) => index),
  );
});

test('a window dominated by one turn still overlaps the last packed turn', () => {
  const turns = [
    t('Ada', '00:00:00', 0, 'x'.repeat(11_000)),
    ...Array.from({ length: 80 }, (_, index) => {
      const seconds = index + 1;
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      return t('Ben', `00:${mm}:${ss}`, seconds, 'short');
    }),
  ];
  const windows = packWindows(turns);
  assert.ok(windows.length >= 2);
  assert.ok(windows[0].turnEnd > windows[0].turnStart);
  assert.equal(windows[1].turnStart, windows[0].turnEnd);
});

test('a single-turn window does not overlap itself', () => {
  const a = t('Ada', '00:00:01', 1, 'xx');
  const b = t('Ben', '00:00:02', 2, 'xx');
  const windows = packWindows([a, b], renderTurn(a).length);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].turnEnd, 0);
  assert.equal(windows[1].turnStart, 1);
});

test('all-hands-marathon windows cover every turn including the tail commitment', () => {
  const turns = parseTranscript(readFileSync(marathonPath, 'utf8'));
  const windows = packWindows(turns);

  assert.ok(windows.length > 1);
  assert.ok(windows.length < turns.length);
  assert.equal(windows[0].turnStart, 0);
  assert.equal(windows[windows.length - 1].turnEnd, turns.length - 1);
  assert.deepEqual(
    coveredTurns(windows),
    Array.from({ length: turns.length }, (_, index) => index),
  );
  assert.ok(windows[windows.length - 1].text.includes('onboarding buddy rota'));
  assert.ok(windows.every((window) => window.text.length <= WINDOW_MAX_CHARS));

  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const next = windows[index];
    if (next.turnStart === previous.turnStart && next.turnEnd === previous.turnEnd) {
      continue;
    }
    assert.ok(next.turnEnd > previous.turnEnd);
    if (previous.turnStart === previous.turnEnd) {
      assert.equal(next.turnStart, previous.turnEnd + 1);
      continue;
    }
    assert.ok(next.turnStart > previous.turnStart);
    assert.ok(next.turnStart <= previous.turnEnd);
    const shared = renderTurns(turns.slice(next.turnStart, previous.turnEnd + 1));
    const ratio = shared.length / previous.text.length;
    assert.ok(ratio >= 0.15, `marathon overlap ${ratio} below 15%`);
    assert.ok(ratio <= 0.25, `marathon overlap ${ratio} above 25%`);
  }
});
