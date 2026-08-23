import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { createLlm } from './llm/client.ts';
import type { Llm } from './llm/types.ts';
import { chatRoutes } from './routes/chat.ts';
import { healthRoutes } from './routes/health.ts';
import { meetingsRoutes } from './routes/meetings.ts';

const FIVE_MIB = 5 * 1024 * 1024;

export async function buildApp(options?: {
  logger?: boolean;
  db?: DatabaseSync;
  llm?: Llm;
}): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = Fastify({
    logger: options?.logger ?? true,
    // Fastify defaults this to 0 (no limit); a non-zero value stops a slow-body client
    // from holding a socket open. It only bounds receiving the request, so ingest is
    // never truncated. Do not add a route handlerTimeout — it hangs multipart `parts()`.
    requestTimeout: 600_000,
  });

  const ownsDb = options?.db === undefined;
  const db = options?.db ?? openDb(config.databasePath);
  if (ownsDb) {
    migrate(db);
    app.addHook('onClose', async () => {
      db.close();
    });
  }

  const llm = options?.llm ?? createLlm(config);

  await app.register(cors, { origin: 'http://localhost:5173' });
  await app.register(healthRoutes(config));
  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: FIVE_MIB, files: 1 },
    });
    await scope.register(meetingsRoutes({ db, llm, config }));
  });
  await app.register(chatRoutes({ db, llm, config }));

  return app;
}
