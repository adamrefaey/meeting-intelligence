import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clockToSeconds,
  parseInlineCitations,
  segmentAnswer,
  type CitationTurn,
} from '../src/lib/citations.ts';

function turn(
  speaker: string,
  timestamp: string,
  startSeconds: number,
  text: string,
): CitationTurn {
  return { speaker, timestamp, startSeconds, text };
}

function citeShape(text: string) {
  const cite = parseInlineCitations(text)[0];
  return cite === undefined
    ? undefined
    : {
        raw: cite.raw,
        speaker: cite.speaker,
        start: cite.startTimestamp,
        end: cite.endTimestamp,
        seconds: cite.startSeconds,
      };
}

// Copied from fixtures/transcripts/town-hall-qna.txt, including Keiko's much later
// follow-up so a grounded chip has a chance to wander to the wrong stretch.
const townHallSlice = [
  turn('Keiko', '00:04:14', 254, 'Hi. Can you hear me?'),
  turn(
    'Keiko',
    '00:04:17',
    257,
    "So my question is about the remote-first thing, and\nspecifically about people who've already moved.",
  ),
  turn(
    'Keiko',
    '00:04:25',
    265,
    "I moved to Lisbon in September under the temporary\npolicy, and I've been told twice that the permanent policy is coming,\nand it's now January.",
  ),
  turn('Keiko', '00:04:37', 277, 'So, what happens to me on the first of February?'),
  turn(
    'Grace',
    '00:04:51',
    291,
    "Yeah. So, Keiko, short answer, nothing changes for\nyou badly. You're not going to be asked to move back.",
  ),
  turn(
    'Keiko',
    '00:25:08',
    1508,
    'Just a quick one. Grace, when you publish the\ncountry list, can you also say what happens if someone wants to move\nsomewhere not on it?',
  ),
  turn('Malik', '00:05:50', 350, "Hi. So mine is the flip side of Keiko's."),
  turn(
    'Malik',
    '00:05:55',
    355,
    "I'm in London and I like being in London and I like\nthe office. Does remote-first mean the office gets worse?",
  ),
];

const footnoteSlice = [
  turn(
    'Alex',
    '00:00:12',
    12,
    "Hello everyone, welcome to the Q4 town hall. I'm Alex, I'm hosting.",
  ),
  turn('Alex', '00:00:24', 24, 'A few logistics. We have people in the room in London.'),
  turn('Victoria', '00:00:59', 59, 'Thanks Alex. Hello everyone.'),
  turn('Conference Room B', '00:01:09', 69, "We can't hear you very well in here."),
  turn('Victoria', '00:02:20', 140, 'We had two significant incidents.'),
  turn(
    'Keiko',
    '00:04:17',
    257,
    "So my question is about the remote-first thing, and specifically about people who've already moved.",
  ),
  turn('Malik', '00:05:50', 350, "Hi. So mine is the flip side of Keiko's."),
];

const REMOTE_QUESTION = 'Who asked about remote work?';

function chipTimes(answer: string, question = '', turns: CitationTurn[] = townHallSlice): string[] {
  const clocks: string[] = [];
  for (const segment of segmentAnswer(answer, turns, question)) {
    if (segment.type === 'cite') {
      clocks.push(segment.citation.startTimestamp);
    }
  }
  return clocks;
}

function painted(answer: string, turns: CitationTurn[]): string {
  return segmentAnswer(answer, turns)
    .map((segment) =>
      segment.type === 'text' ? segment.text : `‹${segment.citation.startTimestamp}›`,
    )
    .join('');
}

// The four clock shapes parseTranscript accepts, so a cite lands on the turn it names.
test('clockToSeconds agrees with transcript turns for every accepted clock shape', () => {
  assert.equal(clockToSeconds('00:01:52'), 112, '[HH:MM:SS] and bare HH:MM:SS');
  assert.equal(clockToSeconds('1:52'), 112, 'Speaker (M:SS)');
  assert.equal(clockToSeconds('01:52'), 112, '[MM:SS]');
  assert.equal(clockToSeconds('02:36:00'), 9360, 'past the first hour');
  assert.equal(clockToSeconds('nope'), undefined);
});

