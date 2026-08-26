import OpenAI, { APIError } from 'openai';
import type { ChatMessage } from './types.ts';

function requestOptions(signal?: AbortSignal) {
  return signal ? { signal } : {};
}

function isRetryable400(error: unknown): boolean {
  return error instanceof APIError && error.status === 400;
}

const REASONING_MODEL = /^(gpt-5|o1|o3|o4)/i;

export function chatSampling(model: string, temperature: number): { temperature?: number } {
  return REASONING_MODEL.test(model) ? {} : { temperature };
}

export function jsonReasoningEffort(model: string): {
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'high';
} {
  if (!REASONING_MODEL.test(model)) {
    return {};
  }
  if (/^gpt-5/i.test(model) && /chat/i.test(model)) {
    return {};
  }
  if (/gpt-5-pro/i.test(model)) {
    return { reasoning_effort: 'high' };
  }
  // gpt-5.1+ rejects 'minimal'; gpt-5 / gpt-5-mini / gpt-5-nano reject 'none'.
  if (/^gpt-5\.\d/i.test(model)) {
    return { reasoning_effort: 'none' };
  }
  if (/^gpt-5/i.test(model)) {
    return { reasoning_effort: 'minimal' };
  }
  return { reasoning_effort: 'low' };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  void promise.catch(() => undefined);
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

type ChatChunk = {
  choices?: Array<{ delta?: { content?: string | null } }>;
};

async function* deltaContent(stream: AsyncIterable<ChatChunk>): AsyncGenerator<string> {
  for await (const part of stream) {
    const text = part.choices?.[0]?.delta?.content;
    if (text) {
      yield text;
    }
  }
}

async function collectDeltaContent(
  stream: AsyncIterable<ChatChunk>,
  signal?: AbortSignal,
): Promise<string> {
  const collect = (async () => {
    let content = '';
    for await (const text of deltaContent(stream)) {
      signal?.throwIfAborted();
      content += text;
    }
    return content;
  })();
  return signal ? raceAbort(collect, signal) : collect;
}

export async function completeJson(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const options = requestOptions(signal);
  const extra = {
    ...chatSampling(model, 0),
    ...jsonReasoningEffort(model),
    response_format: { type: 'json_object' as const },
  };

  try {
    const chunks = await client.chat.completions.create(
      { model, messages, stream: true as const, ...extra },
      options,
    );
    return await collectDeltaContent(chunks, signal);
  } catch (error) {
    if (!isRetryable400(error)) {
      throw error;
    }
  }

  const res = await client.chat.completions.create({ model, messages, ...extra }, options);
  return res.choices[0]?.message?.content ?? '';
}

export async function* streamChat(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncIterable<string> {
  signal?.throwIfAborted();
  const options = requestOptions(signal);
  const extra = chatSampling(model, 0.2);

  try {
    const stream = await client.chat.completions.create(
      { model, messages, stream: true as const, ...extra },
      options,
    );
    for await (const text of deltaContent(stream)) {
      signal?.throwIfAborted();
      yield text;
    }
    return;
  } catch (error) {
    if (!isRetryable400(error)) {
      throw error;
    }
  }

  const res = await client.chat.completions.create({ model, messages, ...extra }, options);
  const content = res.choices[0]?.message?.content;
  if (content) {
    yield content;
  }
}
