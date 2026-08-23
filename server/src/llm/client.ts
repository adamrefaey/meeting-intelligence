import OpenAI from 'openai';
import { completeJson, streamChat } from './chat.ts';
import { embedDocuments, embedQueries } from './embed.ts';
import type { Llm, LlmConfig } from './types.ts';

export function createLlm(config: LlmConfig, options?: { fetch?: typeof fetch }): Llm {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.openaiBaseUrl,
    maxRetries: 0,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    embedDocuments: (texts, signal) => embedDocuments(client, config, texts, signal),
    embedQueries: (texts, signal) => embedQueries(client, config, texts, signal),
    completeJson: (messages, signal) => completeJson(client, config.chatModel, messages, signal),
    streamChat: (messages, signal) => streamChat(client, config.chatModel, messages, signal),
  };
}
