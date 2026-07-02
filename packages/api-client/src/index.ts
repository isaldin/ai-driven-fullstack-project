import type { LoginInput, MessageResponse, Tokens, UserDto } from '@app/contracts';

export interface ApiClientOptions {
  baseUrl: string;
  /** Static machine token for service-to-service calls (e.g. the Telegram bot). */
  serviceToken?: string;
  /** Bearer access token provider for first-party (browser) callers. */
  getAccessToken?: () => string | null | undefined;
  /** Send cookies (refresh token) with requests. Enable in the browser. */
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Minimal typed REST client for the curated backend contract (used by the bot and the frontend). */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.doFetch = options.fetchImpl ?? globalThis.fetch;
  }

  login(input: LoginInput): Promise<Tokens> {
    return this.request<Tokens>('POST', '/auth/login', input);
  }

  register(input: LoginInput & { name?: string }): Promise<UserDto> {
    return this.request<UserDto>('POST', '/auth/register', input);
  }

  me(): Promise<UserDto> {
    return this.request<UserDto>('GET', '/auth/me');
  }

  refresh(): Promise<Tokens> {
    return this.request<Tokens>('POST', '/auth/refresh');
  }

  logout(): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/auth/logout');
  }

  ready(): Promise<unknown> {
    return this.request<unknown>('GET', '/health/ready');
  }

  /** Service-to-service: requires a configured serviceToken. */
  usersCount(): Promise<{ count: number }> {
    return this.request<{ count: number }>('GET', '/users/count');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const bearer = this.options.getAccessToken?.();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (this.options.serviceToken) headers['x-service-token'] = this.options.serviceToken;

    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.options.credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message =
        (data && typeof data === 'object' && 'message' in data && String(data.message)) ||
        `Request failed with status ${res.status}`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }
}
