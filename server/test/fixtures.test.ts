import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FACT_TRANSCRIPT_CHAR_LIMIT } from '../src/extract/facts.ts';
import { shouldUseFullTranscript } from '../src/rag/retrieve.ts';
import { chunkTurns, DEFAULT_MAX_CHARS } from '../src/transcript/chunk.ts';
import { parseTranscript } from '../src/transcript/parse.ts';

const fixturesDir = join(import.meta.dirname, '../../fixtures/transcripts');

// Mirrors FULL_CONTEXT_CHAR_THRESHOLD in .env. Fixtures are sized to sit on both
// sides of it so manual testing exercises the full-context and retrieval paths.
const FULL_CONTEXT_CHAR_THRESHOLD = 24_000;

function read(file: string): string {
  return readFileSync(join(fixturesDir, file), 'utf8');
}

/**
 * Speech-to-text exports wrap turns mid-sentence, so a phrase can straddle a
 * newline inside a single turn. Anything matching phrases against turn text has
 * to collapse whitespace first, and so does this test.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

function countLines(raw: string): number {
  return raw.split('\n').filter((line) => line.trim().length > 0).length;
}

type Fixture = {
  file: string;
  format: string;
  /** Turns are wrapped across lines the way a real ASR export writes them. */
  asr: boolean;
  chars: number;
  turns: number;
  speakers: string[];
  needles: string[][];
};

const cases: Fixture[] = [
  {
    file: 'standup.txt',
    format: '[HH:MM:SS], tiny, one line per turn',
    asr: false,
    chars: 834,
    turns: 15,
    speakers: ['Ada', 'Ben', 'Chen'],
    needles: [['health endpoint'], ['sqlite-vec']],
  },
  {
    file: 'planning.txt',
    format: '[HH:MM:SS], small, one line per turn',
    asr: false,
    chars: 2398,
    turns: 40,
    speakers: ['Maya', 'Omar', 'Priya', 'Sam'],
    needles: [['Embeddings stay in SQLite'], ['RFC out by Monday']],
  },
  {
    file: 'customer-interview.txt',
    format: 'Speaker (MM:SS), Otter-style export, blank line between turns',
    asr: true,
    chars: 23_940,
    turns: 295,
    speakers: ['Liam', 'Rachel'],
    needles: [
      ['CSV'],
      ['enterprise seat pricing'],
      ['transaction volume report', 'Monday'],
      ['interactive prototype'],
      ['signed URL'],
    ],
  },
  {
    file: 'solo-keynote.txt',
    format: 'Speaker (MM:SS), single speaker, long uninterrupted stretches',
    asr: true,
    chars: 24_249,
    turns: 161,
    speakers: ['Evelyn'],
    needles: [
      ['Raft'],
      ['election timeout'],
      ['whitepaper', 'Wednesday'],
      ['chaos testing workshop', 'Friday'],
    ],
  },
  {
    file: 'security-architecture-rfc.txt',
    format: 'bare HH:MM:SS, typographic punctuation, accented speaker names',
    asr: true,
    chars: 24_668,
    turns: 280,
    speakers: ['Aria', 'Núria', 'Tariq', 'Zoë'],
    needles: [
      ['Envoy sidecars'],
      ['SPIFFE'],
      ['RFC 042', 'Wednesday'],
      ['overhead benchmark', 'Friday'],
      ['certificate rotation', 'Tuesday'],
    ],
  },
  {
    file: 'sprint-retrospective.txt',
    format: '[HH:MM:SS], rapid short turns, crosstalk',
    asr: true,
    chars: 24_831,
    turns: 398,
    speakers: ['Carlos', 'Kofi', 'Leo', 'Mei', 'Nina'],
    needles: [
      ['two-reviewer policy'],
      ['smoke tests'],
      ['parallelisation', 'Thursday'],
      ['Figma to Tailwind', 'Tuesday'],
      ['flaky database integration tests', 'Friday'],
    ],
  },
  {
    file: 'town-hall-qna.txt',
    format: '[HH:MM:SS], high speaker density, diarisation failures',
    asr: true,
    chars: 24_894,
    turns: 268,
    speakers: [
      'Alex',
      'Brian',
      'Clara',
      'Conference Room B',
      'Dan',
      'Elena',
      'Frank',
      'Grace',
      'Henry',
      'Ivy',
      'Jonás',
      'Keiko',
      'Malik',
      'Nadia',
      'Omar',
      'Priya',
      'Unknown Speaker',
      'Victoria',
    ],
    needles: [
      ['remote-first'],
      ['hiring pipeline reviews', 'Monday'],
      ['headcount allocation plan', 'Thursday'],
      ['YubiKey', 'Tuesday'],
      ['support response SLA', 'Wednesday'],
    ],
  },
  {
    file: 'incident-postmortem.txt',
    format: '[HH:MM:SS], blameless postmortem',
    asr: true,
    chars: 25_143,
    turns: 284,
    speakers: ['Devon', 'Elena', 'Marcus', 'Priya', 'Sam'],
    needles: [
      ['PgBouncer'],
      ['idle in transaction'],
      ['staging by Tuesday'],
      ['exponential backoff with full jitter', 'Thursday'],
      ['customer incident summary', 'Friday'],
    ],
  },
  {
    file: 'executive-budget-review.txt',
    format: '[MM:SS], two-part timestamps',
    asr: true,
    chars: 25_552,
    turns: 312,
    speakers: ['Arthur', 'Chloe', 'Kiran', 'Rina', 'Victoria'],
    needles: [
      ['H100'],
      ['three hundred and fifty thousand pound budget'],
      ['cash flow', 'Friday'],
      ['RFP', 'Wednesday'],
      ['quota', 'Monday'],
    ],
  },
  {
    file: 'technical-war-room.txt',
    format: 'bare HH:MM:SS, technical detail spoken aloud',
    asr: true,
    chars: 28_346,
    turns: 350,
    speakers: ['Dave', 'Jax', 'Ophelia', 'Samira'],
    needles: [
      ['billing address ID'],
      ['idle in transaction'],
      ['legacy test hooks', 'Wednesday'],
      ['root-cause analysis', 'Friday'],
      ['[inaudible]'],
    ],
  },
  {
    file: 'all-hands-marathon.txt',
    format: '[HH:MM:SS], two-and-a-half-hour marathon',
    asr: true,
    chars: 106_337,
    turns: 1198,
    speakers: ['Alex', 'David', 'Kevin', 'Liam', 'Lisa', 'Maya', 'Ravi', 'Sarah', 'Tomas'],
    needles: [
      ['preview environments'],
      ['remote-first policy', 'Monday'],
      ['GPU cluster RFP', 'Wednesday'],
      ['webhook integration walkthrough', 'Thursday'],
      ['sales quota', 'Friday'],
      ['SLA report', 'Tuesday'],
      ['onboarding buddy rota', 'Monday'],
    ],
  },
];

