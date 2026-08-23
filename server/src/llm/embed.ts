import type OpenAI from 'openai';
import type { LlmConfig } from './types.ts';

export const EMBED_BATCH_SIZE = 128;

export class EmbeddingDimensionError extends Error {
  override name = 'EmbeddingDimensionError';
  constructor(actual: number, expected: number) {
    super(`Embedding dimension ${actual} !== ${expected}`);
  }
}

function l2Normalize(vector: number[]): number[] {
  let sumSq = 0;
  for (const n of vector) {
    sumSq += n * n;
  }
  const magnitude = Math.sqrt(sumSq);
  if (magnitude === 0) {
    return vector;
  }
  const scale = 1 / magnitude;
  for (let i = 0; i < vector.length; i++) {
    vector[i] *= scale;
  }
  return vector;
}

async function embedSlice(
  client: OpenAI,
  config: LlmConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await client.embeddings.create(
    {
      model: config.embeddingModel,
      input: texts,
      encoding_format: 'float',
      ...(config.embeddingModel.toLowerCase().startsWith('text-embedding-3')
        ? { dimensions: config.embeddingDimensions }
        : {}),
    },
    signal ? { signal } : {},
  );

  const ordered = response.data.sort((a, b) => a.index - b.index);
  if (ordered.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${ordered.length}`);
  }

  return ordered.map((row) => {
    const vector = l2Normalize(row.embedding);
    if (vector.length !== config.embeddingDimensions) {
      throw new EmbeddingDimensionError(vector.length, config.embeddingDimensions);
    }
    return vector;
  });
}

async function embed(
  client: OpenAI,
  config: LlmConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  signal?.throwIfAborted();
  if (texts.length === 0) {
    return [];
  }

  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    signal?.throwIfAborted();
    vectors.push(
      ...(await embedSlice(client, config, texts.slice(offset, offset + EMBED_BATCH_SIZE), signal)),
    );
  }
  return vectors;
}

export function embedDocuments(
  client: OpenAI,
  config: LlmConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  return embed(client, config, texts, signal);
}

export function embedQueries(
  client: OpenAI,
  config: LlmConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  return embed(client, config, texts, signal);
}
