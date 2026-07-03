import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-app.js';

/**
 * The unauthenticated auth endpoints carry a tight per-IP rate limit
 * (`@Throttle({ limit: 10, ttl: 60_000 })`) to blunt brute-force. Isolated in its
 * own file so the fresh per-file app gives the in-memory throttler a clean counter —
 * sharing a file with other `/auth/*` calls would spend part of the 10-request budget.
 */
describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 429 once the login rate limit is exceeded', async () => {
    const statuses: number[] = [];
    // 10 requests are allowed within the window; the 11th must be throttled.
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: `throttle_${i}@example.com`, password: 'password123' });
      statuses.push(res.status);
    }

    // The first ten are let through (401 unknown credentials), the eleventh is 429.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
