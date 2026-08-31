import OpenAI from 'openai';
import { completeJson, streamChat } from './chat.ts';
import { embed } from './embed.ts';
import type { Llm, LlmConfig } from './types.ts';

/** `maxRetries: 0` so abort and HTTP errors surface to the caller instead of being retried. */
export function createLlm(config: LlmConfig, options?: { fetch?: typeof fetch }): Llm {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.openaiBaseUrl,
    maxRetries: 0,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    embed: (texts, signal) => embed(client, config, texts, signal),
    completeJson: (messages, signal) => completeJson(client, config.chatModel, messages, signal),
    streamChat: (messages, signal) => streamChat(client, config.chatModel, messages, signal),
  };
}
