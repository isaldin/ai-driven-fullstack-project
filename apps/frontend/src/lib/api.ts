import { ApiClient } from '@app/api-client';

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
