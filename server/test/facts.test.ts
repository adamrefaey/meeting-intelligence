import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractFacts } from '../src/extract/facts.ts';
import { packWindows } from '../src/extract/window.ts';
import type { ChatMessage, Llm } from '../src/llm/types.ts';
import { parseTranscript, type Turn } from '../src/transcript/parse.ts';

const marathonPath = join(import.meta.dirname, '../../fixtures/transcripts/all-hands-marathon.txt');

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

const lockingTurns = parseTranscript('[00:02:01] Maya: locking storage');
const helloTurns = parseTranscript('[00:00:01] Ada: hello');
const rfcTurns = parseTranscript('[00:02:34] Maya: Omar, write the RFC by Monday');

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

function numberedTurns(count: number, body: string): Turn[] {
  return Array.from({ length: count }, (_, index) => {
    const hours = String(Math.floor(index / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((index % 3600) / 60)).padStart(2, '0');
    const seconds = String(index % 60).padStart(2, '0');
    return {
      speaker: 'Ada',
      timestamp: `${hours}:${minutes}:${seconds}`,
      startSeconds: index,
      text: body,
    };
  });
}

test('valid JSON maps decisions and action items, omitting owner as null', async () => {
  const llm = fakeLlm(async () => JSON.stringify(validFacts));

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, helloTurns);

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('wrong JSON shape returns empty arrays', async () => {
  const llm = fakeLlm(async () => JSON.stringify({ foo: 1, decisions: 'nope' }));

  const result = await extractFacts(llm, helloTurns);

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('completeJson rejection returns empty arrays and does not throw', async () => {
  const llm = fakeLlm(async () => {
    throw new Error('chat unavailable');
  });

  const result = await extractFacts(llm, helloTurns);

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('completeJson abort is not swallowed', async () => {
  const llm = fakeLlm(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(() => extractFacts(llm, helloTurns), { name: 'AbortError' });
});

test('markdown-fenced JSON still parses', async () => {
  const llm = fakeLlm(async () => `\`\`\`json\n${JSON.stringify(validFacts)}\n\`\`\``);

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
  assert.equal(result.actionItems.length, 2);
  assert.equal(result.actionItems[1].owner, null);
});

test('JSON wrapped in prose still parses', async () => {
  const llm = fakeLlm(async () => `Sure!\n${JSON.stringify(validFacts)}\nHope this helps!`);

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
  assert.equal(result.actionItems[0].owner, 'Omar');
});

test('decoy braces before the payload do not hide facts', async () => {
  const llm = fakeLlm(
    async () => `Hope this {helps}! ${JSON.stringify({ foo: 1 })} ${JSON.stringify(validFacts)}`,
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
});

test('facts nested one object deep still parse', async () => {
  const llm = fakeLlm(async () => JSON.stringify({ result: validFacts }));

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Embeddings stay in SQLite');
});

test('a flood of unmatched braces does not stall parsing', { timeout: 1000 }, async () => {
  const llm = fakeLlm(async () => '{'.repeat(20_000));

  const result = await extractFacts(llm, helloTurns);

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('JSON with braces in strings and trailing braces still parses', async () => {
  const payload = {
    decisions: [{ text: 'Use } in copy', speaker: 'Maya', timestamp: '00:02:01' }],
    actionItems: [],
  };
  const llm = fakeLlm(async () => `Sure ${JSON.stringify(payload)} trailing }`);

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.deepEqual(result.actionItems, []);
});

test('empty valid JSON object yields empty arrays', async () => {
  const llm = fakeLlm(async () => '{"decisions":[],"actionItems":[]}');

  const result = await extractFacts(llm, helloTurns);

  assert.deepEqual(result, { decisions: [], actionItems: [] });
});

test('closing hygiene and recap restatements are dropped', async () => {
  const llm = fakeLlm(async () =>
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
        {
          text: 'Post notes from the customer interviews into Notion',
          owner: 'Priya',
          due: 'Wednesday',
          timestamp: '00:08:10',
        },
      ],
    }),
  );

  const result = await extractFacts(llm, lockingTurns);

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
    {
      text: 'Post notes from the customer interviews into Notion',
      owner: 'Priya',
      due: 'Wednesday',
      timestamp: '00:08:10',
    },
  ]);
});

test('NUL bytes are stripped from fact text', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Budget is ~\u0000£60k', speaker: 'Maya', timestamp: '00:02:01' }],
      actionItems: [],
    }),
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions[0].text, 'Budget is ~£60k');
});

test('NUL-only fact text is dropped', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: '\u0000\u0000', speaker: 'Maya', timestamp: '00:02:01' }],
      actionItems: [],
    }),
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.deepEqual(result.decisions, []);
});

