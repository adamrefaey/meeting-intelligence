import { APIError, type OpenAI } from 'openai';
import type { ChatMessage } from './types.ts';

function shouldRetryWithoutStream(error: unknown): boolean {
  // OpenAI stream-gated 400s set param: 'stream'. Gateways behind OPENAI_BASE_URL
  // may omit param; treat absent param as "cannot stream".
  return (
    error instanceof APIError &&
    error.status === 400 &&
    (error.param === 'stream' || error.param == null)
  );
}

const REASONING_MODEL = /^(gpt-5|o1|o3|o4)/i;

/** Reasoning models reject `temperature`; others set the given value. */
export function chatSampling(model: string, temperature: number): { temperature?: number } {
  return REASONING_MODEL.test(model) ? {} : { temperature };
}

/**
 * Per-model `reasoning_effort` so json_object extract is accepted.
 * gpt-5-pro stays high; chat-named gpt-5 omits the field.
 */
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

type ChatChunk = {
  choices?: Array<{ delta?: { content?: string | null } }>;
};

export async function completeJson(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const extra = {
    ...chatSampling(model, 0),
    ...jsonReasoningEffort(model),
    response_format: { type: 'json_object' as const },
  };
  const res = await client.chat.completions.create({ model, messages, ...extra }, { signal });
  return res.choices[0]?.message?.content ?? '';
}

/**
 * Stream tokens. If a 400 has `param: 'stream'` or omits `param`, yield the
 * one-shot completion instead.
 */
export async function* streamChat(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncIterable<string> {
  signal?.throwIfAborted();
  const extra = chatSampling(model, 0.2);

  let stream: AsyncIterable<ChatChunk> | undefined;
  try {
    stream = await client.chat.completions.create(
      { model, messages, stream: true as const, ...extra },
      { signal },
    );
  } catch (error) {
    if (!shouldRetryWithoutStream(error)) {
      throw error;
    }
  }

  if (stream) {
    for await (const part of stream) {
      signal?.throwIfAborted();
      const text = part.choices?.[0]?.delta?.content;
      if (text) {
        yield text;
      }
    }
    return;
  }

  const res = await client.chat.completions.create({ model, messages, ...extra }, { signal });
  const content = res.choices[0]?.message?.content;
  if (content) {
    yield content;
  }
}
