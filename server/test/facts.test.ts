import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractFacts, MERGE_MAX_CHARS } from '../src/extract/facts.ts';
import { packWindows } from '../src/extract/window.ts';
import type { ChatMessage, Llm } from '../src/llm/types.ts';
import { parseTranscript, type Turn } from '../src/transcript/parse.ts';
import { fakeLlm, numberedTurns, unused } from './helpers.ts';

const marathonPath = join(import.meta.dirname, '../../fixtures/transcripts/all-hands-marathon.txt');

/** What the model returns: the last action item omits owner and due entirely. */
const validFacts = {
  decisions: [{ text: 'Embeddings stay in SQLite', speaker: 'Maya', timestamp: '00:02:01' }],
  actionItems: [
    { text: 'Write the storage RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:34' },
    { text: 'Legal retention review', timestamp: '00:06:15' },
  ],
};

/** What extractFacts returns for it: absent owner and due become null. */
const mappedFacts = {
  decisions: [{ text: 'Embeddings stay in SQLite', speaker: 'Maya', timestamp: '00:02:01' }],
  actionItems: [
    { text: 'Write the storage RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:34' },
    { text: 'Legal retention review', owner: null, due: null, timestamp: '00:06:15' },
  ],
};

const lockingTurns = parseTranscript('[00:02:01] Maya: locking storage');
const helloTurns = parseTranscript('[00:00:01] Ada: hello');
const rfcTurns = parseTranscript('[00:02:34] Maya: Omar, write the RFC by Monday');

function extractLlm(completeJson: Llm['completeJson']): Llm {
  return fakeLlm({ embed: unused, completeJson, streamChat: unused });
}

function overlappingTurns(count = 40): Turn[] {
  return numberedTurns(count, 'x'.repeat(400));
}

function isReduceCall(messages: ChatMessage[]): boolean {
  return /near-duplicate/.test(messages[0]?.content ?? '');
}

function isFirstWindow(messages: ChatMessage[]): boolean {
  return /\[Ada, 00:00:00\]/.test(messages[1]?.content ?? '');
}

const twoDistinctFacts = {
  decisions: [
    { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
    { text: 'Lock storage', speaker: 'Ada', timestamp: '00:00:02' },
  ],
  actionItems: [],
};

/**
 * Routes the reconcile prompt to `onReduce` and every window prompt to `onWindow`,
 * which by default reports `twoDistinctFacts` so tests only spell out what they vary.
 */
function mapReduceLlm(
  onReduce: () => string,
  onWindow: (messages: ChatMessage[]) => string = () =>
    JSON.stringify({ summary: 'ok', ...twoDistinctFacts }),
): Llm {
  return extractLlm(async (messages) => (isReduceCall(messages) ? onReduce() : onWindow(messages)));
}

test('parses raw, fenced, and nested JSON', async () => {
  const payloads = [
    JSON.stringify(validFacts),
    `\`\`\`json\n${JSON.stringify(validFacts)}\n\`\`\``,
    JSON.stringify({ result: validFacts }),
  ];
  for (const payload of payloads) {
    const result = await extractFacts(
      extractLlm(async () => payload),
      lockingTurns,
    );
    assert.deepEqual(result, mappedFacts);
  }
});

test('unreadable model output yields empty facts, but abort is not swallowed', async () => {
  for (const completeJson of [
    async () => 'not-json',
    async () => JSON.stringify({ foo: 1, decisions: 'nope' }),
    async () => {
      throw new Error('chat unavailable');
    },
  ]) {
    const result = await extractFacts(extractLlm(completeJson), helloTurns);
    assert.deepEqual(result, { decisions: [], actionItems: [] });
  }

  await assert.rejects(
    () =>
      extractFacts(
        extractLlm(async () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }),
        helloTurns,
      ),
    { name: 'AbortError' },
  );
});

