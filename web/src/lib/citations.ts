export type CitationTurn = {
  speaker: string;
  timestamp: string;
  startSeconds: number;
  text: string;
};

export type InlineCitation = {
  raw: string;
  speaker: string;
  startTimestamp: string;
  endTimestamp: string | undefined;
  startSeconds: number;
  index: number;
  length: number;
};

type AnswerSegment = { type: 'text'; text: string } | { type: 'cite'; citation: InlineCitation };

export function clockToSeconds(clock: string): number | undefined {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(clock);
  if (match === null) {
    return undefined;
  }
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;

/** An optional `Speaker, ` lead-in, a clock, then an optional en-dash range. */
function shape(speaker: string): string {
  return String.raw`(?:(${speaker}+?),\s*)?(${CLOCK})(?:\s*[\u2013-]\s*(${CLOCK}))?`;
}

// Square brackets bound a name, so it may contain commas ("Chen, Alice"); a bare 【】 name
// has no inner delimiter and may not. One pattern rather than three, so a 【[clock]】 wrap is
// consumed whole and its inner [clock] cannot match again. Every alternative captures
// speaker, start and end in that order, so START_AT finds the one that fired.
const SQUARE = shape(String.raw`[^[\]]`);
const LENTICULAR = shape(String.raw`[^【】,]`);
const CITE = new RegExp(String.raw`【\s*(?:\[${SQUARE}\]|${LENTICULAR})\s*】|\[${SQUARE}\]`, 'g');
const START_AT = [2, 5, 8];

export function parseInlineCitations(text: string): InlineCitation[] {
  const found: InlineCitation[] = [];
  for (const match of text.matchAll(CITE)) {
    const at = START_AT.find((group) => match[group] !== undefined);
    const startTimestamp = at === undefined ? undefined : match[at];
    if (at === undefined || startTimestamp === undefined) {
      continue;
    }
    const startSeconds = clockToSeconds(startTimestamp);
    if (startSeconds === undefined) {
      continue;
    }
    found.push({
      raw: match[0],
      speaker: match[at - 1]?.trim() ?? '',
      startTimestamp,
      endTimestamp: match[at + 1],
      startSeconds,
      index: match.index,
      length: match[0].length,
    });
  }
  return found;
}

const LETTER = /\p{L}/u;

/** The name on its own word boundary, so "Ada" does not match inside "Adamant". */
function speakerPattern(speaker: string, flags: string): RegExp {
  const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags);
}

function speakerKey(speaker: string): string {
  return speaker.trim().toLowerCase();
}

function mentionsSpeaker(text: string, speaker: string): boolean {
  return speakerPattern(speaker, 'iu').test(text);
}

/** The one roster name the text mentions, or undefined when it names none or several. */
function soleSpeakerNamed(text: string, turns: CitationTurn[]): string | undefined {
  const seen = new Set<string>();
  let only: string | undefined;
  for (const turn of turns) {
    const key = speakerKey(turn.speaker);
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!mentionsSpeaker(text, turn.speaker)) {
      continue;
    }
    if (only !== undefined) {
      return undefined;
    }
    only = turn.speaker;
  }
  return only;
}

function turnAtClock(seconds: number, turns: CitationTurn[]): CitationTurn | undefined {
  return turns.find((turn) => turn.startSeconds === seconds);
}

function citedSpeaker(cite: InlineCitation, turns: CitationTurn[]): string {
  return cite.speaker !== ''
    ? cite.speaker
    : (turnAtClock(cite.startSeconds, turns)?.speaker ?? '');
}

