import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import type { ChatMessage, Llm } from '../llm/types.ts';
import { renderTurns } from '../transcript/parse.ts';
import { buildChatMessages, type PromptActionItem, type PromptFact } from './prompt.ts';
import { reindexMeeting } from './reindex.ts';
import { retrieveForMeeting } from './retrieve.ts';

export class MeetingNotFoundError extends Error {
  override name = 'MeetingNotFoundError';
  constructor() {
    super('Meeting not found');
  }
}

export class MeetingNotReadyError extends Error {
  override name = 'MeetingNotReadyError';
  constructor() {
    super('Meeting is not ready');
  }
}

export type ChatConfig = Pick<
  AppConfig,
  | 'embeddingModel'
  | 'embeddingDimensions'
  | 'fullContextCharThreshold'
  | 'retrieveK'
  | 'ftsK'
  | 'chatHistoryTurns'
>;

export type AnswerQuestionResult = {
  stream: AsyncIterable<string>;
  useFullTranscript: boolean;
};

type MeetingRow = {
  title: string;
  status: string;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  char_count: number;
};

function loadMeeting(db: DatabaseSync, meetingId: number): MeetingRow | undefined {
  return db
    .prepare(
      `SELECT title, status, embedding_model, embedding_dimensions, char_count
       FROM meetings WHERE id = ?`,
    )
    .get(meetingId) as MeetingRow | undefined;
}

function loadRenderedTranscript(db: DatabaseSync, meetingId: number): string {
  const turns = db
    .prepare(
      `SELECT speaker, timestamp, text
       FROM turns WHERE meeting_id = ? ORDER BY turn_index`,
    )
    .all(meetingId) as Array<{ speaker: string; timestamp: string; text: string }>;
  return renderTurns(turns);
}

/** Stored embeddings were written with a different model or dimensions than this process. */
function needsReindex(meeting: MeetingRow, config: ChatConfig): boolean {
  return (
    meeting.embedding_model !== config.embeddingModel ||
    meeting.embedding_dimensions !== config.embeddingDimensions
  );
}

function loadDecisions(db: DatabaseSync, meetingId: number): PromptFact[] {
  return db
    .prepare(`SELECT text, speaker, timestamp FROM decisions WHERE meeting_id = ? ORDER BY id`)
    .all(meetingId) as PromptFact[];
}

function loadActionItems(db: DatabaseSync, meetingId: number): PromptActionItem[] {
  return db
    .prepare(
      `SELECT text, owner, due, timestamp FROM action_items WHERE meeting_id = ? ORDER BY id`,
    )
    .all(meetingId) as PromptActionItem[];
}

/** Newest `limit` rows, then reverse to oldest-first. */
function loadHistory(db: DatabaseSync, meetingId: number, limit: number): ChatMessage[] {
  if (limit <= 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE meeting_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(meetingId, limit) as Array<{ role: 'user' | 'assistant'; content: string }>;
  return rows.reverse();
}

/**
 * Short meetings skip retrieve and send the full transcript. Reindex only on the
 * retrieve path, before embedding the question.
 */
export async function answerQuestion(
  db: DatabaseSync,
  llm: Llm,
  config: ChatConfig,
  meetingId: number,
  userMessage: string,
  signal?: AbortSignal,
): Promise<AnswerQuestionResult> {
  signal?.throwIfAborted();
  const meeting = loadMeeting(db, meetingId);
  if (!meeting) {
    throw new MeetingNotFoundError();
  }
  if (meeting.status !== 'ready') {
    throw new MeetingNotReadyError();
  }
  const useFullTranscript = meeting.char_count < config.fullContextCharThreshold;
  if (needsReindex(meeting, config) && !useFullTranscript) {
    await reindexMeeting(db, llm, config, meetingId, signal);
  }
  const excerpts = useFullTranscript
    ? []
    : (await retrieveForMeeting(db, llm, meetingId, userMessage, config, signal)).map(
        (chunk) => chunk.text,
      );
  const messages = buildChatMessages({
    title: meeting.title,
    decisions: loadDecisions(db, meetingId),
    actionItems: loadActionItems(db, meetingId),
    excerpts,
    history: loadHistory(db, meetingId, config.chatHistoryTurns),
    userMessage,
    useFullTranscript,
    rawText: useFullTranscript ? loadRenderedTranscript(db, meetingId) : '',
  });
  return { stream: llm.streamChat(messages, signal), useFullTranscript };
}
