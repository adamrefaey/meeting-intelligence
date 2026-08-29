import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { inTransaction, insertRows } from '../db/batch.ts';
import { toVectorBlob } from '../db/client.ts';
import { EmbeddingDimensionError } from '../llm/embed.ts';
import type { ChatMessage, Llm } from '../llm/types.ts';
import { renderTurns, type Turn } from '../transcript/parse.ts';
import { buildChatMessages, type PromptActionItem, type PromptFact } from './prompt.ts';
import { retrieveForMeeting, shouldUseFullTranscript } from './retrieve.ts';

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
  id: number | bigint;
  title: string;
  status: string;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  char_count: number;
};

type ChunkText = {
  id: number;
  text: string;
};

function loadMeeting(db: DatabaseSync, meetingId: number): MeetingRow | undefined {
  return db
    .prepare(
      `SELECT id, title, status, embedding_model, embedding_dimensions, char_count
       FROM meetings WHERE id = ?`,
    )
    .get(meetingId) as MeetingRow | undefined;
}

function loadRenderedTranscript(db: DatabaseSync, meetingId: number): string {
  const turns = db
    .prepare(
      `SELECT speaker, timestamp, start_seconds AS startSeconds, text
       FROM turns WHERE meeting_id = ? ORDER BY turn_index`,
    )
    .all(meetingId) as Turn[];
  return renderTurns(turns);
}

function needsReindex(meeting: MeetingRow, config: ChatConfig): boolean {
  return (
    meeting.embedding_model !== config.embeddingModel ||
    meeting.embedding_dimensions !== config.embeddingDimensions
  );
}

function loadChunkTexts(db: DatabaseSync, meetingId: number): ChunkText[] {
  const rows = db
    .prepare(`SELECT id, text FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint; text: string }>;
  return rows.map((row) => ({ id: Number(row.id), text: row.text }));
}

function assertVectors(vectors: number[][], expectedCount: number, dimensions: number): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} embeddings, got ${vectors.length}`);
  }
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new EmbeddingDimensionError(vector.length, dimensions);
    }
  }
}

function replaceEmbeddings(
  db: DatabaseSync,
  config: Pick<AppConfig, 'embeddingModel' | 'embeddingDimensions'>,
  meetingId: number,
  chunks: ChunkText[],
  vectors: number[][],
): void {
  inTransaction(db, () => {
    db.prepare('DELETE FROM chunk_embeddings WHERE meeting_id = ?').run(meetingId);
    insertRows(
      db,
      'INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding)',
      '(?, ?, ?)',
      chunks.map((chunk, index) => [chunk.id, meetingId, toVectorBlob(vectors[index])]),
    );
    db.prepare(
      'UPDATE meetings SET embedding_model = ?, embedding_dimensions = ? WHERE id = ?',
    ).run(config.embeddingModel, config.embeddingDimensions, meetingId);
  });
}

export async function reindexMeeting(
  db: DatabaseSync,
  llm: Llm,
  config: Pick<AppConfig, 'embeddingModel' | 'embeddingDimensions'>,
  meetingId: number,
  signal?: AbortSignal,
): Promise<void> {
  const chunks = loadChunkTexts(db, meetingId);
  signal?.throwIfAborted();
  const vectors = await llm.embed(
    chunks.map((chunk) => chunk.text),
    signal,
  );
  assertVectors(vectors, chunks.length, config.embeddingDimensions);
  signal?.throwIfAborted();
  replaceEmbeddings(db, config, meetingId, chunks, vectors);
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
  return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

async function buildAnswer(
  db: DatabaseSync,
  llm: Llm,
  config: ChatConfig,
  meeting: MeetingRow,
  userMessage: string,
  useFullTranscript: boolean,
  signal?: AbortSignal,
): Promise<AnswerQuestionResult> {
  const meetingId = Number(meeting.id);
  const chunks = useFullTranscript
    ? []
    : await retrieveForMeeting(
        db,
        llm,
        meetingId,
        userMessage,
        {
          retrieveK: config.retrieveK,
          ftsK: config.ftsK,
        },
        signal,
      );
  const messages = buildChatMessages({
    meeting: { title: meeting.title },
    decisions: loadDecisions(db, meetingId),
    actionItems: loadActionItems(db, meetingId),
    chunks,
    history: loadHistory(db, meetingId, config.chatHistoryTurns),
    userMessage,
    useFullTranscript,
    rawText: useFullTranscript ? loadRenderedTranscript(db, meetingId) : '',
    chatHistoryTurns: config.chatHistoryTurns,
  });
  return { stream: llm.streamChat(messages, signal), useFullTranscript };
}

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
  const useFullTranscript = shouldUseFullTranscript(
    meeting.char_count,
    config.fullContextCharThreshold,
  );
  if (needsReindex(meeting, config) && !useFullTranscript) {
    await reindexMeeting(db, llm, config, meetingId, signal);
  }
  return buildAnswer(db, llm, config, meeting, userMessage, useFullTranscript, signal);
}
