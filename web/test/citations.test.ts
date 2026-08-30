import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockToSeconds, parseInlineCitations, segmentAnswer } from '../src/lib/citations.ts';

// The four clock shapes parseTranscript accepts, so a cite lands on the turn it names.
test('clockToSeconds agrees with transcript turns for every accepted clock shape', () => {
  assert.equal(clockToSeconds('00:01:52'), 112, '[HH:MM:SS] and bare HH:MM:SS');
  assert.equal(clockToSeconds('1:52'), 112, 'Speaker (M:SS)');
  assert.equal(clockToSeconds('01:52'), 112, '[MM:SS]');
  assert.equal(clockToSeconds('02:36:00'), 9360, 'past the first hour');
  assert.equal(clockToSeconds('nope'), undefined);
});

test('copying a turn prefix cites that turn, not an earlier greeting by the same speaker', () => {
  const question = '[Keiko, 00:04:17]: So my question is about the remote-first thing';
  const [cite] = parseInlineCitations(`Keiko asked ${question}`);
  assert.equal(cite?.speaker, 'Keiko');
  assert.equal(cite?.startTimestamp, '00:04:17');
  assert.equal(cite?.startSeconds, 257);
  assert.equal(cite?.raw, '[Keiko, 00:04:17]');
});

test('parseInlineCitations reads [Speaker, timestamp]', () => {
  const [cite] = parseInlineCitations('Victoria spoke first [Ada, 00:01:52] in the room.');
  assert.deepEqual(cite, {
    raw: '[Ada, 00:01:52]',
    speaker: 'Ada',
    startTimestamp: '00:01:52',
    endTimestamp: undefined,
    startSeconds: 112,
    index: 21,
    length: 15,
  });
});

test('parseInlineCitations reads an en-dash time range', () => {
  const [cite] = parseInlineCitations('[Victoria, 00:01:52–00:04:00]');
  assert.equal(cite?.speaker, 'Victoria');
  assert.equal(cite?.startTimestamp, '00:01:52');
  assert.equal(cite?.endTimestamp, '00:04:00');
  assert.equal(cite?.startSeconds, 112);
});

test('parseInlineCitations reads a hyphen time range', () => {
  const [cite] = parseInlineCitations('[Ada, 00:01:52-00:04:00]');
  assert.equal(cite?.endTimestamp, '00:04:00');
});

test('parseInlineCitations ignores brackets that are not citations', () => {
  const cites = parseInlineCitations('See [the plan] and [Ada] before lunch.');
  assert.deepEqual(cites, []);
});

test('parseInlineCitations reads a timestamp range with no speaker', () => {
  const [cite] = parseInlineCitations('Alex [00:23:10–00:25:19] spoke.');
  assert.equal(cite?.speaker, '');
  assert.equal(cite?.startTimestamp, '00:23:10');
  assert.equal(cite?.endTimestamp, '00:25:19');
  assert.equal(cite?.startSeconds, 1390);
});

test('parseInlineCitations reads a timestamp-only cite', () => {
  const [cite] = parseInlineCitations('See [00:01:52] for the policy.');
  assert.equal(cite?.speaker, '');
  assert.equal(cite?.startTimestamp, '00:01:52');
  assert.equal(cite?.endTimestamp, undefined);
  assert.equal(cite?.startSeconds, 112);
});

test('parseInlineCitations reads a Luna 【[clock]】 wrap as one cite', () => {
  const [cite] = parseInlineCitations('See 【[00:22:39]】.');
  assert.equal(cite?.raw, '【[00:22:39]】');
  assert.equal(cite?.speaker, '');
  assert.equal(cite?.startTimestamp, '00:22:39');
  assert.equal(cite?.startSeconds, 1359);
  assert.equal(cite?.length, '【[00:22:39]】'.length);
});