test('a flood of unmatched braces does not stall parsing', { timeout: 1000 }, async () => {
  const result = await extractFacts(
    extractLlm(async () => '{'.repeat(20_000)),
    helloTurns,
  );
  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('invalid and blank items are dropped without discarding valid ones', async () => {
  const result = await extractFacts(
    extractLlm(async () =>
      JSON.stringify({
        decisions: [
          { text: '   ', speaker: 'Maya', timestamp: '00:01:00' },
          { text: ' Lock SQLite ', speaker: ' Maya ', timestamp: ' 00:02:01 ' },
          { text: 42 },
        ],
        actionItems: [{ text: 'Follow up', owner: '', due: '  ', timestamp: '00:06:15' }],
      }),
    ),
    lockingTurns,
  );
  assert.deepEqual(result.decisions, [
    { text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' },
  ]);
  assert.deepEqual(result.actionItems, [
    { text: 'Follow up', owner: null, due: null, timestamp: '00:06:15' },
  ]);
});

test('closing hygiene and recap restatements are dropped', async () => {
  const result = await extractFacts(
    extractLlm(async () =>
      JSON.stringify({
        decisions: [
          { text: 'Embeddings stay in SQLite', speaker: 'Maya', timestamp: '00:02:01' },
          {
            text: 'Recap: SQLite embeddings, no video, Friday freeze.',
            speaker: 'Maya',
            timestamp: '00:09:41',
          },
        ],
        actionItems: [
          { text: 'Write the storage RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:20' },
          {
            text: 'Post notes in the channel after this',
            owner: 'Omar',
            due: null,
            timestamp: '00:09:05',
          },
          { text: 'Thanks everyone', owner: 'Priya', due: null, timestamp: '00:09:18' },
          {
            text: 'Send the minutes of the compliance review to legal',
            owner: 'Maya',
            due: 'Friday',
            timestamp: '00:08:00',
          },
        ],
      }),
    ),
    lockingTurns,
  );

  assert.deepEqual(result.decisions, [
    { text: 'Embeddings stay in SQLite', speaker: 'Maya', timestamp: '00:02:01' },
  ]);
  assert.deepEqual(result.actionItems, [
    { text: 'Write the storage RFC', owner: 'Omar', due: 'Monday', timestamp: '00:02:20' },
    {
      text: 'Send the minutes of the compliance review to legal',
      owner: 'Maya',
      due: 'Friday',
      timestamp: '00:08:00',
    },
  ]);
});

test('NUL bytes are stripped from fact fields', async () => {
  const result = await extractFacts(
    extractLlm(async () =>
      JSON.stringify({
        decisions: [{ text: 'Budget is ~\u0000£60k', speaker: 'Maya', timestamp: '00:02:01' }],
        actionItems: [
          { text: 'Write RFC', owner: 'Omar\u0000', due: 'Monday', timestamp: '00:02:34' },
        ],
      }),
    ),
    rfcTurns,
  );
  assert.equal(result.decisions[0].text, 'Budget is ~£60k');
  assert.equal(result.actionItems[0].owner, 'Omar');
});

test('clocks are unwrapped from timestamps and dropped from due', async () => {
  const result = await extractFacts(
    extractLlm(async () =>
      JSON.stringify({
        decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '[[00:02:01]]' }],
        actionItems: [
          { text: 'Write RFC', owner: 'Omar', due: '00:02:34', timestamp: '(00:02:34)' },
          { text: 'Workspace mockups', owner: 'Priya', due: 'Wednesday', timestamp: '00:04:08' },
        ],
      }),
    ),
    rfcTurns,
  );
  assert.equal(result.decisions[0].timestamp, '00:02:01');
  assert.equal(result.actionItems[0].due, null);
  assert.equal(result.actionItems[0].timestamp, '00:02:34');
  assert.equal(result.actionItems[1].due, 'Wednesday');
});

test('JSON repair keeps a trailing comma and rejects truncated JSON', async () => {
  const trailing = await extractFacts(
    extractLlm(
      async () =>
        '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"}],"actionItems":[{"text":"Write RFC","owner":"Omar","due":"Monday","timestamp":"00:02:34"}],}',
    ),
    lockingTurns,
  );
  assert.equal(trailing.decisions[0].text, 'Lock SQLite');
  assert.equal(trailing.actionItems[0].text, 'Write RFC');

  const truncated = await extractFacts(
    extractLlm(
      async () =>
        '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"},{"text":"Ship',
    ),
    lockingTurns,
  );
  assert.deepEqual(truncated, { decisions: [], actionItems: [] });
});

test('a single window does not run a reconcile prompt', async () => {
  const calls: ChatMessage[][] = [];
  await extractFacts(
    extractLlm(async (messages) => {
      calls.push(messages);
      return JSON.stringify(validFacts);
    }),
    helloTurns,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0][0].content, /locked decisions/);
  assert.doesNotMatch(calls[0][0].content, /near-duplicate/);
  assert.match(calls[0][1].content, /\[Ada, 00:00:01\]: hello/);
});

