import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const app = await buildApp({ logger: true });

try {
  await app.listen({ host: '127.0.0.1', port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