test('extraction prompt keeps named assignments and clock-only timestamps', async () => {
  let system = '';
  const llm = fakeLlm(async (messages) => {
    system = messages[0]?.content ?? '';
    return '{"decisions":[],"actionItems":[]}';
  });

  await extractFacts(llm, helloTurns);

  assert.match(system, /can you/);
  assert.match(system, /I'll/);
  assert.match(system, /owner is that person, or null/);
  assert.match(system, /00:02:01 or 06:10/);
  assert.match(system, /due is a spoken deadline/);
  assert.match(system, /recap/);
  assert.match(system, /post notes/);
  assert.doesNotMatch(system, /"we can"/);
  assert.doesNotMatch(system, /"summary"/);
});

test('wrapped timestamps are stored as clock only', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [{ text: 'Lock SQLite', speaker: 'Maya', timestamp: '[[00:02:01]]' }],
      actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '(00:02:34)' }],
    }),
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions[0].timestamp, '00:02:01');
  assert.equal(result.actionItems[0].timestamp, '00:02:34');
});

test('trailing-comma JSON still keeps complete inner items', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"}],"actionItems":[{"text":"Write RFC","owner":"Omar","due":"Monday","timestamp":"00:02:34"}],}',
  );

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Use ,} in copy');
});

test('truncated JSON keeps complete items emitted before the cut', async () => {
  const llm = fakeLlm(
    async () =>
      '{"decisions":[{"text":"Lock SQLite","speaker":"Maya","timestamp":"00:02:01"},{"text":"Ship',
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Lock SQLite');
  assert.equal(result.actionItems.length, 0);
});

test('truncated JSON keeps an action item even when the model copies speaker', async () => {
  const llm = fakeLlm(
    async () =>
      '{"actionItems":[{"text":"Write RFC","speaker":"Maya","owner":"Omar","due":"Monday","timestamp":"00:02:34"},{"text":"Ship',
  );

  const result = await extractFacts(llm, rfcTurns);

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

  const result = await extractFacts(llm, lockingTurns);

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

  const result = await extractFacts(llm, rfcTurns);

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

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].text, 'Write RFC');
  assert.equal(result.actionItems[0].due, 'Monday');
});

test('a single window does not run a reconcile prompt', async () => {
  const calls: ChatMessage[][] = [];
  const llm = fakeLlm(async (messages) => {
    calls.push(messages);
    return JSON.stringify(validFacts);
  });

  await extractFacts(llm, helloTurns);

  assert.equal(calls.length, 1);
  assert.match(calls[0][0].content, /locked decisions/);
  assert.doesNotMatch(calls[0][0].content, /near-duplicate/);
  assert.doesNotMatch(calls[0][0].content, /"summary"/);
  assert.match(calls[0][1].content, /\[Ada, 00:00:01\]: hello/);
});

