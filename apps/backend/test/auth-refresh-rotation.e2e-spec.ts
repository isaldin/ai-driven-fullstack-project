import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-app.js';

/**
 * Refresh-token rotation is single-use: once a cookie is rotated it must never mint
 * another pair, and two concurrent requests bearing the same cookie must not both
 * succeed (the `updateMany({ revokedAt: null })` + `count === 1` TOCTOU guard in
 * AuthService.refresh).
 */
describe('Refresh token rotation (e2e)', () => {
  let app: INestApplication;
  const password = 'password123';

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function loginCookie(email: string): Promise<string[]> {
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return res.headers['set-cookie'] as unknown as string[];
  }

  it('rejects reuse of an already-rotated refresh cookie (401)', async () => {
    const cookies = await loginCookie(`rot_${Date.now()}@example.com`);

    // First rotation succeeds and issues a new cookie.
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookies).expect(201);

    // Replaying the original (now revoked) cookie must be rejected.
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookies).expect(401);
  });

  it('lets only one of two concurrent refreshes with the same cookie win', async () => {
    const cookies = await loginCookie(`conc_${Date.now()}@example.com`);

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookies),
      request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookies),
    ]);

    const statuses = [a.status, b.status].sort();
    // Exactly one 201 (winner) and one 401 (loser rejected by the count guard).
    expect(statuses).toEqual([201, 401]);
  });
});
