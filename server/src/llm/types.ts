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
};
