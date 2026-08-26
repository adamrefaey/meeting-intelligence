import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatMessages } from '../src/rag/prompt.ts';
import type { RetrievedChunk } from '../src/rag/retrieve.ts';
import { chunkTurns } from '../src/transcript/chunk.ts';
import { parseTranscript } from '../src/transcript/parse.ts';

const chunk: RetrievedChunk = {
  id: 1,
  meetingId: 1,
  chunkIndex: 0,
  text: 'Ada: we will ship Friday',
  speakerLabel: 'Ada',
  startTimestamp: '00:01:00',
  endTimestamp: '00:01:10',
  startSeconds: 60,
  endSeconds: 70,
  turnStartIndex: 0,
  turnEndIndex: 0,
  score: 1,
};

test('prompt contains action item text when provided', () => {
  const messages = buildChatMessages({
    meeting: { title: 'Planning' },
    decisions: [],
    actionItems: [
      {
        text: 'Write the storage RFC',
        owner: 'Omar',
        due: 'Monday',
        timestamp: '00:02:34',
      },
    ],
    chunks: [chunk],
    history: [],
    userMessage: 'What are the action items?',
    useFullTranscript: false,
    rawText: 'should not appear in chunk mode',
    chatHistoryTurns: 8,
  });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.at(-1)?.content ?? '';
  assert.match(system, /Write the storage RFC/);
  assert.match(system, /\[Speaker, timestamp\]/);
  // A turn wraps over as many lines as it needs, so the rule has to point at the turn
  // rather than at the line, or it is unsatisfiable for every continuation line.
  assert.match(system, /may span\s*\n?\s*several lines/);
  assert.match(system, /copying that \[Speaker, timestamp\] marker/);
  assert.match(system, /not from an earlier line by the same speaker/);
  assert.match(system, /Each retrieved excerpt lists its speakers/);
  assert.match(system, /cannot find it in this meeting/);
  assert.match(system, /Keep answers concise/);
  assert.match(user, /What are the action items\?/);
  assert.match(user, /we will ship Friday/);
  assert.doesNotMatch(system, /we will ship Friday/);
  assert.doesNotMatch(system + user, /should not appear in chunk mode/);
});

test('full transcript path includes raw text and omits chunks', () => {
  const messages = buildChatMessages({
    meeting: { title: 'Standup' },
    decisions: [{ text: 'Ship Friday', speaker: 'Ada', timestamp: '00:01:00' }],
    actionItems: [],
    chunks: [chunk],
    history: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'older answer' },
    ],
    userMessage: 'What did we decide?',
    useFullTranscript: true,
    rawText: 'FULL_TRANSCRIPT_BODY',
    chatHistoryTurns: 1,
  });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /FULL_TRANSCRIPT_BODY/);
  assert.match(system, /Ship Friday/);
  assert.doesNotMatch(system, /we will ship Friday/);
  assert.match(system, /copying that \[Speaker, timestamp\] marker/);
  assert.equal(messages.at(-1)?.content, 'What did we decide?');
  assert.equal(messages.filter((m) => m.role !== 'system').length, 2);
});

test('chatHistoryTurns of 0 drops history', () => {
  const messages = buildChatMessages({
    meeting: { title: 'Standup' },
    decisions: [],
    actionItems: [],
    chunks: [],
    history: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'older answer' },
    ],
    userMessage: 'Hello',
    useFullTranscript: true,
    rawText: 'transcript',
    chatHistoryTurns: 0,
  });
  assert.deepEqual(
    messages.filter((m) => m.role !== 'system'),
    [{ role: 'user', content: 'Hello' }],
  );
});

test('empty chunk retrieval tells the model nothing was found', () => {
  const messages = buildChatMessages({
    meeting: { title: 'Planning' },
    decisions: [],
    actionItems: [],
    chunks: [],
    history: [],
    userMessage: 'What happened?',
    useFullTranscript: false,
    rawText: 'unused',
    chatHistoryTurns: 8,
  });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.at(-1)?.content ?? '';
  assert.match(user, /None retrieved/);
  assert.match(user, /What happened\?/);
  assert.doesNotMatch(system, /Excerpt format/, 'no excerpts means nothing to explain');
});

// Driven through the real chunker: the citation bug lived in what chunkTurns produced,
// so asserting on hand-written excerpt text would have proved nothing.
test('a real chunk reaches the model with each turn on its own clock', () => {
  const turns = parseTranscript(
    '[00:04:00] Alex: Next question, over to you.\n' +
      '[00:04:17] Keiko: Mine is about the remote-first thing.\n',
  );
  const packed = chunkTurns(turns);
  assert.equal(packed.length, 1);
  const messages = buildChatMessages({
    meeting: { title: 'Town hall' },
    decisions: [],
    actionItems: [],
    chunks: packed.map((one) => ({ ...one, id: 1, meetingId: 1, score: 1 })),
    history: [],
    userMessage: 'Who asked about remote work?',
    useFullTranscript: false,
    rawText: '',
    chatHistoryTurns: 8,
  });
  const user = messages.at(-1)?.content ?? '';
  assert.match(user, /\[Keiko, 00:04:17\]: Mine is about the remote-first thing\./);
  assert.match(user, /Speakers: Alex, Keiko/);
  assert.doesNotMatch(
    user,
    /00:04:00\s*[\u2013-]\s*00:04:17/,
    'a window range in the excerpt is a clock the model can pair with the wrong speaker',
  );
});