test('parseInlineCitations reads the shapes the model emits', () => {
  for (const { text, ...expected } of [
    {
      text: 'Victoria spoke first [Ada, 00:01:52] in the room.',
      raw: '[Ada, 00:01:52]',
      speaker: 'Ada',
      start: '00:01:52',
      end: undefined,
      seconds: 112,
    },
    {
      text: '[Ada, 00:01:52–00:04:00]',
      raw: '[Ada, 00:01:52–00:04:00]',
      speaker: 'Ada',
      start: '00:01:52',
      end: '00:04:00',
      seconds: 112,
    },
    {
      text: '[Ada, 00:01:52-00:04:00]',
      raw: '[Ada, 00:01:52-00:04:00]',
      speaker: 'Ada',
      start: '00:01:52',
      end: '00:04:00',
      seconds: 112,
    },
    {
      text: 'Alex [00:23:10–00:25:19] spoke.',
      raw: '[00:23:10–00:25:19]',
      speaker: '',
      start: '00:23:10',
      end: '00:25:19',
      seconds: 1390,
    },
    {
      text: 'See [00:01:52] for the policy.',
      raw: '[00:01:52]',
      speaker: '',
      start: '00:01:52',
      end: undefined,
      seconds: 112,
    },
    {
      text: 'See 【[00:22:39]】.',
      raw: '【[00:22:39]】',
      speaker: '',
      start: '00:22:39',
      end: undefined,
      seconds: 1359,
    },
    {
      text: 'See 【00:19:34】.',
      raw: '【00:19:34】',
      speaker: '',
      start: '00:19:34',
      end: undefined,
      seconds: 1174,
    },
    {
      text: 'Keiko asked 【[Keiko, 00:04:17]】 about remote work.',
      raw: '【[Keiko, 00:04:17]】',
      speaker: 'Keiko',
      start: '00:04:17',
      end: undefined,
      seconds: 257,
    },
    // Square brackets bound the name, so "Last, First" still parses. Bare 【】 has no inner
    // delimiter, so a comma there can only mean the end of the name.
    {
      text: 'As noted [Chen, Alice, 00:04:17] earlier.',
      raw: '[Chen, Alice, 00:04:17]',
      speaker: 'Chen, Alice',
      start: '00:04:17',
      end: undefined,
      seconds: 257,
    },
    {
      text: 'As noted 【[Chen, Alice, 00:04:17]】 earlier.',
      raw: '【[Chen, Alice, 00:04:17]】',
      speaker: 'Chen, Alice',
      start: '00:04:17',
      end: undefined,
      seconds: 257,
    },
    // An unclosed wrap still yields the inner square cite.
    {
      text: 'See 【[00:22:39]',
      raw: '[00:22:39]',
      speaker: '',
      start: '00:22:39',
      end: undefined,
      seconds: 1359,
    },
  ]) {
    assert.deepEqual(citeShape(text), expected, text);
  }
});

test('parseInlineCitations ignores brackets that are not citations', () => {
  assert.deepEqual(parseInlineCitations('See [the plan] and [Ada] before lunch.'), []);
  assert.deepEqual(parseInlineCitations('【00:01:52]'), []);
  assert.deepEqual(parseInlineCitations('[00:01:52】'), []);
  assert.deepEqual(parseInlineCitations('【[00:22:39】'), []);
  assert.deepEqual(parseInlineCitations('【Chen, Alice, 00:04:17】'), []);
});

// Two adjacent wraps: if the inner [clock] matched on its own, rebuilt would still
// equal the answer, so leftover 【】 is the check that the wrap was consumed whole.
test('segmentAnswer replaces each cite with a chip and leaves the rest as text', () => {
  const answer = 'See 【[00:22:39]】 【[00:19:34]】 about [the plan].';
  let cites = 0;
  let leftover = '';
  let rebuilt = '';
  for (const segment of segmentAnswer(answer)) {
    if (segment.type === 'cite') {
      cites += 1;
      rebuilt += segment.citation.raw;
    } else {
      leftover += segment.text;
      rebuilt += segment.text;
    }
  }
  assert.equal(rebuilt, answer);
  assert.equal(cites, 2);
  assert.doesNotMatch(leftover, /[【】]/);
  assert.match(leftover, /\[the plan\]/);
});

// The model answers this question as a bare list, so there are no content words beside
// the chip to match on. The question itself is the only claim available.
test('grounds a terse list answer using the question that produced it', () => {
  assert.deepEqual(
    chipTimes('- Keiko — [Keiko, 00:04:14]\n- Malik — [Malik, 00:05:50]', REMOTE_QUESTION),
    ['00:04:17', '00:05:55'],
  );
  assert.deepEqual(chipTimes('- Keiko — [00:04:14]\n- Malik — [00:05:50]', REMOTE_QUESTION), [
    '00:04:17',
    '00:05:55',
  ]);
});

