import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatMessages } from '../src/rag/prompt.ts';
import type { RetrievedChunk } from '../src/rag/retrieve.ts';

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
  const user = messages.at(-1)?.content ?? '';
  assert.match(user, /None retrieved/);
  assert.match(user, /What happened\?/);
});
