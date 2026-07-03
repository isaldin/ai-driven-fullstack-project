import { trace } from '@opentelemetry/api';
import { type Logger, type LoggerOptions, pino } from 'pino';

export interface LoggerConfig {
  level?: string;
  name?: string;
  /** Pretty-print with pino-pretty. Use in development only. */
  pretty?: boolean;
}

/**
 * Pino mixin that stamps every line with the active span's ids, so logs join up
 * with traces in the backend. Returns nothing when no span is active.
 */
export function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  if (!traceId || !spanId) return {};
  return { trace_id: traceId, span_id: spanId };
}

/** Shared Pino options so backend and bot emit identical log shapes. */
export function createLoggerOptions(config: LoggerConfig = {}): LoggerOptions {
  const { level = 'info', name = 'app', pretty = false } = config;
  return {
    level,
    name,
    mixin: traceContextMixin,
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
