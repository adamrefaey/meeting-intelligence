import type { DatabaseSync } from 'node:sqlite';
import { isAbortError } from '../abort.ts';
import { cosineQuery } from '../db/client.ts';
import type { Llm } from '../llm/types.ts';
import { reciprocalRankFusion } from './fuse.ts';

type RetrieveConfig = {
  retrieveK: number;
  ftsK: number;
};

export type RetrievedChunk = {
  id: number;
  meetingId: number;
  text: string;
};

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Strip embedded quotes, then quote letter/digit tokens and OR them so punctuation is not FTS syntax. */
export function toFtsMatchQuery(query: string): string | undefined {
  const tokens = query
    .replaceAll('"', ' ')
    .split(/\s+/)
    .filter((token) => HAS_LETTER_OR_DIGIT.test(token));
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

/** FTS errors become no lexical hits so vector-only retrieve still works. */
function lexicalIds(db: DatabaseSync, meetingId: number, query: string, ftsK: number): number[] {
  const match = toFtsMatchQuery(query);
  if (match === undefined) {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT chunks.id AS id
         FROM chunks
         JOIN chunks_fts ON chunks_fts.rowid = chunks.id
         WHERE chunks.meeting_id = ?
           AND chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts)
         LIMIT ?`,
      )
      .all(meetingId, match, ftsK) as Array<{ id: number | bigint }>;
    return rows.map((row) => Number(row.id));
  } catch {
    return [];
  }
}

/** Reassemble rows in fused-rank order; `IN (...)` does not preserve it. */
function loadChunks(db: DatabaseSync, meetingId: number, ids: number[]): RetrievedChunk[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, meeting_id, text
       FROM chunks
       WHERE meeting_id = ? AND id IN (${placeholders})`,
    )
    .all(meetingId, ...ids) as Array<{
    id: number | bigint;
    meeting_id: number | bigint;
    text: string;
  }>;
  const byId = new Map(
    rows.map((row) => {
      const id = Number(row.id);
      return [id, { id, meetingId: Number(row.meeting_id), text: row.text }] as const;
    }),
  );
  const results: RetrievedChunk[] = [];
  for (const id of ids) {
    const chunk = byId.get(id);
    if (chunk !== undefined) {
      results.push(chunk);
    }
  }
  return results;
}

/** Abort still throws. Any other error is an empty list so FTS-only still works. */
async function vectorIds(
  db: DatabaseSync,
  llm: Llm,
  meetingId: number,
  query: string,
  k: number,
  signal?: AbortSignal,
): Promise<number[]> {
  try {
    const vectors = await llm.embed([query], signal);
    if (vectors[0] === undefined) {
      return [];
    }
    return cosineQuery(db, meetingId, vectors[0], k).map((hit) => hit.chunkId);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return [];
  }
}

/** Embed the query while FTS runs, fuse both FTS_K lists, then keep RETRIEVE_K. */
export async function retrieveForMeeting(
  db: DatabaseSync,
  llm: Llm,
  meetingId: number,
  query: string,
  config: RetrieveConfig,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  const embedded = vectorIds(db, llm, meetingId, query, config.ftsK, signal);
  const ftsIds = lexicalIds(db, meetingId, query, config.ftsK);
  return loadChunks(
    db,
    meetingId,
    reciprocalRankFusion([ftsIds, await embedded])
      .slice(0, config.retrieveK)
      .map((hit) => hit.id),
  );
}
