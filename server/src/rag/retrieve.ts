import type { DatabaseSync } from 'node:sqlite';
import { isAbortError } from '../abort.ts';
import { cosineQuery } from '../db/client.ts';
import type { Llm } from '../llm/types.ts';
import { reciprocalRankFusion } from './fuse.ts';

export type RetrieveConfig = {
  retrieveK: number;
  ftsK: number;
};

export type RetrievedChunk = {
  id: number;
  meetingId: number;
  chunkIndex: number;
  text: string;
  speakerLabel: string;
  startTimestamp: string;
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  turnStartIndex: number;
  turnEndIndex: number;
  score: number;
};

type ChunkRow = {
  id: number | bigint;
  meeting_id: number | bigint;
  chunk_index: number;
  text: string;
  speaker_label: string;
  start_timestamp: string;
  end_timestamp: string;
  start_seconds: number;
  end_seconds: number;
  turn_start_index: number;
  turn_end_index: number;
};

export function shouldUseFullTranscript(charCount: number, threshold: number): boolean {
  return charCount < threshold;
}

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

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

function loadChunks(db: DatabaseSync, meetingId: number, ids: number[]): Map<number, ChunkRow> {
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, meeting_id, chunk_index, text, speaker_label,
              start_timestamp, end_timestamp, start_seconds, end_seconds,
              turn_start_index, turn_end_index
       FROM chunks
       WHERE meeting_id = ? AND id IN (${placeholders})`,
    )
    .all(meetingId, ...ids) as ChunkRow[];
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function toRetrievedChunk(row: ChunkRow, score: number): RetrievedChunk {
  return {
    id: Number(row.id),
    meetingId: Number(row.meeting_id),
    chunkIndex: row.chunk_index,
    text: row.text,
    speakerLabel: row.speaker_label,
    startTimestamp: row.start_timestamp,
    endTimestamp: row.end_timestamp,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    turnStartIndex: row.turn_start_index,
    turnEndIndex: row.turn_end_index,
    score,
  };
}

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
  const fused = reciprocalRankFusion([ftsIds, await embedded]).slice(0, config.retrieveK);
  const byId = loadChunks(
    db,
    meetingId,
    fused.map((hit) => hit.id),
  );
  const results: RetrievedChunk[] = [];
  for (const hit of fused) {
    const row = byId.get(hit.id);
    if (row !== undefined) {
      results.push(toRetrievedChunk(row, hit.score));
    }
  }
  return results;
}
