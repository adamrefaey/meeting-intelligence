import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSampling, jsonReasoningEffort } from '../src/llm/chat.ts';
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

function chatCompletionPayload(content: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  };
}

function sseChatResponse(deltas: string[]): Response {
  const events = deltas.map((content) => {
    const chunk = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-5-mini',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  return new Response(`${events.join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function streamGated400(): Response {
  return jsonResponse(400, {
    error: {
      message: 'Your organization must be verified to stream this model.',
      type: 'invalid_request_error',
      param: 'stream',
      code: 'unsupported_value',
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) {
    out += chunk;
  }
  return out;
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

test('chatSampling omits temperature for GPT-5 and o-series models', () => {
  assert.deepEqual(chatSampling('gpt-5-mini', 0.2), {});
  assert.deepEqual(chatSampling('GPT-5', 0), {});
  assert.deepEqual(chatSampling('o1-preview', 0.2), {});
  assert.deepEqual(chatSampling('o4-mini', 0), {});
  assert.deepEqual(chatSampling('o3-mini', 0), {});
  assert.deepEqual(chatSampling('gpt-4.1', 0.2), { temperature: 0.2 });
});

test('jsonReasoningEffort maps model families to supported effort values', () => {
  assert.deepEqual(jsonReasoningEffort('gpt-5-mini'), { reasoning_effort: 'minimal' });
  assert.deepEqual(jsonReasoningEffort('GPT-5'), { reasoning_effort: 'minimal' });
  assert.deepEqual(jsonReasoningEffort('gpt-5-nano'), { reasoning_effort: 'minimal' });
  assert.deepEqual(jsonReasoningEffort('gpt-5.1'), { reasoning_effort: 'none' });
  assert.deepEqual(jsonReasoningEffort('gpt-5.3'), { reasoning_effort: 'none' });
  assert.deepEqual(jsonReasoningEffort('gpt-5.5'), { reasoning_effort: 'none' });
  assert.deepEqual(jsonReasoningEffort('gpt-5.2-chat'), {});
  assert.deepEqual(jsonReasoningEffort('gpt-5-chat-latest'), {});
  assert.deepEqual(jsonReasoningEffort('gpt-5-pro'), { reasoning_effort: 'high' });
  assert.deepEqual(jsonReasoningEffort('o3-mini'), { reasoning_effort: 'low' });
  assert.deepEqual(jsonReasoningEffort('o4-mini'), { reasoning_effort: 'low' });
  assert.deepEqual(jsonReasoningEffort('gpt-4.1'), {});
});

test("streamChat yields concatenated deltas 'ab' from two chunks", async () => {
  const { fetch, recorded } = recordingFetch(() => sseChatResponse(['a', 'b']));
  const llm = createLlm(llmConfig(), { fetch });

  const text = await collect(llm.streamChat([{ role: 'user', content: 'hi' }]));

  assert.equal(text, 'ab');
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].url, /^http:\/\/openai\.test\/v1\//);
  assert.equal(recorded[0].body.stream, true);
  assert.equal(recorded[0].body.temperature, undefined);
  assert.equal(recorded[0].body.reasoning_effort, undefined);
});

test('streamChat sends temperature 0.2 for non-reasoning chat models', async () => {
  const { fetch, recorded } = recordingFetch(() => sseChatResponse(['ok']));
  const llm = createLlm(llmConfig({ chatModel: 'gpt-4.1' }), { fetch });

  await collect(llm.streamChat([{ role: 'user', content: 'hi' }]));

  assert.equal(recorded[0].body.temperature, 0.2);
});

test('streamChat falls back to a non-streaming create after a stream 400', async () => {
  const { fetch, recorded } = recordingFetch((_url, body) => {
    if (body.stream) {
      return streamGated400();
    }
    return jsonResponse(200, chatCompletionPayload('ok'));
  });
  const llm = createLlm(llmConfig(), { fetch });

  const text = await collect(llm.streamChat([{ role: 'user', content: 'hi' }]));

  assert.equal(text, 'ok');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].body.stream, true);
  assert.equal(recorded[1].body.stream, undefined);
  assert.equal(recorded[1].body.temperature, undefined);
});

test('streamChat rejects when the abort signal is already aborted', async () => {
  const { fetch } = recordingFetch(() => sseChatResponse(['nope']));
  const llm = createLlm(llmConfig(), { fetch });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() =>
    collect(llm.streamChat([{ role: 'user', content: 'hi' }], controller.signal)),
  );
});

test('completeJson returns content when json_object is supported', async () => {
  const { fetch, recorded } = recordingFetch(() => sseChatResponse(['{"ok":', 'true}']));
  const llm = createLlm(llmConfig(), { fetch });

  const result = await llm.completeJson([
    { role: 'user', content: 'Return a JSON object with ok true' },
  ]);

  assert.equal(result, '{"ok":true}');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].body.stream, true);
  assert.deepEqual(recorded[0].body.response_format, { type: 'json_object' });
  assert.equal(recorded[0].body.temperature, undefined);
  assert.equal(recorded[0].body.reasoning_effort, 'minimal');
  assert.equal(recorded[0].body.max_tokens, undefined);
});

