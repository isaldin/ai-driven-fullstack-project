import { type Logger, type LoggerOptions, pino } from 'pino';

export interface LoggerConfig {
  level?: string;
  name?: string;
  /** Pretty-print with pino-pretty. Use in development only. */
  pretty?: boolean;
}

/** Shared Pino options so backend and bot emit identical log shapes. */
export function createLoggerOptions(config: LoggerConfig = {}): LoggerOptions {
  const { level = 'info', name = 'app', pretty = false } = config;
  return {
    level,
    name,
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