for (const fixture of cases) {
  test(`${fixture.file} parses (${fixture.format})`, () => {
    const raw = read(fixture.file);
    assert.equal(raw.length, fixture.chars);

    const turns = parseTranscript(raw);
    assert.equal(turns.length, fixture.turns);
    assert.deepEqual([...new Set(turns.map((turn) => turn.speaker))].sort(), fixture.speakers);

    const texts = turns.map((turn) => flatten(turn.text));
    for (const parts of fixture.needles) {
      assert.ok(
        texts.some((text) => parts.every((part) => text.includes(flatten(part)))),
        `missing ${parts.join(' + ')} in ${fixture.file}`,
      );
    }
  });
}

test('ASR fixtures wrap turns across lines, baseline fixtures do not', () => {
  for (const fixture of cases) {
    const raw = read(fixture.file);
    const turns = parseTranscript(raw);
    const wrapped = turns.filter((turn) => turn.text.includes('\n')).length;

    if (!fixture.asr) {
      assert.equal(countLines(raw), turns.length, `${fixture.file} should be one line per turn`);
      assert.equal(wrapped, 0, `${fixture.file} should have no continuation lines`);
      continue;
    }

    // Continuation lines are the parser's least obvious branch: a line with no
    // speaker header is appended to the previous turn. Real exports lean on it
    // constantly, so every ASR fixture keeps it under load.
    assert.ok(countLines(raw) > turns.length, `${fixture.file} should have more lines than turns`);
    assert.ok(
      wrapped / turns.length >= 0.25,
      `${fixture.file} wraps only ${wrapped}/${turns.length} turns`,
    );
  }
});

