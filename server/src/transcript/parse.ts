export type Turn = {
  speaker: string;
  timestamp: string;
  startSeconds: number;
  text: string;
};

/**
 * The one way a turn is written for a model. The prefix is the citation itself, so
 * copying the marker from the turn that contains the claim cannot yield an earlier
 * greeting by the same speaker. turn.text may contain newlines.
 */
export function turnPrefix(turn: Turn): string {
  return `[${turn.speaker}, ${turn.timestamp}]: `;
}

export function renderTurn(turn: Turn): string {
  return turnPrefix(turn) + turn.text;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map(renderTurn).join('\n');
}

export class ParseError extends Error {
  override name = 'ParseError';
  constructor() {
    super(
      'Could not parse speaker labels and timestamps. Expected lines like [HH:MM:SS] Speaker: text',
    );
  }
}

const BRACKETED = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?):\s*(.*)$/;
const PAREN = /^(.+?)\s+\((\d{1,2}:\d{2}(?::\d{2})?)\):\s*(.*)$/;
const BARE_HMS = /^(\d{1,2}:\d{2}:\d{2})\s+(.+?):\s*(.*)$/;

function toStartSeconds(clock: string): number {
  const parts = clock.split(':').map((part) => Number(part));
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  const [hours, minutes, seconds] = parts;
  return hours * 3600 + minutes * 60 + seconds;
}

function matchHeader(
  line: string,
): { speaker: string; timestamp: string; text: string } | undefined {
  const bracketed = BRACKETED.exec(line);
  if (bracketed) {
    return {
      timestamp: bracketed[1],
      speaker: bracketed[2].trim(),
      text: bracketed[3],
    };
  }
  const paren = PAREN.exec(line);
  if (paren) {
    return {
      speaker: paren[1].trim(),
      timestamp: paren[2],
      text: paren[3],
    };
  }
  const bare = BARE_HMS.exec(line);
  if (bare) {
    return {
      timestamp: bare[1],
      speaker: bare[2].trim(),
      text: bare[3],
    };
  }
  return undefined;
}

export function parseTranscript(text: string): Turn[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const turns: Turn[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const header = matchHeader(line);
    if (header) {
      turns.push({
        speaker: header.speaker,
        timestamp: header.timestamp,
        startSeconds: toStartSeconds(header.timestamp),
        text: header.text,
      });
      continue;
    }
    const previous = turns[turns.length - 1];
    if (previous) {
      previous.text += `\n${line}`;
    }
  }

  if (turns.length === 0) {
    throw new ParseError();
  }
  return turns;
}
