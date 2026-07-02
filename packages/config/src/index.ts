import { z } from 'zod';

/** Parses a boolean from an env string without the `z.coerce.boolean` "false"→true footgun. */
const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database (ZenStack v3 / pg)
  DATABASE_URL: z.string().min(1),

  // Auth
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),

  // Backend HTTP
  BACKEND_PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().default('localhost'),

  // Service-to-service (Telegram bot -> backend)
  SERVICE_API_TOKEN: z.string().min(8),

  // Telegram bot
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  BACKEND_URL: z.string().min(1).default('http://localhost:3000'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Observability
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OTEL_SERVICE_NAME: z.string().default('app'),
  OTEL_SDK_DISABLED: envBool(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().default(''),
  METRICS_EXPORTER: z.enum(['otlp', 'prometheus']).default('otlp'),
  SENTRY_DSN: z.string().default(''),
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
