import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { inTransaction, insertRows } from '../db/batch.ts';
import { toVectorBlob } from '../db/client.ts';
import { assertEmbeddings } from '../llm/embed.ts';
import type { Llm } from '../llm/types.ts';

/**
 * Replace this meeting's chunk_embeddings. Chunks themselves are not rebuilt.
 */
export async function reindexMeeting(
  db: DatabaseSync,
  llm: Llm,
  config: Pick<AppConfig, 'embeddingModel' | 'embeddingDimensions'>,
  meetingId: number,
  signal?: AbortSignal,
): Promise<void> {
  const rows = db
    .prepare(`SELECT id, text FROM chunks WHERE meeting_id = ? ORDER BY chunk_index`)
    .all(meetingId) as Array<{ id: number | bigint; text: string }>;
  const chunks = rows.map((row) => ({ id: Number(row.id), text: row.text }));
  signal?.throwIfAborted();
  const vectors = await llm.embed(
    chunks.map((chunk) => chunk.text),
    signal,
  );
  assertEmbeddings(vectors, chunks.length, config.embeddingDimensions);
  signal?.throwIfAborted();
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
