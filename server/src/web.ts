import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export function resolveWebRoot(): string {
  return resolve(process.env.WEB_ROOT || 'web/dist');
}

export function webDistRoot(): string | undefined {
  const root = resolveWebRoot();
  return existsSync(join(root, 'index.html')) ? root : undefined;
}

export async function registerWeb(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    index: false,
    wildcard: false,
    globIgnore: ['**/index.html'],
    maxAge: '365d',
    immutable: true,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not found' });
    }
    const path = request.url.split('?')[0] ?? '';
    if (path === '/api' || path.startsWith('/api/') || path.startsWith('/assets/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // The index must revalidate every load; the hashed assets above are immutable.
    return reply.sendFile('index.html', { maxAge: 0, immutable: false });
  });
}
