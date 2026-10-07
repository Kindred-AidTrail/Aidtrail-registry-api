import { buildApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabaseConnection } from './db/prisma.js';

async function start() {
  const app = buildApp();

  // Handle graceful shutdowns
  const handleShutdown = async (signal: string) => {
    app.log.info(`Received ${signal}. Gracefully shutting down AidTrail API...`);
    try {
      await app.close();
      await closeDatabaseConnection();
      app.log.info('AidTrail API server and database connection closed.');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    app.log.info(
      `AidTrail Registry API server running on http://${env.HOST}:${env.PORT} in ${env.NODE_ENV} mode`
    );
  } catch (err) {
    app.log.error(err, 'Failed to start AidTrail API server');
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}
