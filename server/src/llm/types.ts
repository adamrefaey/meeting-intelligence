export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmConfig = {
  openaiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  apiKey: string;
};

export type Llm = {
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  embedQueries(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  completeJson(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
  streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
};