test('parseInlineCitations reads a Luna 【clock】 wrap without inner squares', () => {
  const [cite] = parseInlineCitations('See 【00:19:34】.');
  assert.equal(cite?.raw, '【00:19:34】');
  assert.equal(cite?.startTimestamp, '00:19:34');
  assert.equal(cite?.startSeconds, 1174);
});

test('parseInlineCitations reads a named cite inside lenticular brackets', () => {
  const [cite] = parseInlineCitations('Keiko asked 【[Keiko, 00:04:17]】 about remote work.');
  assert.equal(cite?.speaker, 'Keiko');
  assert.equal(cite?.startTimestamp, '00:04:17');
  assert.equal(cite?.raw, '【[Keiko, 00:04:17]】');
});

// Square brackets bound the name, so a "Last, First" speaker still parses; the bare 【】
// form has no inner delimiter, so there a comma can only mean the end of the name.
test('parseInlineCitations reads a speaker name containing a comma', () => {
  const [square] = parseInlineCitations('As noted [Chen, Alice, 00:04:17] earlier.');
  assert.equal(square?.speaker, 'Chen, Alice');
  assert.equal(square?.startTimestamp, '00:04:17');
  assert.equal(square?.raw, '[Chen, Alice, 00:04:17]');

  const [wrapped] = parseInlineCitations('As noted 【[Chen, Alice, 00:04:17]】 earlier.');
  assert.equal(wrapped?.speaker, 'Chen, Alice');
  assert.equal(wrapped?.raw, '【[Chen, Alice, 00:04:17]】');

  assert.deepEqual(parseInlineCitations('【Chen, Alice, 00:04:17】'), []);
});

test('parseInlineCitations requires matching wrap delimiters', () => {
  assert.deepEqual(parseInlineCitations('【00:01:52]'), []);
  assert.deepEqual(parseInlineCitations('[00:01:52】'), []);
  assert.deepEqual(parseInlineCitations('【[00:22:39】'), []);
  const [inner] = parseInlineCitations('See 【[00:22:39]');
  assert.equal(inner?.raw, '[00:22:39]');
});

test('segmentAnswer does not leave 【】 around a lenticular-wrapped chip', () => {
  const answer =
    'There is also an unidentified speaker and Conference Room B. 【[00:22:39]】 【[00:19:34]】';
  const segments = segmentAnswer(answer);
  const leftover = segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.text)
    .join('');
  assert.equal(leftover.includes('【'), false);
  assert.equal(leftover.includes('】'), false);
  assert.equal(segments.filter((segment) => segment.type === 'cite').length, 2);
});

// Chips are only ever rendered from segments, so this is what stops a chip appearing
// under an answer that never referenced it.
test('segments rebuild the answer exactly, so every chip has text around it', () => {
  const answer =
    'Keiko asked [Keiko, 00:04:17] and Alex replied [Alex, 00:04:31] about [the plan].';
  const rebuilt = segmentAnswer(answer)
    .map((segment) => (segment.type === 'text' ? segment.text : segment.citation.raw))
    .join('');
  assert.equal(rebuilt, answer);
  assert.equal(segmentAnswer(answer).filter((segment) => segment.type === 'cite').length, 2);
});

test('segmentAnswer replaces citations and leaves other brackets as text', () => {
  const segments = segmentAnswer('Ada agreed [Ada, 00:01:52] on [the plan].');
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { type: 'text', text: 'Ada agreed ' });
  assert.equal(segments[1]?.type, 'cite');
  if (segments[1]?.type === 'cite') {
    assert.equal(segments[1].citation.speaker, 'Ada');
    assert.equal(segments[1].citation.startSeconds, 112);
  }
  assert.deepEqual(segments[2], { type: 'text', text: ' on [the plan].' });
});

test('segmentAnswer turns a timestamp-range cite into a chip segment', () => {
  const segments = segmentAnswer('- Alex [00:23:10–00:25:19]');
  assert.equal(segments[0]?.type, 'text');
  assert.equal(segments[1]?.type, 'cite');
  if (segments[1]?.type === 'cite') {
    assert.equal(segments[1].citation.speaker, '');
    assert.equal(segments[1].citation.startTimestamp, '00:23:10');
    assert.equal(segments[1].citation.startSeconds, 1390);
  }
});

