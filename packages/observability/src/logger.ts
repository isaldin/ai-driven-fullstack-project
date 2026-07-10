import { trace } from '@opentelemetry/api';
import { type Logger, type LoggerOptions, pino } from 'pino';

export interface LoggerConfig {
  level?: string;
  name?: string;
  /** Pretty-print with pino-pretty. Use in development only. */
  pretty?: boolean;
}

/**
 * Paths Pino replaces with `[REDACTED]` before a line leaves the process. The confirmed leak
 * vector is the automatic request/response access log (`nestjs-pino`), which carries every
 * req/res header — including the bearer `authorization`, the session `cookie`, the bot's
 * `x-service-token`, and the refresh `set-cookie`. Those surface at `LOG_LEVEL=debug`. We also
 * censor common credential field names (top level and one nesting level, via the `*.` wildcard)
 * in case an application log embeds a secret. Nothing is dropped — the line still logs, minus
 * the secret. Extend this list when you add a new secret-bearing field or header.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-service-token"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
];

/**
 * Pino mixin that stamps every line with the active span's ids, so logs correlate with
 * traces. Emitted on stdout (visible in `docker logs`) and — because the OTel Collector's
 * filelog pipeline promotes trace_id/span_id/trace_flags to the log record's trace
 * context on ingest — surfaced as real log↔trace links in the backend UI. Returns nothing
 * when no span is active.
 */
export function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  if (!traceId || !spanId) return {};
  return {
    trace_id: traceId,
    span_id: spanId,
    trace_flags: (traceFlags ?? 0).toString(16).padStart(2, '0'),
  };
}

/** Shared Pino options so backend and bot emit identical log shapes. */
export function createLoggerOptions(config: LoggerConfig = {}): LoggerOptions {
  const { level = 'info', name = 'app', pretty = false } = config;
  return {
    level,
    name,
    mixin: traceContextMixin,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export function createLogger(config?: LoggerConfig): Logger {
  return pino(createLoggerOptions(config));
}

export type { Logger };