// The payload omits actionItems entirely, so this also pins that a decisions-only
// response is still recognised and the missing key reads as empty rather than throwing.
test('exact duplicate decision text in one window is kept once', async () => {
  const result = await extractFacts(
    extractLlm(async () =>
      JSON.stringify({
        decisions: [
          { text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' },
          { text: 'lock sqlite', speaker: 'Maya', timestamp: '00:03:00' },
        ],
      }),
    ),
    lockingTurns,
  );
  assert.deepEqual(result.decisions, [
    { text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' },
  ]);
  assert.deepEqual(result.actionItems, []);
});

test('several windows map in parallel then reconcile once', async () => {
  const turns = overlappingTurns();
  const windows = packWindows(turns);
  assert.ok(windows.length >= 2);

  const calls: ChatMessage[][] = [];
  const result = await extractFacts(
    extractLlm(async (messages) => {
      calls.push(messages);
      if (isReduceCall(messages)) {
        return JSON.stringify({
          decisions: [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }],
          actionItems: [],
        });
      }
      return JSON.stringify({
        summary: 'Locked a ship decision.',
        ...twoDistinctFacts,
      });
    }),
    turns,
  );

  assert.equal(calls.length, windows.length + 1);
  assert.equal(calls.filter(isReduceCall).length, 1);
  const reduce = calls[calls.length - 1];
  assert.match(reduce[0].content, /near-duplicate/);
  assert.match(reduce[1].content, /Locked a ship decision/);
  assert.doesNotMatch(reduce[1].content, /Ada: x{20}/);
  assert.deepEqual(result.decisions, [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }]);
});

test('a failed window is dropped and the rest still reconcile', async () => {
  const result = await extractFacts(
    mapReduceLlm(
      () =>
        JSON.stringify({
          decisions: [{ text: 'Keep this', speaker: 'Ada', timestamp: '00:00:01' }],
          actionItems: [],
        }),
      (messages) => {
        if (isFirstWindow(messages)) {
          throw new Error('window failed');
        }
        return JSON.stringify({
          summary: 'ok',
          decisions: [
            { text: 'Keep this', speaker: 'Ada', timestamp: '00:00:01' },
            { text: 'Also this', speaker: 'Ada', timestamp: '00:00:02' },
          ],
          actionItems: [],
        });
      },
    ),
    overlappingTurns(),
  );
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Keep this');
});

// A reconcile that throws, comes back empty, or comes back unreadable must never shrink
// the meeting to nothing; each falls back to the exact-deduped window facts.
test('a reconcile that fails, empties, or garbles keeps the window facts', async () => {
  for (const onReduce of [
    () => {
      throw new Error('reconcile failed');
    },
    () => '{"decisions":[],"actionItems":[]}',
    () => 'cannot comply',
  ]) {
    const result = await extractFacts(mapReduceLlm(onReduce), overlappingTurns());
    assert.deepEqual(result.decisions, twoDistinctFacts.decisions);
  }
});

test('reconcile drops invented items and keeps original wording and metadata', async () => {
  const result = await extractFacts(
    mapReduceLlm(
      () =>
        JSON.stringify({
          decisions: [
            { text: 'Acquire competitor', speaker: 'CEO', timestamp: '00:00:01' },
            { text: 'Ship it', speaker: 'IMPOSTOR', timestamp: '23:59:59' },
          ],
          actionItems: [
            { text: 'Write RFC', owner: 'IMPOSTOR', due: 'Never', timestamp: '23:59:59' },
          ],
        }),
      () =>
        JSON.stringify({
          summary: 'ok',
          decisions: [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }],
          actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:00:02' }],
        }),
    ),
    overlappingTurns(),
  );
  assert.deepEqual(result.decisions, [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }]);
  assert.deepEqual(result.actionItems, [
    { text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:00:02' },
  ]);
});