test('no fixture pastes machine output a person would not read aloud', () => {
  // Speakers describe errors and queries in words. Nothing should look like a
  // block of text pasted from a terminal into the transcript.
  const forbidden: Array<[string, RegExp]> = [
    ['stack frame', /^\s*at \w[\w.]* \(/m],
    ['exception header', /\b(?:Type|Reference|Range|Syntax)Error:/],
    ['SQL statement', /\bSELECT\b[^\n]*\bFROM\b|\bALTER\s+(?:ROLE|TABLE)\b/i],
    ['JSON payload', /\{\s*"[A-Za-z_]+"\s*:/],
    ['source location', /\.(?:js|ts|py|rb):\d+:\d+/],
    ['snake_case identifier', /\b[a-z]+_[a-z]+_[a-z]+\b/],
  ];

  for (const fixture of cases) {
    const raw = read(fixture.file);
    for (const [label, pattern] of forbidden) {
      const match = pattern.exec(raw);
      assert.equal(match, null, `${fixture.file} contains a ${label}: ${match?.[0]}`);
    }
  }
});

test('fixtures straddle the full-context threshold in both directions', () => {
  const sized = cases.map((fixture) => ({
    file: fixture.file,
    full: shouldUseFullTranscript(fixture.chars, FULL_CONTEXT_CHAR_THRESHOLD),
  }));
  const fullContext = sized.filter((entry) => entry.full).map((entry) => entry.file);
  const retrieval = sized.filter((entry) => !entry.full).map((entry) => entry.file);

  assert.ok(fullContext.length >= 3, 'need fixtures below the threshold');
  assert.ok(retrieval.length >= 6, 'need fixtures above the threshold');

  // The two fixtures closest to the boundary, one on each side, so a change to
  // the threshold or to the chunker shows up here first.
  assert.ok(fullContext.includes('customer-interview.txt'));
  assert.ok(retrieval.includes('solo-keynote.txt'));

  const largestFull = Math.max(
    ...cases.filter((f) => fullContext.includes(f.file)).map((f) => f.chars),
  );
  const smallestRetrieval = Math.min(
    ...cases.filter((f) => retrieval.includes(f.file)).map((f) => f.chars),
  );
  assert.ok(
    smallestRetrieval - largestFull < 500,
    'the boundary pair should sit within 500 chars of each other',
  );
});

test('all-hands-marathon drops late commitments from fact extraction', () => {
  const raw = read('all-hands-marathon.txt');
  assert.ok(
    raw.length > FACT_TRANSCRIPT_CHAR_LIMIT,
    `marathon fixture must exceed ${FACT_TRANSCRIPT_CHAR_LIMIT} chars to exercise truncation`,
  );

  // Retrieval indexes the whole transcript while fact extraction only sees the
  // first FACT_TRANSCRIPT_CHAR_LIMIT chars. This commitment lands in the gap, so
  // asking about it should surface an answer that the facts panel never lists.
  const needle = 'onboarding buddy rota';
  assert.ok(raw.indexOf(needle) > FACT_TRANSCRIPT_CHAR_LIMIT, `${needle} must fall past the limit`);
  assert.ok(!raw.slice(0, FACT_TRANSCRIPT_CHAR_LIMIT).includes(needle));

  const turns = parseTranscript(raw);
  const kept = parseTranscript(raw.slice(0, FACT_TRANSCRIPT_CHAR_LIMIT));
  assert.ok(turns.length - kept.length > 25, 'truncation should drop a meaningful run of turns');

  assert.ok(
    chunkTurns(turns).length > 50,
    'marathon should produce far more chunks than RETRIEVE_K',
  );
});

test('customer-interview and all-hands-marathon share a customer on purpose', () => {
  // Liam tells the same story in both meetings, so their chunks embed close
  // together. That overlap is what makes a meeting_id scoping bug visible:
  // fixtures with disjoint vocabulary would retrieve correctly either way.
  const interview = parseTranscript(read('customer-interview.txt'));
  const marathon = parseTranscript(read('all-hands-marathon.txt'));

  assert.ok(interview.some((turn) => turn.speaker === 'Liam'));
  assert.ok(marathon.some((turn) => turn.speaker === 'Liam'));

  for (const turns of [interview, marathon]) {
    const text = turns.map((turn) => turn.text.replace(/\s+/g, ' ').toLowerCase()).join(' ');
    assert.ok(text.includes('transaction volume report'), 'both retell the Monday export');
    assert.ok(text.includes('spreadsheet'), 'both mention the spreadsheet');
  }

  const shingles = (turns: ReturnType<typeof parseTranscript>): Set<string> => {
    const words = turns
      .map((turn) => turn.text)
      .join(' ')
      .replace(/[^a-z0-9 ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ');
    const out = new Set<string>();
    for (let index = 0; index + 6 <= words.length; index += 1) {
      out.add(words.slice(index, index + 6).join(' '));
    }
    return out;
  };

  const left = shingles(interview);
  const right = shingles(marathon);
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      shared += 1;
    }
  }
  const ratio = shared / left.size;
  assert.ok(ratio > 0.01, `overlap collapsed to ${(ratio * 100).toFixed(1)}%`);
  assert.ok(ratio < 0.15, `overlap looks copy-pasted at ${(ratio * 100).toFixed(1)}%`);
});

test('all-hands-marathon jumps forward where the recording is paused', () => {
  const turns = parseTranscript(read('all-hands-marathon.txt'));

  // Both breaks are taken with the recording stopped, so the timeline is not
  // continuous. Timestamps still never move backwards, which is all the parser
  // requires, but nothing downstream may assume a gapless recording.
  const gaps: number[] = [];
  for (let index = 1; index < turns.length; index += 1) {
    gaps.push(turns[index].startSeconds - turns[index - 1].startSeconds);
  }
  const long = gaps.filter((gap) => gap > 300);
  assert.equal(long.length, 2, 'expected exactly one gap per break');
  assert.ok(Math.max(...long) > 900, 'the second break should exceed fifteen minutes');
  assert.ok(Math.min(...gaps) >= 0, 'timestamps must not move backwards');
});

test('solo-keynote keeps one speaker label and produces an oversized chunk', () => {
  const turns = parseTranscript(read('solo-keynote.txt'));
  assert.equal(new Set(turns.map((turn) => turn.speaker)).size, 1);

  const chunks = chunkTurns(turns);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.speakerLabel, 'Evelyn', 'solo label should not repeat the speaker');
  }

  // A single turn longer than maxChars is emitted whole, so the chunker can
  // exceed DEFAULT_MAX_CHARS. The keynote has one such uninterrupted stretch.
  const oversized = chunks.filter((chunk) => chunk.text.length > DEFAULT_MAX_CHARS);
  assert.equal(oversized.length, 1);
  assert.ok(oversized[0].text.length > DEFAULT_MAX_CHARS * 1.5);
});

