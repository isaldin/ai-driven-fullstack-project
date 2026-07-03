import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { pino } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLoggerOptions, traceContextMixin } from './logger.js';

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
      expect(traceContextMixin()).toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID });
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
});
