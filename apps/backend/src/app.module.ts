import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from '@app/config';
import { createLoggerOptions } from '@app/observability';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { OtelExceptionInterceptor } from './observability/otel-exception.interceptor.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => {
        const env = loadEnv();
        return {
          pinoHttp: {
            ...createLoggerOptions({
              level: env.LOG_LEVEL,
              name: env.OTEL_SERVICE_NAME,
              pretty: env.NODE_ENV === 'development',
            }),
            // Auto request/response logs are verbose access logs (they carry every req/res
            // header). Emit successful ones at `debug` so the default `info` level hides the
            // noise, while problems still surface: 4xx→warn, 5xx→error. Raise LOG_LEVEL=debug
            // to see the full access log (headers included) when you actually need it.
            customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) =>
              err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug',
          },
        };
      },
    }),
    // Global rate limiting: 120 req/min/IP baseline; auth routes tighten this
    // further with @Throttle (see AuthController).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ConfigModule,
    DatabaseModule,
    AuthModule,
    UsersModule,
    HealthModule,
  ],
  providers: [
    // Records 5xx exceptions on the active trace span (recordException + ERROR status) so
    // failures are inspectable inside the distributed trace, not just as a red bar.
    { provide: APP_INTERCEPTOR, useClass: OtelExceptionInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