function lineEndAfter(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function lastLineEndForSpeaker(text: string, speaker: string): number | undefined {
  let last: number | undefined;
  for (const match of text.matchAll(speakerPattern(speaker, 'giu'))) {
    last = lineEndAfter(text, match.index + match[0].length);
  }
  return last;
}

function stripCites(text: string, cites: { index: number; length: number }[]): string {
  let next = text;
  for (const cite of cites.toReversed()) {
    let from = cite.index;
    while (from > 0 && /[ \t]/.test(next[from - 1] ?? '')) {
      from -= 1;
    }
    next = next.slice(0, from) + next.slice(cite.index + cite.length);
  }
  return next.replace(/[ \t]+$/gm, '').replace(/\n+$/u, '');
}

/**
 * A cite is a footnote when its line is nothing but cites, or when the line crowds several
 * cites together without naming this one's speaker.
 */
function shouldRelocate(
  text: string,
  cite: InlineCitation,
  turns: CitationTurn[],
  parsed: InlineCitation[],
): boolean {
  const start = lineStart(text, cite.index);
  const end = lineEndAfter(text, cite.index);
  const onLine = parsed
    .filter((entry) => entry.index >= start && entry.index < end)
    .map((entry) => ({ index: entry.index - start, length: entry.length }));
  const stripped = stripCites(text.slice(start, end), onLine);
  if (!LETTER.test(stripped)) {
    return true;
  }
  if (onLine.length < 2) {
    return false;
  }
  const speaker = citedSpeaker(cite, turns);
  return speaker === '' || !mentionsSpeaker(stripped, speaker);
}

function lineAlreadyCited(text: string, lineEnd: number): boolean {
  const start = lineStart(text, Math.max(0, lineEnd - 1));
  return parseInlineCitations(text.slice(start, lineEnd)).length > 0;
}

function prepareAnswer(
  text: string,
  turns: CitationTurn[],
): { text: string; inlines: InlineCitation[] } {
  const inlines = parseInlineCitations(text);
  if (turns.length === 0) {
    return { text, inlines };
  }
  const footnotes = inlines.filter((cite) => shouldRelocate(text, cite, turns, inlines));
  if (footnotes.length === 0) {
    return { text, inlines };
  }
  let draft = stripCites(text, footnotes);
  const leftovers: string[] = [];
  const insertions = new Map<number, string>();
  for (const footnote of footnotes) {
    const speaker = citedSpeaker(footnote, turns);
    const at = speaker === '' ? undefined : lastLineEndForSpeaker(draft, speaker);
    if (at === undefined) {
      leftovers.push(footnote.raw);
      continue;
    }
    if (!insertions.has(at) && !lineAlreadyCited(draft, at)) {
      insertions.set(at, footnote.raw);
    }
  }
  // Latest line first, so the earlier insertion points keep the offsets measured above.
  for (const [at, raw] of [...insertions].sort(([left], [right]) => right - left)) {
    const gap = /\s/.test(draft[at - 1] ?? ' ') ? '' : ' ';
    draft = `${draft.slice(0, at)}${gap}${raw}${draft.slice(at)}`;
  }
  const rewritten = leftovers.length === 0 ? draft : `${draft}\n${leftovers.join(' ')}`;
  return { text: rewritten, inlines: parseInlineCitations(rewritten) };
}

const STOP = new Set(
  'about after also asked been before being does doing from have into just made make more only over related some than that their them then there they this were what when whether which while will with would'.split(
    ' ',
  ),
);

const ROSTER_QUESTION = new Set(
  'attendee attendees identified meeting meetings named participant participants people speaker speakers'.split(
    ' ',
  ),
);

function wordsIn(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
}

function tokens(text: string): Set<string> {
  return new Set(wordsIn(text).filter((word) => !STOP.has(word)));
}

function overlap(claim: Set<string>, turnText: string): number {
  const words = tokens(turnText);
  let shared = 0;
  for (const word of claim) {
    if (words.has(word)) {
      shared += 1;
    }
  }
  return shared;
}

/** The speaker's own name matches all of their turns equally, so it decides nothing. */
function withoutSpeaker(text: string, speaker: string): Set<string> {
  const words = tokens(text);
  for (const part of wordsIn(speaker)) {
    words.delete(part);
  }
  return words;
}

function searchTokens(claim: string, question: string, speaker: string): Set<string> {
  const fromClaim = withoutSpeaker(claim, speaker);
  if (fromClaim.size > 0) {
    return fromClaim;
  }
  const fromQuestion = withoutSpeaker(question, speaker);
  for (const word of ROSTER_QUESTION) {
    fromQuestion.delete(word);
  }
  return fromQuestion;
}

/**
 * The speaker's turn sharing the most words with the claim, nearest `around` among equals.
 * A claim that shares nothing leaves every turn tied at zero, so the nearest one wins.
 */
function bestTurn(
  turns: CitationTurn[],
  wanted: string,
  around: number,
  claim: Set<string>,
): { turn: CitationTurn; score: number } | undefined {
  let best: CitationTurn | undefined;
  let bestScore = -1;
  for (const turn of turns) {
    if (speakerKey(turn.speaker) !== wanted) {
      continue;
    }
    const score = overlap(claim, turn.text);
    if (score < bestScore) {
      continue;
    }
    const nearer =
      best === undefined ||
      Math.abs(turn.startSeconds - around) < Math.abs(best.startSeconds - around);
    if (score > bestScore || nearer) {
      best = turn;
      bestScore = score;
    }
  }
  return best === undefined ? undefined : { turn: best, score: bestScore };
}

/**
 * A cited clock is the model's guess, and its habitual mistake is naming the turn where a
 * speaker took the mic rather than the turn that carries the claim. The transcript settles
 * it: among that speaker's turns, keep the one whose words the claim actually shares.
 *
 * Timestamp-only cites often name the wrong person. If the claim names exactly one
 * speaker, that speaker wins over the cited clock's owner.
 *
 * `claim` is the answer text leading up to the chip, and `question` covers the case where
 * that text is only a name, as in a bare "- Keiko — [Keiko, 00:04:14]" list.
 */
function groundCitation(
  inline: InlineCitation,
  claim: string,
  question: string,
  turns: CitationTurn[],
): InlineCitation {
  const at = turnAtClock(inline.startSeconds, turns);
  const speaker =
    inline.speaker !== '' ? inline.speaker : (soleSpeakerNamed(claim, turns) ?? at?.speaker ?? '');
  if (speaker === '') {
    return inline;
  }
  const wanted = speakerKey(speaker);
  const claimTokens = searchTokens(claim, question, speaker);
  // A clock belonging to anyone else scores below every turn the speaker did take, so any
  // of their turns will do rather than send the chip to the wrong person.
  const cited = at !== undefined && speakerKey(at.speaker) === wanted ? at : undefined;
  const citedScore = cited === undefined ? -1 : overlap(claimTokens, cited.text);
  const best = bestTurn(turns, wanted, inline.startSeconds, claimTokens);
  if (best === undefined || best.score <= citedScore) {
    return inline;
  }
  return {
    ...inline,
    startTimestamp: best.turn.timestamp,
    startSeconds: best.turn.startSeconds,
    endTimestamp: undefined,
  };
}

export function segmentAnswer(
  text: string,
  turns: CitationTurn[] = [],
  question = '',
): AnswerSegment[] {
  const { text: rewritten, inlines } = prepareAnswer(text, turns);
  if (inlines.length === 0) {
    return rewritten === '' ? [] : [{ type: 'text', text: rewritten }];
  }
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const citation of inlines) {
    if (citation.index > cursor) {
      segments.push({ type: 'text', text: rewritten.slice(cursor, citation.index) });
    }
    const start = lineStart(rewritten, citation.index);
    const claim = rewritten.slice(Math.max(start, cursor), citation.index);
    segments.push({ type: 'cite', citation: groundCitation(citation, claim, question, turns) });
    cursor = citation.index + citation.length;
  }
  if (cursor < rewritten.length) {
    segments.push({ type: 'text', text: rewritten.slice(cursor) });
  }
  return segments;
}
