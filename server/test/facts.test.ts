import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFacts, FACT_TRANSCRIPT_CHAR_LIMIT } from '../src/extract/facts.ts';
import type { ChatMessage, Llm } from '../src/llm/types.ts';

const validFacts = {
  decisions: [
    {
      text: 'Embeddings stay in SQLite',
      speaker: 'Maya',
      timestamp: '00:02:01',
    },
  ],
  actionItems: [
    {
      text: 'Write the storage RFC',
      owner: 'Omar',
      due: 'Monday',
      timestamp: '00:02:34',
    },
    {
      text: 'Legal retention review',
      timestamp: '00:06:15',
    },
  ],
};

function unused(): never {
  throw new Error('not used in extract');
}

function fakeLlm(completeJson: Llm['completeJson']): Llm {
  return {
    embedDocuments: unused,
    embedQueries: unused,
    completeJson,
    streamChat: unused,
  };
}

test('valid JSON maps decisions and action items, omitting owner as null', async () => {
  const llm = fakeLlm(async () => JSON.stringify(validFacts));

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.deepEqual(result, {
    decisions: [
      {
        text: 'Embeddings stay in SQLite',
        speaker: 'Maya',
        timestamp: '00:02:01',
      },
    ],
    actionItems: [
      {
        text: 'Write the storage RFC',
        owner: 'Omar',
        due: 'Monday',
        timestamp: '00:02:34',
      },
      {
        text: 'Legal retention review',
        owner: null,
        due: null,
        timestamp: '00:06:15',
      },
    ],
  });
});

test('malformed JSON returns empty arrays and does not throw', async () => {
  const llm = fakeLlm(async () => 'not-json');

  const result = await extractFacts(llm, '[00:00:01] Ada: hello');

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('wrong JSON shape returns empty arrays', async () => {
  const llm = fakeLlm(async () => JSON.stringify({ foo: 1, decisions: 'nope' }));

  const result = await extractFacts(llm, '[00:00:01] Ada: hello');

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('completeJson rejection returns empty arrays and does not throw', async () => {
  const llm = fakeLlm(async () => {
    throw new Error('chat unavailable');
  });

  const result = await extractFacts(llm, '[00:00:01] Ada: hello');

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('completeJson abort is not swallowed', async () => {
  const llm = fakeLlm(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(() => extractFacts(llm, '[00:00:01] Ada: hello'), { name: 'AbortError' });
});

test('transcript over the char limit is truncated in the user message', async () => {
  const captured: ChatMessage[][] = [];
  const llm = fakeLlm(async (messages) => {
    captured.push(messages);
    return '{"decisions":[],"actionItems":[]}';
  });
  const transcript = `${'a'.repeat(FACT_TRANSCRIPT_CHAR_LIMIT)}Z`;

  await extractFacts(llm, transcript);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].length, 2);
  assert.equal(captured[0][0].role, 'system');
  assert.equal(captured[0][1].role, 'user');
  const user = captured[0][1].content;
  assert.match(user, /truncated to the first 100000 characters/);
  const body = user.slice(user.lastIndexOf('\n') + 1);
  assert.equal(body.length, FACT_TRANSCRIPT_CHAR_LIMIT);
  assert.equal(body.includes('Z'), false);
});

test('markdown-fenced JSON still parses', async () => {
  const llm = fakeLlm(async () => `\`\`\`json\n${JSON.stringify(validFacts)}\n\`\`\``);

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
  assert.equal(result.actionItems.length, 2);
  assert.equal(result.actionItems[1].owner, null);
});

test('JSON wrapped in prose still parses', async () => {
  const llm = fakeLlm(async () => `Sure!\n${JSON.stringify(validFacts)}\nHope this helps!`);

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
  assert.equal(result.actionItems[0].owner, 'Omar');
});

test('decoy braces before the payload do not hide facts', async () => {
  const llm = fakeLlm(
    async () => `Hope this {helps}! ${JSON.stringify({ foo: 1 })} ${JSON.stringify(validFacts)}`,
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
});

test('JSON with braces in strings and trailing braces still parses', async () => {
  const payload = {
    decisions: [{ text: 'Use } in copy', speaker: 'Maya', timestamp: '00:02:01' }],
    actionItems: [],
  };
  const llm = fakeLlm(async () => `Sure ${JSON.stringify(payload)} trailing }`);

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Use } in copy');
});

test('invalid items are dropped without discarding valid ones', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' }, { text: 42 }],
      actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:34' }],
    }),
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Lock SQLite');
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].owner, 'Omar');
});

