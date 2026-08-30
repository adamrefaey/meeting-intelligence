export type Turn = {
  speaker: string;
  timestamp: string;
  startSeconds: number;
  text: string;
};

type SpokenTurn = Pick<Turn, 'speaker' | 'timestamp' | 'text'>;

/**
 * The one way a turn is written for a model. The prefix is the citation itself, so
 * copying the marker from the turn that contains the claim cannot yield an earlier
 * greeting by the same speaker. turn.text may contain newlines.
 */
export function turnPrefix(turn: Pick<Turn, 'speaker' | 'timestamp'>): string {
  return `[${turn.speaker}, ${turn.timestamp}]: `;
}

export function renderTurn(turn: SpokenTurn): string {
  return turnPrefix(turn) + turn.text;
}

export function renderTurns(turns: readonly SpokenTurn[]): string {
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

const HEADERS = [
  /^\[(?<timestamp>\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?<speaker>\S.*?):\s*(?<text>.*)$/,
  /^(?<speaker>\S.*?)\s+\((?<timestamp>\d{1,2}:\d{2}(?::\d{2})?)\):\s*(?<text>.*)$/,
  /^(?<timestamp>\d{1,2}:\d{2}:\d{2})\s+(?<speaker>\S.*?):\s*(?<text>.*)$/,
];

function toStartSeconds(clock: string): number {
  return clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function matchHeader(
  line: string,
): { speaker: string; timestamp: string; text: string } | undefined {
  for (const pattern of HEADERS) {
    const groups = pattern.exec(line)?.groups;
    if (groups) {
      return {
        speaker: groups.speaker.trim(),
        timestamp: groups.timestamp,
        text: groups.text,
      };
    }
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
    const previous = turns.at(-1);
    if (previous) {
      previous.text += `\n${line}`;
    }
  }

  if (turns.length === 0) {
    throw new ParseError();
  }
  return turns;
}