test('reconcile that rephrases most rows keeps the window facts', async () => {
  const threeFacts = {
    decisions: [
      ...twoDistinctFacts.decisions,
      { text: 'Freeze Friday', speaker: 'Ada', timestamp: '00:00:03' },
    ],
    actionItems: [],
  };
  const result = await extractFacts(
    mapReduceLlm(
      () =>
        JSON.stringify({
          decisions: [
            { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
            { text: 'Storage is now locked for v1', speaker: 'Ada', timestamp: '00:00:02' },
            { text: 'Friday is the freeze date', speaker: 'Ada', timestamp: '00:00:03' },
          ],
          actionItems: [],
        }),
      () => JSON.stringify({ summary: 'ok', ...threeFacts }),
    ),
    overlappingTurns(),
  );
  assert.deepEqual(result.decisions, threeFacts.decisions);
});

test('reconcile maps reworded text back to the original wording', async () => {
  const result = await extractFacts(
    mapReduceLlm(() =>
      JSON.stringify({
        decisions: [
          { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
          { text: 'Lock storage in SQLite', speaker: 'Ada', timestamp: '00:00:02' },
        ],
        actionItems: [],
      }),
    ),
    overlappingTurns(),
  );
  assert.deepEqual(result.decisions, twoDistinctFacts.decisions);
});

test('marathon maps every window including the tail and skips an empty reduce', async () => {
  const turns = parseTranscript(readFileSync(marathonPath, 'utf8'));
  const windows = packWindows(turns);
  const calls: ChatMessage[][] = [];
  await extractFacts(
    extractLlm(async (messages) => {
      calls.push(messages);
      return '{"summary":"","decisions":[],"actionItems":[]}';
    }),
    turns,
  );
  assert.equal(calls.length, windows.length);
  assert.ok(calls.some((call) => call[1]?.content.includes('onboarding buddy rota')));
  assert.equal(calls.filter(isReduceCall).length, 0);
});

test('later window fills owner and due on the same action text', async () => {
  const turns = overlappingTurns();
  const calls: ChatMessage[][] = [];
  const result = await extractFacts(
    extractLlm(async (messages) => {
      calls.push(messages);
      if (isFirstWindow(messages)) {
        return JSON.stringify({
          summary: 'early',
          decisions: [],
          actionItems: [{ text: 'Write RFC', owner: null, due: null, timestamp: '00:00:01' }],
        });
      }
      return JSON.stringify({
        summary: 'later',
        decisions: [],
        actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:01:00' }],
      });
    }),
    turns,
  );
  assert.deepEqual(result.actionItems[0], {
    text: 'Write RFC',
    owner: 'Omar',
    due: 'Monday',
    timestamp: '00:00:01',
  });
  assert.equal(calls.filter(isReduceCall).length, 0);
});

test(
  'oversized per-window payloads skip reduce instead of looping',
  { timeout: 5000 },
  async () => {
    const turns = overlappingTurns();
    const windows = packWindows(turns);
    assert.ok(windows.length >= 2);
    let calls = 0;
    const result = await extractFacts(
      extractLlm(async () => {
        calls += 1;
        const text = `fact-${calls}-${'y'.repeat(50_000)}`;
        return JSON.stringify({
          summary: 'z'.repeat(50_000),
          decisions: [{ text, speaker: 'Ada', timestamp: '00:00:01' }],
          actionItems: [],
        });
      }),
      turns,
    );
    assert.equal(calls, windows.length);
    assert.equal(result.decisions.length, windows.length);
  },
);

test('payloads over MERGE_MAX_CHARS collapse then reconcile', async () => {
  const turns = overlappingTurns(120);
  const windows = packWindows(turns);
  assert.ok(windows.length >= 3);
  const bulky = {
    summary: 'ok',
    decisions: [
      ...twoDistinctFacts.decisions,
      { text: 'y'.repeat(Math.floor(MERGE_MAX_CHARS / 3)), speaker: 'Ada', timestamp: '00:00:03' },
    ],
    actionItems: [],
  };
  let reduceCalls = 0;
  const result = await extractFacts(
    mapReduceLlm(
      () => {
        reduceCalls += 1;
        return JSON.stringify({ decisions: twoDistinctFacts.decisions, actionItems: [] });
      },
      () => JSON.stringify(bulky),
    ),
    turns,
  );
  assert.ok(reduceCalls >= 2, `expected collapse then reconcile, got ${reduceCalls}`);
  assert.equal(result.decisions.length, 2);
});
