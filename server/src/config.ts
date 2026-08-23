export type AppConfig = {
  openaiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  apiKey: string;
  databasePath: string;
  fullContextCharThreshold: number;
  retrieveK: number;
  ftsK: number;
  chatHistoryTurns: number;
  port: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

export function loadConfig(): AppConfig {
  const embeddingDimensions = optionalNumber('EMBEDDING_DIMENSIONS', 1536);
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new Error('EMBEDDING_DIMENSIONS must be a positive integer');
  }

  return {
    openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    chatModel: optional('CHAT_MODEL', 'gpt-5-mini'),
    embeddingModel: optional('EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDimensions,
    apiKey: required('OPENAI_API_KEY'),
    databasePath: optional('DATABASE_PATH', 'data/app.db'),
    fullContextCharThreshold: optionalNumber('FULL_CONTEXT_CHAR_THRESHOLD', 24000),
    retrieveK: optionalNumber('RETRIEVE_K', 8),
    ftsK: optionalNumber('FTS_K', 8),
    chatHistoryTurns: optionalNumber('CHAT_HISTORY_TURNS', 8),
    port: optionalNumber('PORT', 3000),
  };
}
