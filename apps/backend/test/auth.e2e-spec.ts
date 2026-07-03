import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-app.js';

describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  const email = `e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let cookies: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers a user without leaking the password hash', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'E2E' })
      .expect(201);
    expect(res.body.email).toBe(email);
    expect(res.body.role).toBe('USER');
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('logs in and sets an HttpOnly refresh cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    expect(res.body.accessToken).toBeTruthy();
    accessToken = res.body.accessToken;
    cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('refresh_token=');
    expect(cookies.join(';')).toContain('HttpOnly');
  });

  it('returns the current user via bearer token', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.email).toBe(email);
  });

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('rotates the access token via the refresh cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookies)
      .expect(201);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('passes the readiness health check (database up)', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('guards the service endpoint with the machine token', async () => {
    await request(app.getHttpServer()).get('/users/count').expect(401);
    const res = await request(app.getHttpServer())
      .get('/users/count')
      .set('x-service-token', process.env.SERVICE_API_TOKEN ?? '')
      .expect(200);
    expect(typeof res.body.count).toBe('number');
  });
});
