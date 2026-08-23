import type { DatabaseSync } from 'node:sqlite';
import { isAbortError } from '../abort.ts';
import { inTransaction, insertRows, insertRowsReturning } from '../db/batch.ts';
import { toVectorBlob } from '../db/client.ts';
import { extractFacts, type ExtractedFacts } from '../extract/facts.ts';
import { EmbeddingDimensionError } from '../llm/embed.ts';
import type { Llm, LlmConfig } from '../llm/types.ts';
import { chunkTurns, type Chunk } from '../transcript/chunk.ts';
import { parseTranscript, type Turn } from '../transcript/parse.ts';

export type IngestConfig = Pick<LlmConfig, 'embeddingModel' | 'embeddingDimensions'>;

export type IngestInput = {
  title: string;
  filename: string;
  rawText: string;
};

function insertMeeting(db: DatabaseSync, config: IngestConfig, input: IngestInput): number {
  const meeting = db
    .prepare(
      `INSERT INTO meetings (
         title, original_filename, raw_text, status,
         embedding_model, embedding_dimensions, char_count
       ) VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
    )
    .run(
      input.title,
      input.filename,
      input.rawText,
      config.embeddingModel,
      config.embeddingDimensions,
      input.rawText.length,
    );
  return Number(meeting.lastInsertRowid);
}

function insertTurns(db: DatabaseSync, meetingId: number, turns: Turn[]): void {
  insertRows(
    db,
    'INSERT INTO turns (meeting_id, turn_index, speaker, timestamp, start_seconds, text)',
    '(?, ?, ?, ?, ?, ?)',
    turns.map((turn, index) => [
      meetingId,
      index,
      turn.speaker,
      turn.timestamp,
      turn.startSeconds,
      turn.text,
    ]),
  );
}

function insertChunks(db: DatabaseSync, meetingId: number, chunks: Chunk[]): number[] {
  const inserted = insertRowsReturning(
    db,
    `INSERT INTO chunks (
       meeting_id, chunk_index, text, speaker_label,
       start_timestamp, end_timestamp, start_seconds, end_seconds,
       turn_start_index, turn_end_index
     )`,
    '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'id, chunk_index',
    chunks.map((chunk) => [
      meetingId,
      chunk.chunkIndex,
      chunk.text,
      chunk.speakerLabel,
      chunk.startTimestamp,
      chunk.endTimestamp,
      chunk.startSeconds,
      chunk.endSeconds,
      chunk.turnStartIndex,
      chunk.turnEndIndex,
    ]),
  ) as Array<{ id: number | bigint; chunk_index: number | bigint }>;
  const ids = Array.from({ length: chunks.length }, () => 0);
  for (const row of inserted) {
    ids[Number(row.chunk_index)] = Number(row.id);
  }
  return ids;
}

function storeTranscript(
  db: DatabaseSync,
  config: IngestConfig,
  input: IngestInput,
  turns: Turn[],
  chunks: Chunk[],
): { meetingId: number; chunkIds: number[] } {
  return inTransaction(db, () => {
    const meetingId = insertMeeting(db, config, input);
    insertTurns(db, meetingId, turns);
    return { meetingId, chunkIds: insertChunks(db, meetingId, chunks) };
  });
}

async function embedChunks(llm: Llm, chunks: Chunk[], signal?: AbortSignal): Promise<number[][]> {
  const vectors = await llm.embedDocuments(
    chunks.map((chunk) => chunk.text),
    signal,
  );
  if (vectors.length !== chunks.length) {
    throw new Error(`Expected ${chunks.length} embeddings, got ${vectors.length}`);
  }
  return vectors;
}

function storeEmbeddings(
  db: DatabaseSync,
  config: IngestConfig,
  meetingId: number,
  chunkIds: number[],
  vectors: number[][],
): void {
  inTransaction(db, () => {
    insertRows(
      db,
      'INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding)',
      '(?, ?, ?)',
      vectors.map((vector, index) => {
        if (vector.length !== config.embeddingDimensions) {
          throw new EmbeddingDimensionError(vector.length, config.embeddingDimensions);
        }
        return [chunkIds[index], meetingId, toVectorBlob(vector)];
      }),
    );
    db.prepare(`UPDATE meetings SET status = 'ready', error_message = NULL WHERE id = ?`).run(
      meetingId,
    );
  });
}

function storeFacts(db: DatabaseSync, meetingId: number, facts: ExtractedFacts): void {
  if (facts.decisions.length === 0 && facts.actionItems.length === 0) {
    return;
  }
  inTransaction(db, () => {
    insertRows(
      db,
      'INSERT INTO decisions (meeting_id, text, speaker, timestamp)',
      '(?, ?, ?, ?)',
      facts.decisions.map((decision) => [
        meetingId,
        decision.text,
        decision.speaker,
        decision.timestamp,
      ]),
    );
    insertRows(
      db,
      'INSERT INTO action_items (meeting_id, text, owner, due, timestamp)',
      '(?, ?, ?, ?, ?)',
      facts.actionItems.map((item) => [meetingId, item.text, item.owner, item.due, item.timestamp]),
    );
  });
}

function recoverIngestFailure(
  db: DatabaseSync,
  meetingId: number | undefined,
  embeddingsCommitted: boolean,
): void {
  if (meetingId === undefined || embeddingsCommitted) {
    // Extract runs after embeddings commit `ready`. Do not delete a searchable meeting.
    return;
  }
  try {
    db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
  } catch {
    // Keep the original ingest failure if recovery itself fails.
  }
}

export async function ingestTranscript(
  db: DatabaseSync,
  llm: Llm,
  config: IngestConfig,
  input: IngestInput,
  signal?: AbortSignal,
): Promise<{ meetingId: number }> {
  signal?.throwIfAborted();
  const turns = parseTranscript(input.rawText);
  const chunks = chunkTurns(turns);

  let meetingId: number | undefined;
  let embeddingsCommitted = false;
  try {
    const stored = storeTranscript(db, config, input, turns, chunks);
    meetingId = stored.meetingId;
    signal?.throwIfAborted();
    const vectors = await embedChunks(llm, chunks, signal);
    signal?.throwIfAborted();
    storeEmbeddings(db, config, stored.meetingId, stored.chunkIds, vectors);
    embeddingsCommitted = true;
    try {
      storeFacts(db, stored.meetingId, await extractFacts(llm, input.rawText, signal));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
    }
    return { meetingId: stored.meetingId };
  } catch (error) {
    recoverIngestFailure(db, meetingId, embeddingsCommitted);
    throw error;
  }
}