test('blank text is dropped and empty owner becomes null', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [
        { text: '   ', speaker: 'Maya', timestamp: '00:01:00' },
        { text: ' Lock SQLite ', speaker: ' Maya ', timestamp: ' 00:02:01 ' },
      ],
      actionItems: [{ text: 'Follow up', owner: '', due: '  ', timestamp: '00:06:15' }],
    }),
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.deepEqual(result.decisions, [
    { text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' },
  ]);
  assert.deepEqual(result.actionItems, [
    { text: 'Follow up', owner: null, due: null, timestamp: '00:06:15' },
  ]);
});

test('missing actionItems key still keeps valid decisions', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' }],
    }),
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.deepEqual(result.actionItems, []);
});

test('empty valid JSON object yields empty arrays', async () => {
  const llm = fakeLlm(async () => '{"decisions":[],"actionItems":[]}');

  const result = await extractFacts(llm, '[00:00:01] Ada: hello');

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('extraction prompt keeps named assignments and clock-only timestamps', async () => {
  let system = '';
  const llm = fakeLlm(async (messages) => {
    system = messages[0]?.content ?? '';
    return '{"decisions":[],"actionItems":[]}';
  });

  await extractFacts(llm, '[00:00:01] Ada: hello');

  assert.match(system, /can you/);
  assert.match(system, /I'll/);
  assert.match(system, /owner is that person, or null/);
  assert.match(system, /00:02:01 or 06:10/);
  assert.match(system, /due is a spoken deadline/);
  assert.doesNotMatch(system, /"we can"/);
});

test('wrapped timestamps are stored as clock only', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '[[00:02:01]]' }],
      actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '(00:02:34)' }],
    }),
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions[0].timestamp, '00:02:01');
  assert.equal(result.actionItems[0].timestamp, '00:02:34');
});

test('trailing-comma JSON still keeps complete inner items', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"}],"actionItems":[{"text":"Write RFC","owner":"Omar","due":"Monday","timestamp":"00:02:34"}],}',
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Lock SQLite');
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].text, 'Write RFC');
});

test('a trailing comma after the last property still keeps the item', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"text":"Use ,} in copy","speaker":"Maya","timestamp":"00:02:01",}]}',
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Use ,} in copy');
});

test('truncated JSON keeps complete items emitted before the cut', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"},{"text":"Ship',
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Lock SQLite');
  assert.equal(result.actionItems.length, 0);
});

test('truncated JSON keeps an action item even when the model copies speaker', async () => {
  const llm = fakeLlm(
    async () =>
      '{"actionItems":[{"text":"Write RFC","speaker":"Maya","owner":"Omar","due":"Monday","timestamp":"00:02:34"},{"text":"Ship',
  );

  const result = await extractFacts(llm, '[00:02:34] Maya: Omar, write the RFC by Monday');

  assert.equal(result.decisions.length, 0);
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].text, 'Write RFC');
  assert.equal(result.actionItems[0].owner, 'Omar');
  assert.equal(result.actionItems[0].due, 'Monday');
});

test('truncated JSON does not invent a fact from a cut string', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"speaker":"Maya","timestamp":"00:02:01","text":"Lock SQLite forever and',
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('a clock in due is dropped so it cannot replace a spoken deadline', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [],
      actionItems: [
        { text: 'Write the storage RFC', owner: 'Omar', due: '00:02:34', timestamp: '00:02:20' },
        { text: 'Workspace mockups', owner: 'Priya', due: 'Wednesday', timestamp: '00:04:08' },
        { text: 'Ship health', owner: 'Ada', due: '[00:06:15]', timestamp: '00:06:10' },
      ],
    }),
  );

  const result = await extractFacts(llm, '[00:02:34] Maya: Omar, RFC by Monday');

  assert.equal(result.actionItems[0].due, null);
  assert.equal(result.actionItems[0].timestamp, '00:02:20');
  assert.equal(result.actionItems[1].due, 'Wednesday');
  assert.equal(result.actionItems[2].due, null);
});

test('snake_case action_items still populate the action-item list', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' }],
      action_items: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:34' }],
    }),
  );

  const result = await extractFacts(llm, '[00:02:01] Maya: locking storage');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].text, 'Write RFC');
  assert.equal(result.actionItems[0].due, 'Monday');
});
