import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

export type CosineHit = {
  chunkId: number;
  distance: number;
};

/**
 * Load sqlite-vec, then disable further extensions. WAL so HTTP readers are not
 * blocked by ingest writes; foreign_keys is required for ON DELETE CASCADE.
 * File paths get their parent directory created; `:memory:` does not.
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path, { allowExtension: true, timeout: 5000 });
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** sqlite-vec stores each embedding as a Float32 BLOB. */
export function toVectorBlob(values: number[]): Uint8Array {
  const floats = Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * Copy into a packed buffer first. `new Float32Array(blob.buffer)` would start
 * at byte 0 of a larger allocation if the driver returned a view.
 */
export function fromVectorBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}

/** Nearest neighbors by cosine *distance* (lower is closer), scoped to one meeting. */
export function cosineQuery(
  db: DatabaseSync,
  meetingId: number,
  queryVec: number[],
  k: number,
): CosineHit[] {
  const rows = db
    .prepare(
      `SELECT chunk_id AS chunkId, vec_distance_cosine(embedding, ?) AS distance
       FROM chunk_embeddings
       WHERE meeting_id = ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(toVectorBlob(queryVec), meetingId, k) as Array<{
    chunkId: number | bigint;
    distance: number;
  }>;
  return rows.map((row) => ({
    chunkId: Number(row.chunkId),
    distance: row.distance,
  }));
}
