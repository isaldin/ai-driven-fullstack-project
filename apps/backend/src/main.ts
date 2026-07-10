import 'reflect-metadata';
import { loadEnv } from '@app/config';
import { startOtel, stopOtel } from '@app/observability';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

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

  const isProd = env.NODE_ENV === 'production';

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  // Security headers. In production, enable helmet's full defaults (including a
  // Content-Security-Policy). Outside production, CSP is disabled so the Swagger
  // UI at /docs keeps working — but /docs is never served in production.
  app.use(isProd ? helmet() : helmet({ contentSecurityPolicy: false }));
  app.enableCors({ origin: env.CORS_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  // Swagger UI is an unauthenticated HTML surface — do not expose it in
  // production. The OpenAPI contract is published from the curated controllers;
  // gate /docs behind an access rule if you need it on a protected environment.
  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('App API')
      .setDescription('Curated REST/OpenAPI contract')
      .setVersion('0.1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'x-service-token', in: 'header' }, 'service-token')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  const shutdown = async (): Promise<void> => {
    await app.close();
    await stopOtel();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await app.listen(env.BACKEND_PORT);
}

void bootstrap();
