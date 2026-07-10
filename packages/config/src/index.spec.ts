import { describe, expect, it } from 'vitest';
import { loadEnv } from './index.js';

// A complete, VALID production environment. Individual tests clone this and break
// exactly one field, so a failure pinpoints the rule under test. The secrets are
// synthetic and low-entropy (>=32 chars, distinct, no placeholder pattern) so the
// secret scanner doesn't flag them as leaked credentials.
const ACCESS_SECRET = 'ci-jwt-access-secret-aaaaaaaaaaaaaaaa'; // 37
const SERVICE_SECRET = 'ci-service-api-token-bbbbbbbbbbbbbbbb'; // 36, distinct

const validProd = (): Record<string, string> => ({
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'compose',
  DATABASE_URL: 'postgresql://app:db-pass-cccccccccccc@postgres:5432/app',
  JWT_ACCESS_SECRET: ACCESS_SECRET,
  SERVICE_API_TOKEN: SERVICE_SECRET,
  CORS_ORIGIN: 'https://app.acme.io',
  COOKIE_DOMAIN: 'acme.io',
  BACKEND_URL: 'http://backend:3000',
  REDIS_URL: 'redis://:redis-pass-dddddddddddd@redis:6379',
  TELEGRAM_BOT_TOKEN: '8123456789:AA-fake-nonsecret-bot-token-value',
  OTEL_SDK_DISABLED: 'true',
});

// The baseline is already valid; tests clone it and break exactly one field.
const baseline = (): Record<string, string> => validProd();

const expectInvalid = (env: Record<string, string>, field: string): void => {
  let error: Error | undefined;
  try {
    loadEnv(env as unknown as NodeJS.ProcessEnv);
  } catch (e) {
    error = e as Error;
  }
  expect(error, `expected loadEnv to throw for ${field}`).toBeInstanceOf(Error);
  expect(error?.message).toContain(field);
};