test('exact duplicate decision text in one window is kept once', async () => {
  const llm = fakeLlm(async () =>
    JSON.stringify({
      decisions: [
        { text: 'Lock SQLite', speaker: 'Maya', timestamp: '00:02:01' },
        { text: 'lock sqlite', speaker: 'Maya', timestamp: '00:03:00' },
      ],
      actionItems: [],
    }),
  );

  const result = await extractFacts(llm, lockingTurns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Lock SQLite');
});

const twoDistinctFacts = {
  decisions: [
    { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
    { text: 'Lock storage', speaker: 'Ada', timestamp: '00:00:02' },
  ],
  actionItems: [],
};

test('several windows map in parallel then reconcile once', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const windows = packWindows(turns);
  assert.ok(windows.length >= 2);

  const calls: ChatMessage[][] = [];
  const llm = fakeLlm(async (messages) => {
    calls.push(messages);
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }],
        actionItems: [],
      });
    }
    return JSON.stringify({
      summary: 'Locked a ship decision.',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.equal(calls.length, windows.length + 1);
  assert.equal(calls.filter((call) => /near-duplicate/.test(call[0]?.content ?? '')).length, 1);
  const reduce = calls[calls.length - 1];
  assert.match(reduce[0].content, /near-duplicate/);
  assert.match(reduce[1].content, /Locked a ship decision/);
  assert.doesNotMatch(reduce[1].content, /Ada: x{20}/);
  assert.match(calls[0][0].content, /"summary"/);
  assert.deepEqual(result.decisions, [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }]);
});

test('a failed window is dropped and the rest still reconcile', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [{ text: 'Keep this', speaker: 'Ada', timestamp: '00:00:01' }],
        actionItems: [],
      });
    }
    if (/\[Ada, 00:00:00\]/.test(messages[1]?.content ?? '')) {
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
  });

  const result = await extractFacts(llm, turns);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].text, 'Keep this');
});

test('reconcile failure keeps the exact-deduped concatenation', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      throw new Error('reconcile failed');
    }
    return JSON.stringify({
      summary: 'ok',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0].text, 'Ship it');
  assert.equal(result.decisions[1].text, 'Lock storage');
});

test('unreadable reconcile keeps the window facts', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return 'cannot comply';
    }
    return JSON.stringify({
      summary: 'ok',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0].text, 'Ship it');
  assert.equal(result.decisions[1].text, 'Lock storage');
});

test('empty reconcile keeps the window facts', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return '{"decisions":[],"actionItems":[]}';
    }
    return JSON.stringify({
      summary: 'ok',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.equal(result.decisions.length, 2);
});

test('reconcile drops invented items and keeps known wording', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [
          { text: 'Acquire competitor', speaker: 'CEO', timestamp: '00:00:01' },
          { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
        ],
        actionItems: [],
      });
    }
    return JSON.stringify({
      summary: 'ok',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.deepEqual(result.decisions, [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }]);
});

test('reconcile cannot rewrite speaker timestamp owner or due', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [{ text: 'Ship it', speaker: 'IMPOSTOR', timestamp: '23:59:59' }],
        actionItems: [
          { text: 'Write RFC', owner: 'IMPOSTOR', due: 'Never', timestamp: '23:59:59' },
        ],
      });
    }
    return JSON.stringify({
      summary: 'ok',
      decisions: [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }],
      actionItems: [{ text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:00:02' }],
    });
  });

  const result = await extractFacts(llm, turns);

  assert.deepEqual(result.decisions, [{ text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' }]);
  assert.deepEqual(result.actionItems, [
    { text: 'Write RFC', owner: 'Omar', due: 'Monday', timestamp: '00:00:02' },
  ]);
});

test('reconcile that rephrases most rows keeps the window facts', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const threeFacts = {
    decisions: [
      { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
      { text: 'Lock storage', speaker: 'Ada', timestamp: '00:00:02' },
      { text: 'Freeze Friday', speaker: 'Ada', timestamp: '00:00:03' },
    ],
    actionItems: [],
  };
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [
          { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
          { text: 'Storage is now locked for v1', speaker: 'Ada', timestamp: '00:00:02' },
          { text: 'Friday is the freeze date', speaker: 'Ada', timestamp: '00:00:03' },
        ],
        actionItems: [],
      });
    }
    return JSON.stringify({
      summary: 'ok',
      ...threeFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.deepEqual(result.decisions, threeFacts.decisions);
});

test('reconcile maps reworded text back to the original wording', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      return JSON.stringify({
        decisions: [
          { text: 'Ship it', speaker: 'Ada', timestamp: '00:00:01' },
          { text: 'Lock storage in SQLite', speaker: 'Ada', timestamp: '00:00:02' },
        ],
        actionItems: [],
      });
    }
    return JSON.stringify({
      summary: 'ok',
      ...twoDistinctFacts,
    });
  });

  const result = await extractFacts(llm, turns);

  assert.deepEqual(result.decisions, twoDistinctFacts.decisions);
});

