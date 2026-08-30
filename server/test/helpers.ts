import { afterEach, beforeEach } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, toVectorBlob } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import type { Llm } from '../src/llm/types.ts';
import type { Turn } from '../src/transcript/parse.ts';

const CONFIG_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CHAT_MODEL',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'DATABASE_PATH',
  'FULL_CONTEXT_CHAR_THRESHOLD',
  'RETRIEVE_K',
  'FTS_K',
  'CHAT_HISTORY_TURNS',
  'PORT',
  'HOST',
  'WEB_ROOT',
] as const;

const testEnv = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  CHAT_MODEL: 'gpt-5-mini',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: '4',
  DATABASE_PATH: ':memory:',
  FULL_CONTEXT_CHAR_THRESHOLD: '24000',
  RETRIEVE_K: '8',
  FTS_K: '8',
  CHAT_HISTORY_TURNS: '8',
  PORT: '3000',
  HOST: '127.0.0.1',
} as const;

export const embedConfig = {
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 4,
};

/** Snapshot and restore process.env around each test. Call once at module scope. */
export function useTestEnv(): void {
  const snapshot: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      snapshot[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(testEnv)) {
      process.env[key] = value;
    }
    delete process.env.WEB_ROOT;
  });
  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      const previous = snapshot[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
}

export function clearOptionalConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) {
    if (key !== 'OPENAI_API_KEY') {
      delete process.env[key];
    }
  }
}

export function unitVectors(count: number, dimensions: number): number[][] {
  return Array.from({ length: count }, (_, index) => {
    const vector = Array.from({ length: dimensions }, () => 0);
    vector[index % dimensions] = 1;
    return vector;
  });
}

export function unused(): never {
  throw new Error('not used');
}

/** One speaker, one turn per second, every turn the same length. */
export function numberedTurns(count: number, body: string): Turn[] {
  return Array.from({ length: count }, (_, index) => {
    const hours = String(Math.floor(index / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((index % 3600) / 60)).padStart(2, '0');
    const seconds = String(index % 60).padStart(2, '0');
    return {
      speaker: 'Ada',
      timestamp: `${hours}:${minutes}:${seconds}`,
      startSeconds: index,
      text: body,
    };
  });
}

/** Renders turns back into the upload format the parser accepts. */
export function transcriptText(turns: Turn[]): string {
  return turns.map((turn) => `[${turn.timestamp}] ${turn.speaker}: ${turn.text}`).join('\n');
}

export function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export async function waitForAbort(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => reject(new Error('disconnect signal did not abort')), 5_000);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

type FakeLlmOptions = {
  embed?: Llm['embed'];
  completeJson?: Llm['completeJson'];
  streamChat?: Llm['streamChat'];
};

export function fakeLlm(options: FakeLlmOptions = {}): Llm {
  return {
    embed: options.embed ?? (async (texts) => unitVectors(texts.length, 4)),
    completeJson: options.completeJson ?? (async () => '{"decisions":[],"actionItems":[]}'),
    streamChat:
      options.streamChat ??
      async function* () {
        yield 'Hello';
        yield ' world';
      },
  };
}

export function openMigratedMemoryDb(): DatabaseSync {
  const opened = openDb(':memory:');
  migrate(opened);
  return opened;
}

export function insertMeeting(
  database: DatabaseSync,
  title = 'Standup',
  status = 'processing',
): number {
  const result = database
    .prepare(
      `INSERT INTO meetings (title, status)
       VALUES (?, ?)`,
    )
    .run(title, status);
  return Number(result.lastInsertRowid);
}

export function insertChunk(
  database: DatabaseSync,
  meetingId: number,
  chunkIndex: number,
  text: string,
): number {
  const result = database
    .prepare(
      `INSERT INTO chunks (
         meeting_id, chunk_index, text, speaker_label,
         start_timestamp, end_timestamp, start_seconds, end_seconds,
         turn_start_index, turn_end_index
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(meetingId, chunkIndex, text, 'Ada', '00:00:00', '00:00:05', 0, 5, 0, 0);
  return Number(result.lastInsertRowid);
}

export function insertEmbedding(
  database: DatabaseSync,
  chunkId: number,
  meetingId: number,
  vector: number[],
): void {
  database
    .prepare('INSERT INTO chunk_embeddings (chunk_id, meeting_id, embedding) VALUES (?, ?, ?)')
    .run(chunkId, meetingId, toVectorBlob(vector));
}
