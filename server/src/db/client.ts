import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

export type CosineHit = {
  chunkId: number;
  distance: number;
};

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

export function toVectorBlob(values: number[]): Uint8Array {
  const floats = Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function fromVectorBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}

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
