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
});
