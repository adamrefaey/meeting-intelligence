import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm } from '../src/llm/client.ts';
import { EMBED_BATCH_SIZE, EmbeddingDimensionError } from '../src/llm/embed.ts';
import type { LlmConfig } from '../src/llm/types.ts';

type RecordedRequest = { url: string; body: Record<string, unknown> };

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    openaiBaseUrl: 'http://openai.test/v1',
    chatModel: 'gpt-5-mini',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 4,
    apiKey: 'test-key',
    ...overrides,
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function embeddingPayload(vectors: number[][]) {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({
      object: 'embedding',
      embedding,
      index,
    })),
    model: 'test',
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
}

async function readRequest(input: RequestInfo | URL, init?: RequestInit): Promise<RecordedRequest> {
  if (input instanceof Request) {
    return { url: input.url, body: JSON.parse(await input.clone().text()) };
  }
  const url = typeof input === 'string' ? input : input.href;
  const raw = init?.body;
  if (typeof raw !== 'string') {
    throw new Error(`unexpected body type: ${typeof raw}`);
  }
  return { url, body: JSON.parse(raw) };
}

function recordingFetch(
  handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>,
): { fetch: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = await readRequest(input, init);
    recorded.push(request);
    return handler(request.url, request.body);
  };
  return { fetch: fetchImpl, recorded };
}

function okEmbedFetch(vectors: number[][] = [[1, 0, 0, 0]]) {
  return recordingFetch(() => jsonResponse(200, embeddingPayload(vectors)));
}

test('embedDocuments splits inputs into EMBED_BATCH_SIZE requests', async () => {
  const texts = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, index) => `t${index}`);
  const { fetch, recorded } = recordingFetch((_url, body) => {
    const input = body.input as string[];
    return jsonResponse(200, embeddingPayload(input.map(() => [1, 0, 0, 0])));
  });
  const llm = createLlm(llmConfig(), { fetch });

  const vectors = await llm.embedDocuments(texts);

  assert.equal(vectors.length, texts.length);
  assert.equal(recorded.length, 2);
  assert.equal((recorded[0].body.input as string[]).length, EMBED_BATCH_SIZE);
  assert.equal((recorded[1].body.input as string[]).length, 1);
});

test('embedQueries sends query texts unchanged', async () => {
  const { fetch, recorded } = okEmbedFetch();
  const llm = createLlm(llmConfig(), { fetch });

  await llm.embedQueries(['what was decided?']);

  assert.equal(recorded.length, 1);
  assert.match(recorded[0].url, /^http:\/\/openai\.test\/v1\//);
  assert.deepEqual(recorded[0].body.input, ['what was decided?']);
  assert.equal(recorded[0].body.dimensions, 4);
  assert.equal(recorded[0].body.encoding_format, 'float');
});

test('embedDocuments sends document texts unchanged', async () => {
  const document = '[00:00:01–00:00:02] Ada\nAda: hi';
  const { fetch, recorded } = okEmbedFetch();
  const llm = createLlm(llmConfig(), { fetch });

  await llm.embedDocuments([document]);

  assert.equal(recorded.length, 1);
  assert.match(recorded[0].url, /^http:\/\/openai\.test\/v1\//);
  assert.deepEqual(recorded[0].body.input, [document]);
});

test('dimension mismatch throws EmbeddingDimensionError and requests dimensions for text-embedding-3', async () => {
  const { fetch, recorded } = okEmbedFetch([[1, 0, 0]]);
  const llm = createLlm(llmConfig(), { fetch });

  await assert.rejects(() => llm.embedDocuments(['x']), EmbeddingDimensionError);
  assert.equal(recorded[0].body.dimensions, 4);
});

test('text-embedding-3 dimensions are requested regardless of model name case', async () => {
  const { fetch, recorded } = okEmbedFetch();
  const llm = createLlm(llmConfig({ embeddingModel: 'TEXT-EMBEDDING-3-SMALL' }), { fetch });

  await llm.embedDocuments(['x']);

  assert.equal(recorded[0].body.dimensions, 4);
});

test('throws when the embedding API returns the wrong number of vectors', async () => {
  const { fetch } = okEmbedFetch([]);
  const llm = createLlm(llmConfig(), { fetch });

  await assert.rejects(() => llm.embedDocuments(['x']), /Expected 1 embeddings, got 0/);
});

test('embedDocuments and embedQueries skip the API when texts is empty', async () => {
  const { fetch, recorded } = recordingFetch(() => {
    throw new Error('fetch should not be called');
  });
  const llm = createLlm(llmConfig(), { fetch });

  assert.deepEqual(await llm.embedDocuments([]), []);
  assert.deepEqual(await llm.embedQueries([]), []);
  assert.equal(recorded.length, 0);
});

test('embedDocuments rejects when the abort signal is already aborted', async () => {
  const { fetch, recorded } = recordingFetch(() => jsonResponse(200, { data: [] }));
  const llm = createLlm(llmConfig(), { fetch });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => llm.embedDocuments(['x'], controller.signal));
  assert.equal(recorded.length, 0);
});

test('embedDocuments L2-normalizes returned vectors', async () => {
  const { fetch } = okEmbedFetch([[3, 4, 0, 0]]);
  const llm = createLlm(llmConfig(), { fetch });

  const [vector] = await llm.embedDocuments(['x']);
  assert.equal(vector.length, 4);
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(vector[1] - 0.8) < 1e-6);
  assert.equal(vector[2], 0);
  assert.equal(vector[3], 0);
});

test('L2-normalize leaves a zero vector unchanged', async () => {
  const { fetch } = okEmbedFetch([[0, 0, 0, 0]]);
  const llm = createLlm(llmConfig(), { fetch });

  const [vector] = await llm.embedDocuments(['x']);
  assert.deepEqual(vector, [0, 0, 0, 0]);
});