test('a claim beside the chip outranks the cited clock and the question', () => {
  assert.deepEqual(
    chipTimes(
      'Keiko asked what happens to people who had already moved [Keiko, 00:04:14].',
      REMOTE_QUESTION,
    ),
    ['00:04:17'],
  );
  assert.deepEqual(
    chipTimes('Keiko asked Grace to publish the country list [Keiko, 00:04:14].', REMOTE_QUESTION),
    ['00:25:08'],
  );
});

// The model cites each speaker's first clock. The chip must land on the turn that
// actually supports that sentence, which is what a user clicking it expects.
test('grounds a first-speech citation onto the turn that supports each claim', () => {
  const answer =
    'Keiko asked about the remote-first policy [Keiko, 00:04:14]. ' +
    'Malik also asked whether remote-first would make the office worse [Malik, 00:05:50].';
  assert.deepEqual(chipTimes(answer), ['00:04:17', '00:05:55']);
});

// A chip naming a speaker has to land on that speaker's turn, or clicking it scrolls to
// someone else. Here the model pairs Keiko with Grace's clock, and Grace's reply matches
// the claim better than any Keiko turn does, so judging the cited turn without checking
// who owns it would keep the mismatch.
test('never keeps a citation whose clock belongs to another speaker', () => {
  const [clock] = chipTimes('Keiko was told nothing changes badly [Keiko, 00:04:51].');
  assert.notEqual(clock, '00:04:51');
  assert.equal(townHallSlice.find((entry) => entry.timestamp === clock)?.speaker, 'Keiko');
});

test('does not move a cite that is already right, or guess when nothing matches', () => {
  assert.deepEqual(chipTimes('Keiko asked about remote-first [Keiko, 00:04:17].'), ['00:04:17']);
  assert.deepEqual(chipTimes('Keiko asked about dental insurance [Keiko, 00:04:14].'), [
    '00:04:14',
  ]);
});

test('a chip is not grounded from an earlier line or a roster question', () => {
  assert.deepEqual(chipTimes('- Grace\n- Keiko [Keiko, 00:04:14]'), ['00:04:14']);
  assert.deepEqual(chipTimes('- Keiko [Keiko, 00:04:14]', 'Who are the people in this meeting?'), [
    '00:04:14',
  ]);
});

// Luna answers a roster with timestamp-only footnotes. The cited clock is Alex; the
// claim names Conference Room B, so the chip has to land on their turn.
test('grounds a timestamp-only cite onto the speaker named in the claim', () => {
  assert.deepEqual(
    chipTimes(
      'There is also a participant labeled "Conference Room B." [00:00:24]',
      'Who are the people in this meeting?',
      footnoteSlice,
    ),
    ['00:01:09'],
  );
});

// Trailing clocks with nothing but whitespace in front are footnotes, not claims.
test('moves footnote clocks onto the named list items they belong to', () => {
  const shown = painted(
    '- Victoria\n- Keiko\n- Malik\n\n[00:02:20] [00:04:17] [00:05:50]',
    footnoteSlice,
  );
  assert.match(shown, /Victoria ‹00:02:20›/);
  assert.match(shown, /Keiko ‹00:04:17›/);
  assert.match(shown, /Malik ‹00:05:50›/);
  assert.doesNotMatch(shown, /\[00:02:20\]/);
});

test('drops a footnote whose speaker is already cited on that line', () => {
  assert.deepEqual(
    chipTimes(
      'There is also a participant labeled "Conference Room B." [00:00:24]\n[00:01:09]',
      '',
      footnoteSlice,
    ),
    ['00:01:09'],
  );
});

test('moves a trailing named-cite dump off the last sentence onto list items', () => {
  const shown = painted(
    '- Alex\n- Victoria\n- Keiko\n\nThere is also a participant labeled "Conference Room B." ' +
      '[Alex, 00:00:12] [Victoria, 00:00:55] [Keiko, 00:04:14] [Conference Room B, 00:01:09]',
    footnoteSlice,
  );
  assert.match(shown, /Alex ‹00:00:12›/);
  assert.match(shown, /Victoria ‹00:00:59›/);
  assert.match(shown, /Keiko ‹00:04:17›/);
  assert.match(shown, /Conference Room B\." ‹00:01:09›/);
  const lastSentence = shown.slice(shown.indexOf('There is also'));
  assert.doesNotMatch(lastSentence, /‹00:00:12›|‹00:00:55›|‹00:04:14›/);
});
