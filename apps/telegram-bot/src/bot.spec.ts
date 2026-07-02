import { type ApiClient, ApiError } from '@app/api-client';
import type { Logger } from '@app/observability';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStatsReply,
  formatHelp,
  formatStats,
  formatStatsError,
  WELCOME_MESSAGE,
} from './bot.js';

/** A logger whose methods are spies, so we can assert on error logging. */
function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

/** A minimal ApiClient exposing only the method under test. */
function fakeApi(usersCount: () => Promise<{ count: number }>): ApiClient {
  return { usersCount } as unknown as ApiClient;
}

describe('formatStats', () => {
  it('renders the user count', () => {
    expect(formatStats(0)).toBe('Registered users: 0');
    expect(formatStats(42)).toBe('Registered users: 42');
  });
});

describe('formatHelp', () => {
  it('lists every command', () => {
    const help = formatHelp();
    expect(help).toContain('/start');
    expect(help).toContain('/stats');
    expect(help).toContain('/help');
  });
});

describe('WELCOME_MESSAGE', () => {
  it('is a non-empty greeting', () => {
    expect(WELCOME_MESSAGE.length).toBeGreaterThan(0);
    expect(WELCOME_MESSAGE).toContain('Welcome');
  });
});

describe('buildStatsReply', () => {
  it('replies with the count on success and does not log an error', async () => {
    const logger = fakeLogger();
    const api = fakeApi(() => Promise.resolve({ count: 7 }));

    const reply = await buildStatsReply(api, logger);

    expect(reply).toBe('Registered users: 7');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('replies with a friendly message and logs when the backend returns an ApiError', async () => {
    const logger = fakeLogger();
    const api = fakeApi(() => Promise.reject(new ApiError(503, 'service unavailable')));

    const reply = await buildStatsReply(api, logger);

    expect(reply).toBe(formatStatsError());
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, message: 'service unavailable' }),
      expect.any(String),
    );
  });

  it('replies with a friendly message and logs on an unexpected (non-Api) error', async () => {
    const logger = fakeLogger();
    const api = fakeApi(() => Promise.reject(new Error('network down')));

    const reply = await buildStatsReply(api, logger);

    expect(reply).toBe(formatStatsError());
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
