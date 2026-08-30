import type { DatabaseSync } from 'node:sqlite';
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
  // INSERT...RETURNING order is undefined; index by the value we inserted.
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
    const meetingId = Number(
      db
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
        ).lastInsertRowid,
    );
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
    return { meetingId, chunkIds: insertChunks(db, meetingId, chunks) };
  });
}

function storeReady(
  db: DatabaseSync,
  meetingId: number,
  chunkIds: number[],
  vectors: number[][],
  facts: ExtractedFacts,
): void {
  const embeddings = vectors.map((vector, index) => [
    chunkIds[index],
    meetingId,
    toVectorBlob(vector),
  ]);
  const decisions = facts.decisions.map((decision) => [
    meetingId,
    decision.text,
    decision.speaker,
    decision.timestamp,
  ]);
  const actionItems = facts.actionItems.map((item) => [
    meetingId,
    item.text,
    item.owner,
    item.due,
    item.timestamp,
  ]);
  inTransaction(db, () => {
    insertRows(
      db,
      'INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding)',
      '(?, ?, ?)',
      embeddings,
    );
    insertRows(
      db,
      'INSERT INTO decisions (meeting_id, text, speaker, timestamp)',
      '(?, ?, ?, ?)',
      decisions,
    );
    insertRows(
      db,
      'INSERT INTO action_items (meeting_id, text, owner, due, timestamp)',
      '(?, ?, ?, ?, ?)',
      actionItems,
    );
    db.prepare(`UPDATE meetings SET status = 'ready' WHERE id = ?`).run(meetingId);
  });
}

export function discardMeeting(db: DatabaseSync, meetingId: number): void {
  try {
    db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
  } catch {
    // Best-effort: never mask the original ingest or abort error.
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
  const extractAbort = new AbortController();
  const extractSignal =
    signal === undefined ? extractAbort.signal : AbortSignal.any([signal, extractAbort.signal]);
  try {
    const { meetingId: id, chunkIds } = storeTranscript(db, config, input, turns, chunks);
    meetingId = id;
    signal?.throwIfAborted();

    const factsPromise = extractFacts(llm, turns, extractSignal);
    // Embed failure aborts extract without awaiting it; swallow so that is not unhandled.
    void factsPromise.catch(() => undefined);
    const vectors = await llm.embed(
      chunks.map((chunk) => chunk.text),
      signal,
    );
    if (vectors.length !== chunks.length) {
      throw new Error(`Expected ${chunks.length} embeddings, got ${vectors.length}`);
    }
    for (const vector of vectors) {
      if (vector.length !== config.embeddingDimensions) {
        throw new EmbeddingDimensionError(vector.length, config.embeddingDimensions);
      }
    }
    signal?.throwIfAborted();
    const facts = await factsPromise;
    signal?.throwIfAborted();
    storeReady(db, id, chunkIds, vectors, facts);
    return { meetingId: id };
  } catch (error) {
    extractAbort.abort();
    if (meetingId !== undefined) {
      discardMeeting(db, meetingId);
    }
    throw error;
  }
}