describe('loadEnv — baseline', () => {
  it('accepts a fully valid production environment', () => {
    expect(() => loadEnv(baseline() as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('defaults NODE_ENV to development and stays permissive', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/app',
        JWT_ACCESS_SECRET: 'dev-access-secret-0123456789ab',
        SERVICE_API_TOKEN: 'dev-token',
      } as unknown as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('loadEnv — production placeholder rejection', () => {
  const placeholderSecrets: Record<string, string> = {
    'change-me': 'change-me-access-secret-min-32-chars-long',
    'replace-with': 'replace-with-a-real-secret-value-here',
    'min-32-chars marker': 'some-secret-min-32-chars-long-value',
    placeholder: 'placeholder-secret-value-abcdefghij',
    'your- prefix': 'your-secret-goes-here-abcdefghijkl',
  };

  for (const [label, value] of Object.entries(placeholderSecrets)) {
    it(`rejects JWT_ACCESS_SECRET placeholder: ${label}`, () => {
      const env = baseline();
      env.JWT_ACCESS_SECRET = value;
      expectInvalid(env, 'JWT_ACCESS_SECRET');
    });
  }

  it('rejects the shipped JWT placeholder', () => {
    const env = baseline();
    env.JWT_ACCESS_SECRET = 'change-me-access-secret-min-32-chars-long';
    expectInvalid(env, 'JWT_ACCESS_SECRET');
  });

  it('rejects the shipped service-token placeholder', () => {
    const env = baseline();
    env.SERVICE_API_TOKEN = 'change-me-service-token';
    expectInvalid(env, 'SERVICE_API_TOKEN');
  });

  it('rejects a placeholder credential embedded in DATABASE_URL', () => {
    const env = baseline();
    env.DATABASE_URL = 'postgresql://app:change-me@postgres:5432/app';
    expectInvalid(env, 'DATABASE_URL');
  });

  it('rejects the BotFather placeholder token', () => {
    const env = baseline();
    env.TELEGRAM_BOT_TOKEN = '000000:replace-with-botfather-token';
    expectInvalid(env, 'TELEGRAM_BOT_TOKEN');
  });

  it('allows an empty bot token (backend-only service)', () => {
    const env = baseline();
    env.TELEGRAM_BOT_TOKEN = '';
    expect(() => loadEnv(env as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('loadEnv — production weak / duplicate secrets', () => {
  it('rejects a secret shorter than 32 chars', () => {
    const env = baseline();
    env.JWT_ACCESS_SECRET = 'tooShortSecret1234'; // 18
    expectInvalid(env, 'JWT_ACCESS_SECRET');
  });

  it('rejects duplicate secret values across types', () => {
    const env = baseline();
    const shared = 'ci-shared-secret-eeeeeeeeeeeeeeeeeeee';
    env.JWT_ACCESS_SECRET = shared;
    env.SERVICE_API_TOKEN = shared;
    expectInvalid(env, 'SERVICE_API_TOKEN');
  });
});

describe('loadEnv — production origins & cookie domain', () => {
  it('rejects a non-HTTPS CORS origin', () => {
    const env = baseline();
    env.CORS_ORIGIN = 'http://app.acme.io';
    expectInvalid(env, 'CORS_ORIGIN');
  });

  it('rejects a wildcard CORS origin', () => {
    const env = baseline();
    env.CORS_ORIGIN = '*';
    expectInvalid(env, 'CORS_ORIGIN');
  });

  it('rejects example.com in CORS origin', () => {
    const env = baseline();
    env.CORS_ORIGIN = 'https://app.example.com';
    expectInvalid(env, 'CORS_ORIGIN');
  });

  it('rejects localhost cookie domain', () => {
    const env = baseline();
    env.COOKIE_DOMAIN = 'localhost';
    expectInvalid(env, 'COOKIE_DOMAIN');
  });

  it('rejects example.com cookie domain', () => {
    const env = baseline();
    env.COOKIE_DOMAIN = 'example.com';
    expectInvalid(env, 'COOKIE_DOMAIN');
  });
});

describe('loadEnv — URL protocol validation', () => {
  it('rejects a non-postgres DATABASE_URL', () => {
    const env = baseline();
    env.DATABASE_URL = 'mysql://app:pw@db:3306/app';
    expectInvalid(env, 'DATABASE_URL');
  });

  it('rejects a non-redis REDIS_URL', () => {
    const env = baseline();
    env.REDIS_URL = 'http://redis:6379';
    expectInvalid(env, 'REDIS_URL');
  });

  it('rejects a non-http OTLP endpoint', () => {
    const env = baseline();
    env.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector:4318';
    expectInvalid(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});

describe('loadEnv — strict boolean parsing', () => {
  it('rejects a typo in a boolean env instead of silently defaulting to false', () => {
    const env = baseline();
    env.OTEL_SDK_DISABLED = 'flase';
    expectInvalid(env, 'OTEL_SDK_DISABLED');
  });

  it('rejects a non-boolean word', () => {
    const env = baseline();
    env.OTEL_VERBOSE_SPANS = 'yes';
    expectInvalid(env, 'OTEL_VERBOSE_SPANS');
  });

  it('accepts the documented boolean spellings', () => {
    // OTEL_VERBOSE_SPANS has no cross-field coupling, so exercising all spellings
    // here isolates the boolean parser from the OTel-endpoint rule.
    for (const v of ['true', 'false', '1', '0', '']) {
      const env = baseline();
      env.OTEL_VERBOSE_SPANS = v;
      expect(() => loadEnv(env as unknown as NodeJS.ProcessEnv), `value ${v}`).not.toThrow();
    }
  });
});

describe('loadEnv — Compose deployment localhost rejection', () => {
  it('rejects localhost in DATABASE_URL under compose mode', () => {
    const env = baseline();
    env.DATABASE_URL = 'postgresql://app:db-pass-cccccccccccc@localhost:5432/app';
    expectInvalid(env, 'DATABASE_URL');
  });

  it('allows localhost DB in standalone mode (non-compose)', () => {
    const env = baseline();
    env.DEPLOYMENT_MODE = 'standalone';
    env.DATABASE_URL = 'postgresql://app:db-pass-cccccccccccc@localhost:5432/app';
    env.REDIS_URL = 'redis://:redis-pass-dddddddddddd@localhost:6379';
    expect(() => loadEnv(env as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('loadEnv — OTel enablement', () => {
  it('requires an OTLP endpoint when the SDK is enabled', () => {
    const env = baseline();
    env.OTEL_SDK_DISABLED = 'false';
    env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    expectInvalid(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});
