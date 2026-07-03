import { ApiClient, ApiError } from '@app/api-client';

/**
 * Module-level access-token holder. The auth store registers a getter that reads
 * its in-memory access token. Keeping the holder here (instead of importing the
 * store into this module) avoids a circular import between the store and the client.
 */
let accessTokenGetter: () => string | null | undefined = () => null;

export function setAccessTokenGetter(getter: () => string | null | undefined): void {
  accessTokenGetter = getter;
}

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export const api = new ApiClient({
  baseUrl,
  credentials: 'include',
  getAccessToken: () => accessTokenGetter(),
});

/**
 * Map any error the client can throw to a user-facing message. The client
 * normalizes transport failures to `ApiError` (status 0 = network, 408 = timeout),
 * so this covers those distinctly and passes through backend messages otherwise.
 */
export function describeError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Network error — check your connection and try again.';
    if (error.status === 408) return 'The request timed out. Please try again.';
    return error.message;
  }
  return fallback;
}