test('segmentAnswer returns nothing for an empty answer', () => {
  assert.deepEqual(segmentAnswer(''), []);
});

function turn(
  speaker: string,
  timestamp: string,
  startSeconds: number,
  text: string,
): { speaker: string; timestamp: string; startSeconds: number; text: string } {
  return { speaker, timestamp, startSeconds, text };
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
  turn('Malik', '00:06:23', 383, "That's exactly what I'm worried about."),
];

const REMOTE_QUESTION = 'Who asked about remote work?';

function chipTimes(
  answer: string,
  question = '',
  turns: {
    speaker: string;
    timestamp: string;
    startSeconds: number;
    text: string;
  }[] = townHallSlice,
): string[] {
  return segmentAnswer(answer, turns, question)
    .filter((segment) => segment.type === 'cite')
    .map((segment) => (segment.type === 'cite' ? segment.citation.startTimestamp : ''));
}

// The model answers this question as a bare list, so there are no content words beside
// the chip to match on. The question itself is the only claim available.
test('grounds a terse list answer using the question that produced it', () => {
  const answer = '- Keiko — [Keiko, 00:04:14]\n- Malik — [Malik, 00:05:50]';
  assert.deepEqual(chipTimes(answer, REMOTE_QUESTION), ['00:04:17', '00:05:55']);
});

test('grounds a terse list answer whose cites carry no speaker', () => {
  const answer = '- Keiko — [00:04:14]\n- Malik — [00:05:50]';
  assert.deepEqual(chipTimes(answer, REMOTE_QUESTION), ['00:04:17', '00:05:55']);
});

test('a claim beside the chip outranks the question', () => {
  const answer = 'Keiko asked what happens to people who had already moved [Keiko, 00:04:14].';
  assert.deepEqual(chipTimes(answer, REMOTE_QUESTION), ['00:04:17']);
});

test('grounding can reach a later follow-up when the claim points there', () => {
  const answer = 'Keiko asked Grace to publish the country list [Keiko, 00:04:14].';
  assert.deepEqual(chipTimes(answer, REMOTE_QUESTION), ['00:25:08']);
});

// A chip naming a speaker has to land on that speaker's turn, or clicking it scrolls to
// someone else. Here the model pairs Keiko with Grace's clock, and Grace's reply matches
// the claim better than any Keiko turn does, so judging the cited turn without checking
// who owns it would keep the mismatch.
test('never keeps a citation whose clock belongs to another speaker', () => {
  const answer = 'Keiko was told nothing changes badly [Keiko, 00:04:51].';
  const landed = townHallSlice.find((t) => t.timestamp === chipTimes(answer)[0]);
  assert.equal(landed?.speaker, 'Keiko');
});

// The model cites each speaker's first clock. The chip must land on the turn
// that actually supports the sentence, which is what a user clicking it expects.
test('grounds a first-speech citation onto the turn that supports the claim', () => {
  const answer =
    'Keiko asked about the remote-first policy [Keiko, 00:04:14]. ' +
    'Malik also asked whether remote-first would make the office worse [Malik, 00:05:50].';
  const chips = segmentAnswer(answer, townHallSlice).filter((segment) => segment.type === 'cite');
  assert.equal(chips.length, 2);
  assert.equal(chips[0]?.type === 'cite' ? chips[0].citation.startTimestamp : '', '00:04:17');
  assert.equal(chips[0]?.type === 'cite' ? chips[0].citation.startSeconds : 0, 257);
  assert.equal(chips[1]?.type === 'cite' ? chips[1].citation.startTimestamp : '', '00:05:55');
  assert.equal(chips[1]?.type === 'cite' ? chips[1].citation.startSeconds : 0, 355);
});

