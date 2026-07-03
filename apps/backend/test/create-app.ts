import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';

/**
 * Boots the real Nest application (full AppModule: real Postgres, the global
 * ThrottlerGuard / JwtAuthGuard / RolesGuard) for an e2e spec. Mirrors the parts
 * of `main.ts` that matter to HTTP behaviour — `cookieParser` for the refresh
 * cookie — while leaving helmet/CORS/Swagger out (not exercised by the specs).
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  app.use(cookieParser());
  await app.init();
  return app;
}
