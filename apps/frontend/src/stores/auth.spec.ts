import { ApiError } from '@app/api-client';
import type { UserDto } from '@app/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', async (importOriginal) => ({
  // Keep the real `describeError` (the store maps errors through it), stub the client.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: {
    login: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  },
  setAccessTokenGetter: vi.fn(),
}));

import { api } from '../lib/api';
import { useAuthStore } from './auth';

const mockedApi = vi.mocked(api);

const fakeUser: UserDto = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'USER',
  createdAt: '2024-01-01T00:00:00.000Z',
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('useAuthStore', () => {
  it('login sets the access token and user and marks the session authenticated', async () => {
    mockedApi.login.mockResolvedValue({ accessToken: 'access-token-1' });
    mockedApi.me.mockResolvedValue(fakeUser);

    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(false);

    await auth.login('user@example.com', 'secret');

    expect(mockedApi.login).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'secret',
    });
    expect(mockedApi.me).toHaveBeenCalledTimes(1);
    expect(auth.accessToken).toBe('access-token-1');
    expect(auth.user).toEqual(fakeUser);
    expect(auth.isAuthenticated).toBe(true);
  });

  it('logout calls the API and clears the session state', async () => {
    mockedApi.login.mockResolvedValue({ accessToken: 'access-token-1' });
    mockedApi.me.mockResolvedValue(fakeUser);
    mockedApi.logout.mockResolvedValue({ message: 'logged out' });

    const auth = useAuthStore();
    await auth.login('user@example.com', 'secret');
    expect(auth.isAuthenticated).toBe(true);

    await auth.logout();

    expect(mockedApi.logout).toHaveBeenCalledTimes(1);
    expect(auth.accessToken).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('tryRefresh restores the session when the refresh cookie is valid', async () => {
    mockedApi.refresh.mockResolvedValue({ accessToken: 'refreshed-token' });
    mockedApi.me.mockResolvedValue(fakeUser);

    const auth = useAuthStore();
    const restored = await auth.tryRefresh();

    expect(restored).toBe(true);
    expect(auth.accessToken).toBe('refreshed-token');
    expect(auth.user).toEqual(fakeUser);
    expect(auth.isAuthenticated).toBe(true);
  });

  it('tryRefresh returns false and stays logged out when refresh fails', async () => {
    mockedApi.refresh.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const auth = useAuthStore();
    const restored = await auth.tryRefresh();

    expect(restored).toBe(false);
    expect(mockedApi.me).not.toHaveBeenCalled();
    expect(auth.accessToken).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('reload populates the user and toggles the loading flag', async () => {
    mockedApi.me.mockResolvedValue(fakeUser);

    const auth = useAuthStore();
    const pending = auth.reload();
    expect(auth.loading).toBe(true);

    await pending;

    expect(auth.user).toEqual(fakeUser);
    expect(auth.loading).toBe(false);
    expect(auth.error).toBeNull();
  });

  it('reload surfaces an error message without throwing when the fetch fails', async () => {
    mockedApi.me.mockRejectedValue(new ApiError(500, 'Server exploded'));

    const auth = useAuthStore();
    await expect(auth.reload()).resolves.toBeUndefined();

    expect(auth.error).toBe('Server exploded');
    expect(auth.loading).toBe(false);
  });

  it('reload maps a network failure to a friendly message', async () => {
    mockedApi.me.mockRejectedValue(
      new ApiError(0, 'Network request failed. Please check your connection.'),
    );

    const auth = useAuthStore();
    await auth.reload();

    expect(auth.error).toMatch(/network/i);
  });
});