test('completeJson sends temperature 0 for non-reasoning chat models', async () => {
  const { fetch, recorded } = recordingFetch(() => sseChatResponse(['{"ok":true}']));
  const llm = createLlm(llmConfig({ chatModel: 'gpt-4.1' }), { fetch });

  await llm.completeJson([{ role: 'user', content: 'Return a JSON object with ok true' }]);

  assert.equal(recorded[0].body.stream, true);
  assert.equal(recorded[0].body.temperature, 0);
  assert.equal(recorded[0].body.reasoning_effort, undefined);
  assert.equal(recorded[0].body.max_tokens, undefined);
});

test('completeJson rejects when aborted during a hanging stream', { timeout: 2000 }, async () => {
  const hanging = new Response(
    new ReadableStream({
      start() {
        // Never enqueue; the abort signal must reject without waiting on SSE.
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  const { fetch } = recordingFetch(() => hanging);
  const llm = createLlm(llmConfig(), { fetch });
  const controller = new AbortController();
  const pending = llm.completeJson(
    [{ role: 'user', content: 'Return a JSON object with ok true' }],
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => pending, { name: 'AbortError' });
});

test('completeJson rejects when abort errors the SSE body', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(stream) {
          const fail = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            stream.error(error);
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener('abort', fail, { once: true });
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const llm = createLlm(llmConfig(), { fetch: fetchImpl });
  const pending = llm.completeJson(
    [{ role: 'user', content: 'Return a JSON object with ok true' }],
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => pending, { name: 'AbortError' });
});

test('completeJson falls back to a non-streaming create after a stream 400', async () => {
  const { fetch, recorded } = recordingFetch((_url, body) => {
    if (body.stream) {
      return streamGated400();
    }
    return jsonResponse(200, chatCompletionPayload('{"ok":true}'));
  });
  const llm = createLlm(llmConfig(), { fetch });

  const result = await llm.completeJson([
    { role: 'user', content: 'Return a JSON object with ok true' },
  ]);

  assert.equal(result, '{"ok":true}');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].body.stream, true);
  assert.equal(recorded[1].body.stream, undefined);
  assert.deepEqual(recorded[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(recorded[1].body.response_format, { type: 'json_object' });
});

test('completeJson does not retry when the API returns 401', async () => {
  const { fetch, recorded } = recordingFetch(() =>
    jsonResponse(401, {
      error: { message: 'invalid api key', type: 'invalid_request_error' },
    }),
  );
  const llm = createLlm(llmConfig(), { fetch });

  await assert.rejects(() => llm.completeJson([{ role: 'user', content: 'Return a JSON object' }]));
  assert.equal(recorded.length, 1);
});
