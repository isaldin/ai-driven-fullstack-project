import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { DatabaseService } from '../database/database.service.js';
import { AuthService } from './auth.service.js';

function setup() {
  const db = {
    client: {
      user: { findUnique: vi.fn(), create: vi.fn() },
      refreshToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('access-token') };
  const config = {
    env: { JWT_ACCESS_SECRET: 's'.repeat(32), JWT_ACCESS_TTL: 900, JWT_REFRESH_TTL: 1000 },
  };
  const service = new AuthService(
    db as unknown as DatabaseService,
    jwt as never,
    config as unknown as AppConfig,
  );
  return { service, db, jwt };
}

describe('AuthService', () => {
  it('registers a user, hashing the password and never leaking it', async () => {
    const { service, db } = setup();
    db.client.user.findUnique.mockResolvedValue(null);
    db.client.user.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'u1',
        email: data.email,
        name: data.name ?? null,
        role: 'USER',
        createdAt: new Date('2026-07-02T00:00:00Z'),
        ...data,
      }),
    );

    const dto = await service.register({ email: 'a@b.com', password: 'password123', name: 'A' });

    expect(dto).toMatchObject({ id: 'u1', email: 'a@b.com', name: 'A', role: 'USER' });
    expect((dto as Record<string, unknown>).passwordHash).toBeUndefined();

    const firstCall = db.client.user.create.mock.calls[0]?.[0] as {
      data: { passwordHash: string };
    };
    const stored = firstCall.data;
    expect(stored.passwordHash).not.toBe('password123');
    expect(await argon2.verify(stored.passwordHash, 'password123')).toBe(true);
  });

  it('rejects duplicate registration', async () => {
    const { service, db } = setup();
    db.client.user.findUnique.mockResolvedValue({ id: 'x' });
    await expect(service.register({ email: 'a@b.com', password: 'password123' })).rejects.toThrow(
      /already registered/i,
    );
  });

  it('validates correct credentials and rejects wrong ones', async () => {
    const { service, db } = setup();
    const passwordHash = await argon2.hash('secret123');
    db.client.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      role: 'USER',
      passwordHash,
    });

    await expect(service.validateUser('a@b.com', 'secret123')).resolves.toMatchObject({
      id: 'u1',
      role: 'USER',
    });
    await expect(service.validateUser('a@b.com', 'wrong')).rejects.toThrow(/invalid credentials/i);
  });

  it('rotates a valid refresh token', async () => {
    const { service, db } = setup();
    const secret = 'refresh-secret';
    const tokenHash = await argon2.hash(secret);
    db.client.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      tokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.client.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    db.client.refreshToken.create.mockResolvedValue({ id: 'rt2' });
    db.client.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', role: 'USER' });

    const tokens = await service.refresh(`rt1.${secret}`);

    expect(tokens.accessToken).toBe('access-token');
    expect(tokens.refreshToken).toMatch(/^rt2\./);
    expect(db.client.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'rt1', revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });
  });

  it('rejects a refresh token the count guard could not exclusively revoke (TOCTOU)', async () => {
    const { service, db } = setup();
    const secret = 'refresh-secret';
    const tokenHash = await argon2.hash(secret);
    db.client.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      tokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.client.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh(`rt1.${secret}`)).rejects.toThrow(/invalid refresh token/i);
  });

  it('rejects a missing refresh token', async () => {
    const { service } = setup();
    await expect(service.refresh(undefined)).rejects.toThrow(/missing refresh token/i);
  });

  it('rejects an already-revoked refresh token', async () => {
    const { service, db } = setup();
    const secret = 'refresh-secret';
    const tokenHash = await argon2.hash(secret);
    db.client.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      tokenHash,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.refresh(`rt1.${secret}`)).rejects.toThrow(/invalid refresh token/i);
  });

  it('rejects an expired refresh token', async () => {
    const { service, db } = setup();
    const secret = 'refresh-secret';
    const tokenHash = await argon2.hash(secret);
    db.client.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      userId: 'u1',
      tokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.refresh(`rt1.${secret}`)).rejects.toThrow(/invalid refresh token/i);
  });

  it('revokes the refresh token on logout, idempotently', async () => {
    const { service, db } = setup();
    db.client.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await service.logout('rt1.some-secret');
    expect(db.client.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'rt1', revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });

    // A missing cookie is a silent no-op — no throw, no db write.
    db.client.refreshToken.updateMany.mockClear();
    await service.logout(undefined);
    expect(db.client.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns the current user without leaking the hash, and 401s when missing', async () => {
    const { service, db } = setup();
    db.client.user.findUnique.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      role: 'USER',
      createdAt: new Date('2026-07-02T00:00:00Z'),
      passwordHash: 'secret-hash',
    });

    const dto = await service.me('u1');
    expect(dto).toMatchObject({ id: 'u1', email: 'a@b.com', role: 'USER' });
    expect((dto as Record<string, unknown>).passwordHash).toBeUndefined();

    db.client.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.me('missing')).rejects.toThrow(/user not found/i);
  });
});
