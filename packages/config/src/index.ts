import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Environment contract (Zod). Two layers:
//   1. Field-level structural rules that hold in EVERY environment (types,
//      URL protocols) — a malformed DATABASE_URL is wrong in dev too.
//   2. A production superRefine (NODE_ENV=production only) that fails fast on
//      template placeholders, weak/duplicated secrets, non-HTTPS public origins
//      and localhost in a Compose deployment. These never fire in dev/test so
//      `pnpm dev` and the e2e suites stay friction-free.
// ─────────────────────────────────────────────────────────────

/**
 * Strict boolean env parser. Only '', 'true', 'false', '1', '0' (or unset) are
 * accepted; anything else (e.g. the typo `flase`, or `yes`) is a validation
 * error instead of silently collapsing to `false`.
 */
const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .refine((v) => v === undefined || ['', 'true', 'false', '1', '0'].includes(v), {
      message: "must be one of 'true', 'false', '1', '0' (or empty)",
    })
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

/** Returns true if `v` parses as a URL whose protocol is in `protocols`. */
const hasProtocol = (v: string, protocols: string[]): boolean => {
  try {
    return protocols.includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** Splits a comma-separated origin list into trimmed, non-empty entries. */
const parseOrigins = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const isLocalhost = (v: string): boolean => /localhost|127\.0\.0\.1|::1|\[::1\]/i.test(v);

/**
 * Substrings that mark a value as a template placeholder / known default rather
 * than a real secret. Applied to secret-bearing fields in production only. We do
 * NOT attempt to grade password strength with a regex (per the P0 plan); this is
 * strictly a banlist of the values this template ships with.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /change[-_ ]?me/i,
  /replace[-_ ]?(with|me)/i,
  /placeholder/i,
  /^your[-_]/i,
  /secret-min-32/i,
  /min-32-chars/i,
  /replace-with-botfather/i,
  /^0{6}:/, // telegram token placeholder prefix "000000:"
  /^admin12345$/i,
  /changeme123/i,
];

const looksLikePlaceholder = (v: string): boolean => PLACEHOLDER_PATTERNS.some((re) => re.test(v));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Explicit deployment shape. `compose` (set by the Ansible deploy) means the
    // app talks to sibling containers by service name, so localhost anywhere is a
    // misconfiguration and is rejected in production.
    DEPLOYMENT_MODE: z.enum(['standalone', 'compose']).default('standalone'),

    // Database (ZenStack v3 / pg)
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((v) => hasProtocol(v, ['postgres:', 'postgresql:']), {
        message: 'must be a postgres:// or postgresql:// URL',
      }),

    // Auth. Base floor is 16 chars for dev ergonomics; production requires 32+
    // (see superRefine). Refresh tokens are opaque random strings hashed in the
    // DB (see AuthService.issueTokens) — there is deliberately no refresh SIGNING
    // secret, so JWT_REFRESH_SECRET does not exist.
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),

    // Backend HTTP
    BACKEND_PORT: z.coerce.number().int().positive().default(3000),
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:5173')
      .refine(
        (v) => parseOrigins(v).every((o) => o === '*' || hasProtocol(o, ['http:', 'https:'])),
        { message: 'must be a comma-separated list of http(s) origins (or *)' },
      ),
    COOKIE_DOMAIN: z.string().default('localhost'),

    // Service-to-service (Telegram bot -> backend)
    SERVICE_API_TOKEN: z.string().min(8),

    // Telegram bot
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    BACKEND_URL: z
      .string()
      .min(1)
      .default('http://localhost:3000')
      .refine((v) => hasProtocol(v, ['http:', 'https:']), {
        message: 'must be an http(s) URL',
      }),

    // Redis
    REDIS_URL: z
      .string()
      .default('redis://localhost:6379')
      .refine((v) => hasProtocol(v, ['redis:', 'rediss:']), {
        message: 'must be a redis:// or rediss:// URL',
      }),

    // Observability
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OTEL_SERVICE_NAME: z.string().default('app'),
    SERVICE_VERSION: z.string().default('0.0.0'),
    OTEL_SDK_DISABLED: envBool(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .default('')
      .refine((v) => v === '' || hasProtocol(v, ['http:', 'https:']), {
        message: 'must be an http(s) URL when set',
      }),
    OTEL_EXPORTER_OTLP_HEADERS: z.string().default(''),
    METRICS_EXPORTER: z.enum(['otlp', 'prometheus']).default('otlp'),
    // Verbose per-middleware Express spans turn one request into ~20 spans. Off by default
    // (traces show the HTTP server span + route handler); flip to inspect middleware timing.
    OTEL_VERBOSE_SPANS: envBool(false),
    SENTRY_DSN: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };

    // --- Secrets: entropy floor + no placeholders -------------------------
    const secrets = {
      JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
      SERVICE_API_TOKEN: env.SERVICE_API_TOKEN,
    } as const;
    for (const [key, value] of Object.entries(secrets)) {
      if (value.length < 32) {
        fail(
          key,
          'production secret must be at least 32 chars (generate 32+ random bytes via CSPRNG)',
        );
      }
      if (looksLikePlaceholder(value)) {
        fail(key, 'looks like a template placeholder / known default — provide a real secret');
      }
    }

    // Distinct secret types must never share a value.
    if (env.JWT_ACCESS_SECRET === env.SERVICE_API_TOKEN) {
      fail('SERVICE_API_TOKEN', 'must differ from JWT_ACCESS_SECRET (distinct secret types)');
    }

    // Embedded credentials in connection strings must not be placeholders.
    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      if (looksLikePlaceholder(env[key])) {
        fail(key, 'contains a template placeholder credential');
      }
    }

    // The bot token is optional for services that don't run the bot, but a
    // present value must not be the BotFather placeholder.
    if (env.TELEGRAM_BOT_TOKEN && looksLikePlaceholder(env.TELEGRAM_BOT_TOKEN)) {
      fail(
        'TELEGRAM_BOT_TOKEN',
        'looks like the placeholder token — set a real BotFather token or leave empty',
      );
    }

    // --- Public origins: HTTPS, no wildcard-with-credentials, no example.com --
    for (const origin of parseOrigins(env.CORS_ORIGIN)) {
      if (origin === '*') {
        fail('CORS_ORIGIN', 'wildcard origin is unsafe with credentials in production');
      } else if (!hasProtocol(origin, ['https:'])) {
        fail('CORS_ORIGIN', `origin "${origin}" must use https in production`);
      }
    }
    if (/example\.com/i.test(env.CORS_ORIGIN)) {
      fail('CORS_ORIGIN', 'example.com is a template placeholder — set your real domain');
    }

    // --- Cookie domain: a bare domain, not localhost / a URL / example.com ---
    if (isLocalhost(env.COOKIE_DOMAIN)) {
      fail('COOKIE_DOMAIN', 'must be your production domain, not localhost');
    }
    if (env.COOKIE_DOMAIN.includes('://') || env.COOKIE_DOMAIN.includes('/')) {
      fail('COOKIE_DOMAIN', 'must be a bare domain (no scheme or path)');
    }
    if (/example\.com$/i.test(env.COOKIE_DOMAIN)) {
      fail('COOKIE_DOMAIN', 'example.com is a template placeholder — set your real domain');
    }

    // --- Compose deployment: localhost is a misconfiguration -----------------
    if (env.DEPLOYMENT_MODE === 'compose') {
      for (const key of ['DATABASE_URL', 'REDIS_URL', 'CORS_ORIGIN', 'COOKIE_DOMAIN'] as const) {
        if (isLocalhost(env[key])) {
          fail(
            key,
            'localhost is invalid in a Compose deployment — use the in-network service name / real domain',
          );
        }
      }
    }

    // --- OTel: if enabled, an endpoint is required ---------------------------
    if (!env.OTEL_SDK_DISABLED && env.OTEL_EXPORTER_OTLP_ENDPOINT === '') {
      fail('OTEL_EXPORTER_OTLP_ENDPOINT', 'OTel SDK is enabled but no OTLP endpoint is configured');
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Validate an environment object, throwing a readable error on failure (fail fast). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
