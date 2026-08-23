import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.ts';

export function healthRoutes(config: AppConfig): FastifyPluginAsync {
  return async (app) => {
    app.get('/api/health', async () => ({
      ok: true as const,
      chatModel: config.chatModel,
      embeddingModel: config.embeddingModel,
    }));
  };
}
