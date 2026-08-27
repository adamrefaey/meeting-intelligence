import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const app = await buildApp({ logger: true });

const shutdown = () => {
  const timer = setTimeout(() => process.exit(1), 5_000);
  timer.unref();
  app.close().then(
    () => process.exit(0),
    (error) => {
      app.log.error(error);
      process.exit(1);
    },
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
