import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-app.js';

/**
 * Negative / error-path coverage for the auth surface: bad credentials, duplicate
 * registration, validation 400s, and every rejected token shape (missing/malformed/
 * expired bearer, missing/malformed refresh cookie). Complements the happy-path
 * `auth.e2e-spec.ts`.
 */
describe('Auth negative paths (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const email = `neg_${Date.now()}@example.com`;
  const password = 'password123';

  beforeAll(async () => {
    app = await createTestApp();
    jwt = app.get(JwtService);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Neg' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects duplicate registration with 409', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Dup' })
      .expect(409);
  });

  it('rejects registration with a too-short password (400 validation)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: `short_${Date.now()}@example.com`, password: 'short' })
      .expect(400);
  });

  it('rejects registration with a malformed email (400 validation)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password })
      .expect(400);
  });

  it('rejects login with the wrong password (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('rejects login for an unknown email (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `nobody_${Date.now()}@example.com`, password })
      .expect(401);
  });

  it('rejects refresh with no cookie (401)', async () => {
    await request(app.getHttpServer()).post('/auth/refresh').expect(401);
  });

  it('rejects refresh with a malformed cookie (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', ['refresh_token=garbage-no-dot'])
      .expect(401);
  });

  it('rejects refresh with an unknown token id (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', ['refresh_token=nonexistent-id.some-secret'])
      .expect(401);
  });

  it('rejects /auth/me with a malformed bearer token (401)', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('rejects /auth/me with an expired bearer token (401)', async () => {
    const expired = await jwt.signAsync(
      { sub: 'u-expired', email, role: 'USER' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '-10s' },
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });

  it('rejects the service endpoint with a wrong machine token (401)', async () => {
    await request(app.getHttpServer())
      .get('/users/count')
      .set('x-service-token', 'wrong-service-token')
      .expect(401);
  });

  it('never returns a password hash on login or /auth/me', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    // The login DTO carries only the access token — the refresh secret lives in the cookie.
    expect(Object.keys(login.body)).toEqual(['accessToken']);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body).not.toHaveProperty('passwordHash');
    expect(me.body).not.toHaveProperty('password');
    expect(me.body.email).toBe(email);
  });
});