test('town-hall-qna packs many distinct speakers into chunk labels', () => {
  const turns = parseTranscript(read('town-hall-qna.txt'));
  assert.ok(new Set(turns.map((turn) => turn.speaker)).size >= 16);

  // Diarisation is imperfect in the real world: unattributed audio and shared
  // room microphones both end up as speaker labels.
  const speakers = new Set(turns.map((turn) => turn.speaker));
  assert.ok(speakers.has('Unknown Speaker'));
  assert.ok(speakers.has('Conference Room B'));

  const chunks = chunkTurns(turns);
  const widest = Math.max(...chunks.map((chunk) => chunk.speakerLabel.split(', ').length));
  assert.ok(widest >= 5, 'a chunk should span at least five speakers');

  for (const chunk of chunks) {
    const labels = chunk.speakerLabel.split(', ');
    assert.equal(new Set(labels).size, labels.length, 'speaker labels must be deduplicated');
  }
});

test('security-architecture-rfc carries non-ASCII through parsing and chunking', () => {
  const raw = read('security-architecture-rfc.txt');

  // Typographic punctuation and accented names make UTF-8 byte length diverge
  // from JavaScript string length, which matters anywhere we count bytes.
  assert.ok(Buffer.byteLength(raw, 'utf8') > raw.length + 500);
  assert.equal(raw.includes("'"), false, 'this export uses typographic apostrophes throughout');
  assert.equal(raw.includes('"'), false, 'this export uses typographic quotes throughout');

  const turns = parseTranscript(raw);
  const speakers = new Set(turns.map((turn) => turn.speaker));
  assert.ok(speakers.has('Núria'));
  assert.ok(speakers.has('Zoë'));

  const labels = chunkTurns(turns)
    .map((chunk) => chunk.speakerLabel)
    .join(' ');
  assert.ok(/Núria|Zoë/.test(labels), 'accented names should survive into chunk labels');
});

test('all transcript fixtures parse and chunk', () => {
  const names = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.txt'))
    .sort();
  assert.deepEqual(names, cases.map((fixture) => fixture.file).sort());

  for (const name of names) {
    const turns = parseTranscript(read(name));
    assert.ok(turns.length > 0, name);

    let previousSeconds = -1;
    for (const turn of turns) {
      assert.ok(turn.speaker.length > 0, name);
      assert.ok(turn.text.length > 0, name);
      assert.ok(turn.startSeconds >= previousSeconds, `${name} timestamps must not go backwards`);
      assert.ok(!turn.timestamp.includes('[') && !turn.timestamp.includes(']'), name);
      assert.ok(!turn.timestamp.includes('(') && !turn.timestamp.includes(')'), name);
      previousSeconds = turn.startSeconds;
    }

    const chunks = chunkTurns(turns);
    assert.ok(chunks.length > 0, name);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length > 0, name);
      assert.ok(chunk.startSeconds <= chunk.endSeconds, name);
      assert.ok(chunk.speakerLabel.length > 0, name);
    }
  }
});
