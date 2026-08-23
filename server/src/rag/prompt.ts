import type { ChatMessage } from '../llm/types.ts';
import type { RetrievedChunk } from './retrieve.ts';

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

export type BuildChatMessagesInput = {
  meeting: { title: string };
  decisions: PromptFact[];
  actionItems: PromptActionItem[];
  chunks: RetrievedChunk[];
  history: ChatMessage[];
  userMessage: string;
  useFullTranscript: boolean;
  rawText: string;
  chatHistoryTurns: number;
};

const SYSTEM_RULES = `You answer questions about this single meeting.
Use only the provided context. Do not use outside knowledge.
Cite supporting turns as [Speaker, timestamp] using labels from the context.
If the answer is not in the context, say you cannot find it in this meeting.
Prefer the Decisions and Action items lists when the question is about those topics.
Keep answers concise.`;

function bullet(text: string, meta: string[]): string {
  return meta.length > 0 ? `- ${text} (${meta.join(', ')})` : `- ${text}`;
}

function formatFact(fact: PromptFact): string {
  return bullet(
    fact.text,
    [fact.speaker, fact.timestamp].filter((part): part is string => part != null && part !== ''),
  );
}

function formatAction(item: PromptActionItem): string {
  return bullet(
    item.text,
    [
      item.owner != null && item.owner !== '' ? `owner: ${item.owner}` : undefined,
      item.due != null && item.due !== '' ? `due: ${item.due}` : undefined,
      item.timestamp != null && item.timestamp !== '' ? item.timestamp : undefined,
    ].filter((part): part is string => part !== undefined),
  );
}

function section(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join('\n') : 'None recorded.';
  return `## ${title}\n${body}`;
}

function recentHistory(history: ChatMessage[], turns: number): ChatMessage[] {
  return turns > 0 ? history.slice(-turns) : [];
}

function userContent(input: BuildChatMessagesInput): string {
  if (input.useFullTranscript) {
    return input.userMessage;
  }
  const excerpts =
    input.chunks.length > 0
      ? input.chunks.map((chunk) => chunk.text).join('\n\n')
      : 'None retrieved.';
  return `## Retrieved excerpts\n${excerpts}\n\n## Question\n${input.userMessage}`;
}

export function buildChatMessages(input: BuildChatMessagesInput): ChatMessage[] {
  const systemParts = [
    SYSTEM_RULES,
    `Meeting title: ${input.meeting.title}`,
    section('Decisions', input.decisions.map(formatFact)),
    section('Action items', input.actionItems.map(formatAction)),
  ];
  if (input.useFullTranscript) {
    systemParts.push(`## Transcript\n${input.rawText}`);
  }
  return [
    { role: 'system', content: systemParts.join('\n\n') },
    ...recentHistory(input.history, input.chatHistoryTurns),
    { role: 'user', content: userContent(input) },
  ];
}
