import { ApiClient } from '@app/api-client';
import { loadEnv } from '@app/config';
import { createLogger, startOtel, stopOtel } from '@app/observability';
import { RedisAdapter } from '@grammyjs/storage-redis';
import { Redis } from 'ioredis';
import { createBot } from './bot.js';
import type { SessionData } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const logger = createLogger({
    level: env.LOG_LEVEL,
    name: env.OTEL_SERVICE_NAME,
    pretty: env.NODE_ENV === 'development',
  });

  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.fatal('TELEGRAM_BOT_TOKEN is empty. Set it in the environment before starting the bot.');
    process.exitCode = 1;
    return;
  }

  startOtel({
    serviceName: env.OTEL_SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    environment: env.NODE_ENV,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otlpHeaders: env.OTEL_EXPORTER_OTLP_HEADERS,
    metricsExporter: env.METRICS_EXPORTER,
    verboseSpans: env.OTEL_VERBOSE_SPANS,
    disabled: env.OTEL_SDK_DISABLED,
  });

  const redis = new Redis(env.REDIS_URL);
  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  const api = new ApiClient({
    baseUrl: env.BACKEND_URL,
    serviceToken: env.SERVICE_API_TOKEN,
  });

  const bot = createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    api,
    logger,
    sessionStorage: new RedisAdapter<SessionData>({ instance: redis }),
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down Telegram bot');
    try {
      await bot.stop();
      await redis.quit();
      await stopOtel();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));

  await bot.start({
    onStart: (info) => {
      logger.info({ username: info.username, id: info.id }, 'Telegram bot started (long polling)');
    },
  });
}

main().catch((error) => {
  // loadEnv() can throw before the logger exists, so fall back to stderr here.
  console.error('Fatal error while starting the Telegram bot:', error);
  process.exit(1);
});
