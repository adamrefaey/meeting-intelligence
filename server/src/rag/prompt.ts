import type { ChatMessage } from '../llm/types.ts';

export type PromptFact = {
  text: string;
  speaker: string | null;
  timestamp: string | null;
};

export type PromptActionItem = {
  text: string;
  owner: string | null;
  due: string | null;
  timestamp: string | null;
};

type BuildChatMessagesInput = {
  title: string;
  decisions: PromptFact[];
  actionItems: PromptActionItem[];
  excerpts: string[];
  history: ChatMessage[];
  userMessage: string;
  useFullTranscript: boolean;
  rawText: string;
};

const SYSTEM_RULES = `You answer questions about this single meeting.
Use only the provided context. Do not use outside knowledge.
Each turn starts with [Speaker, timestamp]: and runs until the next one, so it may span
several lines. Cite by copying that [Speaker, timestamp] marker from the turn the claim
comes from, not from an earlier line by the same speaker. Put it immediately after the
clause it supports. If several people match, name each of them.
Example: Keiko asked about people who had already moved [Keiko, 00:04:17]. Malik asked whether remote-first would make the office worse [Malik, 00:05:55].
Use ASCII square brackets only. Do not wrap cites in 【】 or list clocks at the end.
If the answer is not in the context, say you cannot find it in this meeting.
Prefer the Decisions and Action items lists when the question is about those topics.
Keep answers concise.`;

const EXCERPT_RULES =
  '## Excerpt format\nEach retrieved excerpt lists its speakers, then its turns, each ' +
  'beginning with a [Speaker, timestamp]: marker. Copy that marker to cite. Excerpts are ' +
  'separate windows of the same meeting and may be out of order.';

function nonEmpty(value: string | null, label?: string): string | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  return label === undefined ? value : `${label}: ${value}`;
}

function bullet(text: string, meta: Array<string | undefined>): string {
  const parts = meta.filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `- ${text} (${parts.join(', ')})` : `- ${text}`;
}

function section(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join('\n') : 'None recorded.';
  return `## ${title}\n${body}`;
}

/**
 * Full transcript lives on the system message. Retrieved excerpts go on the user
 * message so they sit next to the question instead of being buried in history.
 */
export function buildChatMessages(input: BuildChatMessagesInput): ChatMessage[] {
  const systemParts = [
    SYSTEM_RULES,
    `Meeting title: ${input.title}`,
    section(
      'Decisions',
      input.decisions.map((fact) =>
        bullet(fact.text, [nonEmpty(fact.speaker), nonEmpty(fact.timestamp)]),
      ),
    ),
    section(
      'Action items',
      input.actionItems.map((item) =>
        bullet(item.text, [
          nonEmpty(item.owner, 'owner'),
          nonEmpty(item.due, 'due'),
          nonEmpty(item.timestamp),
        ]),
      ),
    ),
  ];
  let userContent = input.userMessage;
  if (input.useFullTranscript) {
    systemParts.push(`## Transcript\n${input.rawText}`);
  } else {
    const hasExcerpts = input.excerpts.length > 0;
    if (hasExcerpts) {
      systemParts.push(EXCERPT_RULES);
    }
    const body = hasExcerpts ? input.excerpts.join('\n\n') : 'None retrieved.';
    userContent = `## Retrieved excerpts\n${body}\n\n## Question\n${input.userMessage}`;
  }
  return [
    { role: 'system', content: systemParts.join('\n\n') },
    ...input.history,
    { role: 'user', content: userContent },
  ];
}