test('marathon maps every window including the tail and skips an empty reduce', async () => {
  const turns = parseTranscript(readFileSync(marathonPath, 'utf8'));
  const windows = packWindows(turns);
  const calls: ChatMessage[][] = [];
  const llm = fakeLlm(async (messages) => {
    calls.push(messages);
    return '{"summary":"","decisions":[],"actionItems":[]}';
  });

  await extractFacts(llm, turns);

  assert.equal(calls.length, windows.length);
  assert.ok(calls.some((call) => call[1]?.content.includes('onboarding buddy rota')));
  assert.equal(calls.filter((call) => /near-duplicate/.test(call[0]?.content ?? '')).length, 0);
});

test('later window fills owner and due on the same action text', async () => {
  const turns = numberedTurns(40, 'x'.repeat(400));
  const calls: ChatMessage[][] = [];
  const llm = fakeLlm(async (messages) => {
    calls.push(messages);
    if (/\[Ada, 00:00:00\]/.test(messages[1]?.content ?? '')) {
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
  });

  const result = await extractFacts(llm, turns);

  assert.equal(result.actionItems.length, 1);
  assert.deepEqual(result.actionItems[0], {
    text: 'Write RFC',
    owner: 'Omar',
    due: 'Monday',
    timestamp: '00:00:01',
  });
  assert.equal(calls.filter((call) => /near-duplicate/.test(call[0]?.content ?? '')).length, 0);
});

test(
  'oversized per-window payloads skip reduce instead of looping',
  { timeout: 5000 },
  async () => {
    const turns = numberedTurns(40, 'x'.repeat(400));
    const windows = packWindows(turns);
    assert.ok(windows.length >= 2);
    let calls = 0;
    const llm = fakeLlm(async () => {
      calls += 1;
      const text = `fact-${calls}-${'y'.repeat(50_000)}`;
      return JSON.stringify({
        summary: 'z'.repeat(50_000),
        decisions: [{ text, speaker: 'Ada', timestamp: '00:00:01' }],
        actionItems: [],
      });
    });

    const result = await extractFacts(llm, turns);

    assert.equal(calls, windows.length);
    assert.equal(result.decisions.length, windows.length);
  },
);

test('payloads over MERGE_MAX_CHARS collapse then reconcile', async () => {
  const turns = numberedTurns(120, 'x'.repeat(400));
  const windows = packWindows(turns);
  assert.ok(windows.length >= 3);
  const bulky = {
    summary: 'ok',
    decisions: [
      ...twoDistinctFacts.decisions,
      { text: 'y'.repeat(20_000), speaker: 'Ada', timestamp: '00:00:03' },
    ],
    actionItems: [],
  };
  let reduceCalls = 0;
  const llm = fakeLlm(async (messages) => {
    if (/near-duplicate/.test(messages[0]?.content ?? '')) {
      reduceCalls += 1;
      return JSON.stringify({
        decisions: twoDistinctFacts.decisions,
        actionItems: [],
      });
    }
    return JSON.stringify(bulky);
  });

  const result = await extractFacts(llm, turns);

  assert.ok(reduceCalls >= 2, `expected collapse then reconcile, got ${reduceCalls}`);
  assert.equal(result.decisions.length, 2);
});
