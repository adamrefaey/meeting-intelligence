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

export function parseInlineCitations(text: string): InlineCitation[] {
  const citeRe =
    /\[(?:([^[\]]+?),\s*)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[\u2013-]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]/g;
  const found: InlineCitation[] = [];
  for (const match of text.matchAll(citeRe)) {
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
  return found;
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

/**
 * A cited clock is the model's guess, and its habitual mistake is naming the turn where a
 * speaker took the mic rather than the turn that carries the claim. The transcript settles
 * it: among that speaker's turns, keep the one whose words the claim actually shares.
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
  const at = turns.find((turn) => turn.startSeconds === inline.startSeconds);
  const speaker = inline.speaker === '' ? (at?.speaker ?? '') : inline.speaker;
  if (speaker === '') {
    return inline;
  }
  const claimTokens = withoutSpeaker(claim, speaker);
  const searchTokens = claimTokens.size > 0 ? claimTokens : withoutSpeaker(question, speaker);
  if (searchTokens.size === 0) {
    return inline;
  }
  const wanted = speakerKey(speaker);
  // Only a turn this speaker owns can justify keeping the clock. Score another speaker's
  // turn and a well-matching reply would preserve a chip that scrolls to the wrong person.
  const citedScore =
    at !== undefined && speakerKey(at.speaker) === wanted ? overlap(searchTokens, at.text) : -1;
  const best = bestTurnFor(searchTokens, wanted, inline.startSeconds, turns);
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
  const inlines = parseInlineCitations(text);
  if (inlines.length === 0) {
    return text === '' ? [] : [{ type: 'text', text }];
  }
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const citation of inlines) {
    if (citation.index > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, citation.index) });
    }
    const claim = text.slice(cursor, citation.index);
    segments.push({ type: 'cite', citation: groundCitation(citation, claim, question, turns) });
    cursor = citation.index + citation.length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }
  return segments;
}
