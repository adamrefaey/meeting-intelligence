import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config.ts';
import { healthRoutes } from './routes/health.ts';

export async function buildApp(options?: { logger?: boolean }): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = Fastify({
    logger: options?.logger ?? true,
    // Fastify defaults this to 0 (no limit); a non-zero value stops a slow-body client
    // from holding a socket open. It only bounds receiving the request, so ingest is
    // never truncated. Do not add a route handlerTimeout — it hangs multipart `parts()`.
    requestTimeout: 600_000,
  });

  await app.register(cors, { origin: 'http://localhost:5173' });
  await app.register(healthRoutes(config));

  return app;
}