test('keeps a citation that already points at the supporting turn', () => {
  const answer = 'Keiko asked about remote-first [Keiko, 00:04:17].';
  const chips = segmentAnswer(answer, townHallSlice).filter((segment) => segment.type === 'cite');
  assert.equal(chips[0]?.type === 'cite' ? chips[0].citation.startTimestamp : '', '00:04:17');
});

test('does not guess when the claim matches no turn by that speaker', () => {
  const answer = 'Keiko asked about dental insurance [Keiko, 00:04:14].';
  const chips = segmentAnswer(answer, townHallSlice).filter((segment) => segment.type === 'cite');
  assert.equal(chips[0]?.type === 'cite' ? chips[0].citation.startTimestamp : '', '00:04:14');
});

const footnoteSlice = [
  turn('Alex', '00:00:00', 0, "And I think we're live."),
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

function painted(answer: string, turns = footnoteSlice, question = ''): string {
  return segmentAnswer(answer, turns, question)
    .map((segment) =>
      segment.type === 'text' ? segment.text : `‹${segment.citation.startTimestamp}›`,
    )
    .join('');
}

// Luna answers a roster with timestamp-only footnotes. The cited clock is Alex; the
// claim names Conference Room B, so the chip has to land on their turn.
test('grounds a timestamp-only cite onto the speaker named in the claim', () => {
  const answer = 'There is also a participant labeled "Conference Room B." [00:00:24]';
  assert.deepEqual(chipTimes(answer, 'Who are the people in this meeting?', footnoteSlice), [
    '00:01:09',
  ]);
});

// Trailing clocks with nothing but whitespace in front are footnotes, not claims.
test('segmentAnswer moves footnote clocks onto the named list items they belong to', () => {
  const answer = '- Victoria\n- Keiko\n- Malik\n\n[00:02:20] [00:04:17] [00:05:50]';
  const shown = painted(answer);
  assert.match(shown, /Victoria ‹00:02:20›/);
  assert.match(shown, /Keiko ‹00:04:17›/);
  assert.match(shown, /Malik ‹00:05:50›/);
  assert.equal(shown.includes('[00:02:20]'), false);
  assert.equal(segmentAnswer(answer, footnoteSlice).filter((s) => s.type === 'cite').length, 3);
});

test('drops a footnote whose speaker is already cited on that line', () => {
  const answer = 'There is also a participant labeled "Conference Room B." [00:00:24]\n[00:01:09]';
  const chips = segmentAnswer(answer, footnoteSlice).filter((segment) => segment.type === 'cite');
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.type === 'cite' ? chips[0].citation.startTimestamp : '', '00:01:09');
});

test('moves a trailing named-cite dump off the last sentence onto list items', () => {
  const answer =
    '- Alex\n- Victoria\n- Keiko\n\nThere is also a participant labeled "Conference Room B." ' +
    '[Alex, 00:00:12] [Victoria, 00:00:55] [Keiko, 00:04:14] [Conference Room B, 00:01:09]';
  const shown = painted(answer);
  assert.match(shown, /Alex ‹00:00:12›/);
  assert.match(shown, /Victoria ‹00:00:59›/);
  assert.match(shown, /Keiko ‹00:04:17›/);
  assert.match(shown, /Conference Room B\." ‹00:01:09›/);
  const lastSentence = shown.slice(shown.indexOf('There is also'));
  assert.equal(lastSentence.includes('‹00:00:12›'), false);
  assert.equal(lastSentence.includes('‹00:00:55›'), false);
  assert.equal(lastSentence.includes('‹00:04:14›'), false);
});

test('does not use uncited names on earlier lines as the claim for a chip', () => {
  const answer = '- Grace\n- Keiko [Keiko, 00:04:14]';
  assert.deepEqual(chipTimes(answer), ['00:04:14']);
});

test('a roster question does not pull a name-only cite onto a later turn', () => {
  const answer = '- Keiko [Keiko, 00:04:14]';
  assert.deepEqual(chipTimes(answer, 'Who are the people in this meeting?'), ['00:04:14']);
});
