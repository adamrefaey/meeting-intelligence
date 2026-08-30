import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatMessages } from '../src/rag/prompt.ts';
import { chunkTurns } from '../src/transcript/chunk.ts';
import { parseTranscript } from '../src/transcript/parse.ts';

const excerpt = 'Ada: we will ship Friday';

test('prompt contains action item text when provided', () => {
  const messages = buildChatMessages({
    title: 'Planning',
    decisions: [],
    actionItems: [
      {
        text: 'Write the storage RFC',
        owner: 'Omar',
        due: 'Monday',
        timestamp: '00:02:34',
      },
    ],
    excerpts: [excerpt],
    history: [],
    userMessage: 'What are the action items?',
    useFullTranscript: false,
    rawText: 'should not appear in chunk mode',
  });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.at(-1)?.content ?? '';
  assert.match(system, /Write the storage RFC/);
  assert.match(system, /may span\s*\n?\s*several lines/);
  assert.match(system, /copying that \[Speaker, timestamp\] marker/);
  assert.match(user, /What are the action items\?/);
  assert.match(user, /we will ship Friday/);
  assert.doesNotMatch(system, /we will ship Friday/);
  assert.doesNotMatch(system + user, /should not appear in chunk mode/);
});

test('full transcript path includes raw text and omits chunks', () => {
  const messages = buildChatMessages({
    title: 'Standup',
    decisions: [{ text: 'Ship Friday', speaker: 'Ada', timestamp: '00:01:00' }],
    actionItems: [],
    excerpts: [excerpt],
    history: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'older answer' },
    ],
    userMessage: 'What did we decide?',
    useFullTranscript: true,
    rawText: 'FULL_TRANSCRIPT_BODY',
  });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /FULL_TRANSCRIPT_BODY/);
  assert.match(system, /Ship Friday/);
  assert.doesNotMatch(system, /we will ship Friday/);
  assert.equal(messages.at(-1)?.content, 'What did we decide?');
  assert.equal(messages.filter((m) => m.role !== 'system').length, 3);
});

test('empty chunk retrieval tells the model nothing was found', () => {
  const messages = buildChatMessages({
    title: 'Planning',
    decisions: [],
    actionItems: [],
    excerpts: [],
    history: [],
    userMessage: 'What happened?',
    useFullTranscript: false,
    rawText: 'unused',
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
    title: 'Town hall',
    decisions: [],
    actionItems: [],
    excerpts: packed.map((one) => one.text),
    history: [],
    userMessage: 'Who asked about remote work?',
    useFullTranscript: false,
    rawText: '',
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
