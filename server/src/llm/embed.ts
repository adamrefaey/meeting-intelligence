import type OpenAI from 'openai';
import type { LlmConfig } from './types.ts';

export const EMBED_BATCH_SIZE = 128;

export class EmbeddingDimensionError extends Error {
  override name = 'EmbeddingDimensionError';
  constructor(actual: number, expected: number) {
    super(`Embedding dimension ${actual} !== ${expected}`);
  }
}

export function assertEmbeddings(
  vectors: number[][],
  expectedCount: number,
  dimensions: number,
): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} embeddings, got ${vectors.length}`);
  }
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new EmbeddingDimensionError(vector.length, dimensions);
    }
  }
}

function l2NormalizeInPlace(vector: number[]): void {
  let sumSq = 0;
  for (const n of vector) {
    sumSq += n * n;
  }
  const magnitude = Math.sqrt(sumSq);
  if (magnitude === 0) {
    return;
  }
  const scale = 1 / magnitude;
  for (let i = 0; i < vector.length; i++) {
    vector[i] *= scale;
  }
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
    { signal },
  );

  const vectors = response.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
  assertEmbeddings(vectors, texts.length, config.embeddingDimensions);
  for (const vector of vectors) {
    l2NormalizeInPlace(vector);
  }
  return vectors;
}

export async function embed(
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
