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

export type AnswerSegment =
  | { type: 'text'; text: string }
  | { type: 'cite'; citation: InlineCitation };

export function clockToSeconds(clock: string): number | undefined {
  const parts = clock.split(':').map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  if (parts.length === 2) {
    const minutes = parts[0];
    const seconds = parts[1];
    if (minutes === undefined || seconds === undefined) {
      return undefined;
    }
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const hours = parts[0];
    const minutes = parts[1];
    const seconds = parts[2];
    if (hours === undefined || minutes === undefined || seconds === undefined) {
      return undefined;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

const CLOCK = String.raw`(\d{1,2}:\d{2}(?::\d{2})?)`;
const RANGE = String.raw`(?:\s*[\u2013-]\s*(\d{1,2}:\d{2}(?::\d{2})?))?`;
const CITE_PATTERNS = [
  new RegExp(String.raw`【\s*\[(?:([^[\]]+?),\s*)?${CLOCK}${RANGE}\]\s*】`, 'g'),
  new RegExp(String.raw`【\s*(?:([^【】,]+?),\s*)?${CLOCK}${RANGE}\s*】`, 'g'),
  new RegExp(String.raw`\[(?:([^[\]]+?),\s*)?${CLOCK}${RANGE}\]`, 'g'),
];

function overlaps(existing: InlineCitation, index: number, length: number): boolean {
  const end = index + length;
  const existingEnd = existing.index + existing.length;
  return index < existingEnd && end > existing.index;
}

export function parseInlineCitations(text: string): InlineCitation[] {
  const found: InlineCitation[] = [];
  for (const pattern of CITE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const startTimestamp = match[2];
      const index = match.index;
      if (startTimestamp === undefined || index === undefined) {
        continue;
      }
      const startSeconds = clockToSeconds(startTimestamp);
      if (startSeconds === undefined) {
        continue;
      }
      if (found.some((cite) => overlaps(cite, index, raw.length))) {
        continue;
      }
      found.push({
        raw,
        speaker: match[1]?.trim() ?? '',
        startTimestamp,
        endTimestamp: match[3],
        startSeconds,
        index,
        length: raw.length,
      });
    }
  }
  found.sort((left, right) => left.index - right.index);
  return found;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function speakerBoundaryPattern(speaker: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(speaker)}(?![\\p{L}\\p{N}])`, flags);
}

function uniqueSpeakers(turns: CitationTurn[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const turn of turns) {
    const key = speakerKey(turn.speaker);
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(turn.speaker);
  }
  names.sort((left, right) => right.length - left.length);
  return names;
}

function mentionsSpeaker(text: string, speaker: string): boolean {
  return speakerBoundaryPattern(speaker, 'iu').test(text);
}

function speakersInText(text: string, turns: CitationTurn[]): string[] {
  return uniqueSpeakers(turns).filter((name) => mentionsSpeaker(text, name));
}

function speakerAtClock(seconds: number, turns: CitationTurn[]): string {
  return turns.find((turn) => turn.startSeconds === seconds)?.speaker ?? '';
}

function lineEndAfter(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function lastLineEndForSpeaker(text: string, speaker: string): number | undefined {
  let last: number | undefined;
  for (const match of text.matchAll(speakerBoundaryPattern(speaker, 'giu'))) {
    if (match.index === undefined) {
      continue;
    }
    last = lineEndAfter(text, match.index + match[0].length);
  }
  return last;
}

function lineSlice(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(start, lineEndAfter(text, index));
}

function lineWithoutCites(line: string): string {
  let stripped = line;
  for (const found of [...parseInlineCitations(line)].reverse()) {
    stripped = stripped.slice(0, found.index) + stripped.slice(found.index + found.length);
  }
  return stripped;
}

function shouldRelocate(text: string, cite: InlineCitation, turns: CitationTurn[]): boolean {
  const line = lineSlice(text, cite.index);
  const lineCites = parseInlineCitations(line);
  const stripped = lineWithoutCites(line);
  if (!hasLetters(stripped)) {
    return true;
  }
  if (lineCites.length < 2) {
    return false;
  }
  const speaker = cite.speaker !== '' ? cite.speaker : speakerAtClock(cite.startSeconds, turns);
  return speaker === '' || !mentionsSpeaker(stripped, speaker);
}

function stripCites(text: string, cites: InlineCitation[]): string {
  let next = text;
  for (const cite of [...cites].reverse()) {
    let from = cite.index;
    const to = cite.index + cite.length;
    while (from > 0 && /[ \t]/.test(next[from - 1] ?? '')) {
      from -= 1;
    }
    next = next.slice(0, from) + next.slice(to);
  }
  return next.replace(/[ \t]+$/gm, '').replace(/\n+$/u, '');
}

function spliceCite(text: string, at: number, raw: string): string {
  const needsSpace = at > 0 && !/\s/.test(text[at - 1] ?? ' ');
  return `${text.slice(0, at)}${needsSpace ? ' ' : ''}${raw}${text.slice(at)}`;
}

function lineAlreadyCited(text: string, lineEnd: number): boolean {
  return parseInlineCitations(lineSlice(text, Math.max(0, lineEnd - 1))).length > 0;
}

function relocateFootnotes(text: string, turns: CitationTurn[]): string {
  if (turns.length === 0) {
    return text;
  }
  const footnotes = parseInlineCitations(text).filter((cite) => shouldRelocate(text, cite, turns));
  if (footnotes.length === 0) {
    return text;
  }
  let body = stripCites(text, footnotes);
  const used = new Set<number>();
  const insertions: { at: number; raw: string; order: number }[] = [];
  const leftovers: string[] = [];
  for (const [order, footnote] of footnotes.entries()) {
    const speaker =
      footnote.speaker !== '' ? footnote.speaker : speakerAtClock(footnote.startSeconds, turns);
    const at = speaker === '' ? undefined : lastLineEndForSpeaker(body, speaker);
    if (speaker === '' || at === undefined) {
      leftovers.push(footnote.raw);
      continue;
    }
    if (used.has(at) || lineAlreadyCited(body, at)) {
      continue;
    }
    used.add(at);
    insertions.push({ at, raw: footnote.raw, order });
  }
  insertions.sort((left, right) => right.at - left.at || right.order - left.order);
  for (const insertion of insertions) {
    body = spliceCite(body, insertion.at, insertion.raw);
  }
  return leftovers.length === 0 ? body : `${body}\n${leftovers.join(' ')}`;
}

export function inlineChipLabel(inline: InlineCitation): string {
  return inline.startTimestamp;
}

const STOP = new Set([
  'about',
  'after',
  'also',
  'asked',
  'been',
  'before',
  'being',
  'does',
  'doing',
  'from',
  'have',
  'into',
  'just',
  'made',
  'make',
  'more',
  'only',
  'over',
  'related',
  'some',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'were',
  'what',
  'when',
  'whether',
  'which',
  'while',
  'will',
  'with',
  'would',
]);

const ROSTER_QUESTION = new Set([
  'attendee',
  'attendees',
  'identified',
  'meeting',
  'meetings',
  'named',
  'participant',
  'participants',
  'people',
  'speaker',
  'speakers',
]);

function tokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return new Set(words.filter((word) => !STOP.has(word)));
}

function overlap(claim: Set<string>, turnText: string): number {
  const body = tokens(turnText);
  let n = 0;
  for (const word of claim) {
    if (body.has(word)) {
      n += 1;
    }
  }
  return n;
}

/** The speaker's own name matches all of their turns equally, so it decides nothing. */
function withoutSpeaker(text: string, speaker: string): Set<string> {
  const words = tokens(text);
  for (const part of speaker.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
    words.delete(part);
  }
  return words;
}

function speakerKey(speaker: string): string {
  return speaker.trim().toLowerCase();
}

/** The speaker's turn sharing the most words with the claim, nearest `around` among equals. */
function bestTurnFor(
  claim: Set<string>,
  wanted: string,
  around: number,
  turns: CitationTurn[],
): { turn: CitationTurn; score: number } | undefined {
  let best: CitationTurn | undefined;
  let bestScore = 0;
  for (const turn of turns) {
    if (speakerKey(turn.speaker) !== wanted) {
      continue;
    }
    const score = overlap(claim, turn.text);
    if (score === 0 || score < bestScore) {
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

function resolveSpeaker(inline: InlineCitation, claim: string, turns: CitationTurn[]): string {
  if (inline.speaker !== '') {
    return inline.speaker;
  }
  const named = speakersInText(claim, turns);
  if (named.length === 1 && named[0] !== undefined) {
    return named[0];
  }
  return speakerAtClock(inline.startSeconds, turns);
}

function nearestTurn(
  wanted: string,
  around: number,
  turns: CitationTurn[],
): CitationTurn | undefined {
  let best: CitationTurn | undefined;
  for (const turn of turns) {
    if (speakerKey(turn.speaker) !== wanted) {
      continue;
    }
    const closer =
      best === undefined ||
      Math.abs(turn.startSeconds - around) < Math.abs(best.startSeconds - around);
    if (closer) {
      best = turn;
    }
  }
  return best;
}

function withTurn(inline: InlineCitation, turn: CitationTurn): InlineCitation {
  return {
    ...inline,
    startTimestamp: turn.timestamp,
    startSeconds: turn.startSeconds,
    endTimestamp: undefined,
  };
}

function retargetIfWrongSpeaker(
  inline: InlineCitation,
  speaker: string,
  turns: CitationTurn[],
): InlineCitation {
  const at = turns.find((turn) => turn.startSeconds === inline.startSeconds);
  if (at !== undefined && speakerKey(at.speaker) === speakerKey(speaker)) {
    return inline;
  }
  const nearest = nearestTurn(speakerKey(speaker), inline.startSeconds, turns);
  return nearest === undefined ? inline : withTurn(inline, nearest);
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
  if (turns.length === 0) {
    return inline;
  }
  const speaker = resolveSpeaker(inline, claim, turns);
  if (speaker === '') {
    return inline;
  }
  const claimTokens = withoutSpeaker(claim, speaker);
  const questionTokens = withoutSpeaker(question, speaker);
  for (const word of ROSTER_QUESTION) {
    questionTokens.delete(word);
  }
  const searchTokens = claimTokens.size > 0 ? claimTokens : questionTokens;
  if (searchTokens.size === 0) {
    return retargetIfWrongSpeaker(inline, speaker, turns);
  }
  const wanted = speakerKey(speaker);
  const at = turns.find((turn) => turn.startSeconds === inline.startSeconds);
  const citedScore =
    at !== undefined && speakerKey(at.speaker) === wanted ? overlap(searchTokens, at.text) : -1;
  const best = bestTurnFor(searchTokens, wanted, inline.startSeconds, turns);
  if (best !== undefined && best.score > citedScore) {
    return withTurn(inline, best.turn);
  }
  if (citedScore < 0) {
    return retargetIfWrongSpeaker(inline, speaker, turns);
  }
  return inline;
}

export function segmentAnswer(
  text: string,
  turns: CitationTurn[] = [],
  question = '',
): AnswerSegment[] {
  const rewritten = relocateFootnotes(text, turns);
  const inlines = parseInlineCitations(rewritten);
  if (inlines.length === 0) {
    return rewritten === '' ? [] : [{ type: 'text', text: rewritten }];
  }
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const citation of inlines) {
    if (citation.index > cursor) {
      segments.push({ type: 'text', text: rewritten.slice(cursor, citation.index) });
    }
    const lineStart = rewritten.lastIndexOf('\n', citation.index - 1) + 1;
    const claim = rewritten.slice(Math.max(lineStart, cursor), citation.index);
    segments.push({ type: 'cite', citation: groundCitation(citation, claim, question, turns) });
    cursor = citation.index + citation.length;
  }
  if (cursor < rewritten.length) {
    segments.push({ type: 'text', text: rewritten.slice(cursor) });
  }
  return segments;
}
