import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { pino } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLoggerOptions, LOG_REDACT_PATHS, traceContextMixin } from './logger.js';

const TRACE_ID = '1'.repeat(32);
const SPAN_ID = '1'.repeat(16);

// `context.with` only propagates the active context when a context manager is
// registered (NodeSDK installs one in production); wire the async-hooks manager here.
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

describe('traceContextMixin', () => {
  it('returns nothing when no span is active', () => {
    expect(traceContextMixin()).toEqual({});
  });

  it('returns the active span ids', () => {
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    context.with(trace.setSpan(context.active(), span), () => {
      expect(traceContextMixin()).toEqual({
        trace_id: TRACE_ID,
        span_id: SPAN_ID,
        trace_flags: '01',
      });
    });
  });
});

describe('createLoggerOptions', () => {
  it('wires the trace-context mixin', () => {
    expect(createLoggerOptions().mixin).toBe(traceContextMixin);
  });

  it('stamps log lines with trace ids when a span is active', () => {
    const lines: string[] = [];
    const logger = pino(createLoggerOptions({ level: 'info' }), {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    });

    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    context.with(trace.setSpan(context.active(), span), () => {
      logger.info('hello');
    });

    const record = JSON.parse(lines.at(-1) ?? '{}');
    expect(record.trace_id).toBe(TRACE_ID);
    expect(record.span_id).toBe(SPAN_ID);
  });

  it('adds no transport by default (plain stdout JSON)', () => {
    expect(createLoggerOptions().transport).toBeUndefined();
  });

  it('adds a pino-pretty transport only when pretty is set', () => {
    expect((createLoggerOptions({ pretty: true }).transport as { target?: string })?.target).toBe(
      'pino-pretty',
    );
  });

  it('configures redaction with the shared paths and a [REDACTED] censor', () => {
    const redact = createLoggerOptions().redact as { paths: string[]; censor: string };
    expect(redact.paths).toBe(LOG_REDACT_PATHS);
    expect(redact.censor).toBe('[REDACTED]');
  });
});

describe('createLoggerOptions redaction', () => {
  const logAndParse = (obj: Record<string, unknown>): unknown => {
    const lines: string[] = [];
    const logger = pino(createLoggerOptions({ level: 'info' }), {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    });
    logger.info(obj, 'msg');
    return JSON.parse(lines.at(-1) ?? '{}');
  };

  it('censors auth/cookie/service-token request headers and the set-cookie response header', () => {
    const rec = logAndParse({
      req: {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'refresh=abc',
          'x-service-token': 'svc',
        },
      },
      res: { headers: { 'set-cookie': 'refresh=xyz; HttpOnly' } },
    }) as {
      req: { headers: { authorization: string; cookie: string; 'x-service-token': string } };
      res: { headers: { 'set-cookie': string } };
    };
    expect(rec.req.headers.authorization).toBe('[REDACTED]');
    expect(rec.req.headers.cookie).toBe('[REDACTED]');
    expect(rec.req.headers['x-service-token']).toBe('[REDACTED]');
    expect(rec.res.headers['set-cookie']).toBe('[REDACTED]');
  });

  it('censors credential fields at the top level and one nesting level deep', () => {
    const rec = logAndParse({
      password: 'p',
      accessToken: 'a',
      user: { refreshToken: 'r' },
    }) as { password: string; accessToken: string; user: { refreshToken: string } };
    expect(rec.password).toBe('[REDACTED]');
    expect(rec.accessToken).toBe('[REDACTED]');
    expect(rec.user.refreshToken).toBe('[REDACTED]');
  });
});
