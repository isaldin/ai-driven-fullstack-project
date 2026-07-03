import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInstrumentations,
  buildMetricReader,
  buildResource,
  buildSdk,
  isOtelStarted,
  startOtel,
  stopOtel,
} from './otel.js';

describe('buildResource', () => {
  it('sets service + deployment identity attributes when provided', () => {
    const attrs = buildResource({
      serviceName: 'svc',
      serviceVersion: '1.2.3',
      environment: 'production',
    }).attributes;
    expect(attrs[ATTR_SERVICE_NAME]).toBe('svc');
    expect(attrs[ATTR_SERVICE_VERSION]).toBe('1.2.3');
    expect(attrs['deployment.environment.name']).toBe('production');
  });

  it('omits version/environment attributes when not provided', () => {
    const attrs = buildResource({ serviceName: 'svc' }).attributes;
    expect(attrs[ATTR_SERVICE_NAME]).toBe('svc');
    expect(attrs[ATTR_SERVICE_VERSION]).toBeUndefined();
    expect(attrs['deployment.environment.name']).toBeUndefined();
  });
});

describe('buildInstrumentations', () => {
  it('returns a non-empty instrumentation set', () => {
    expect(buildInstrumentations().length).toBeGreaterThan(0);
  });
});

describe('startOtel guards', () => {
  afterEach(async () => {
    await stopOtel();
  });

  it('is a no-op when disabled', () => {
    startOtel({ serviceName: 'svc', otlpEndpoint: 'http://127.0.0.1:4318', disabled: true });
    expect(isOtelStarted()).toBe(false);
  });

  it('is a no-op without an OTLP endpoint', () => {
    startOtel({ serviceName: 'svc', otlpEndpoint: '' });
    expect(isOtelStarted()).toBe(false);
  });
});

describe('buildMetricReader (prometheus)', () => {
  it('serves a /metrics pull endpoint returning 200', async () => {
    const port = 9466;
    const reader = buildMetricReader({
      serviceName: 'svc',
      metricsExporter: 'prometheus',
      prometheusPort: port,
    });
    try {
      // The exporter starts its HTTP server asynchronously — poll until it answers.
      let res: Response | undefined;
      for (let i = 0; i < 40; i++) {
        try {
          res = await fetch(`http://127.0.0.1:${port}/metrics`);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      expect(res?.status).toBe(200);
    } finally {
      await reader.shutdown();
    }
  });
});

describe('buildSdk (lifecycle)', () => {
  it('starts and shuts down cleanly with injected in-memory exporters', async () => {
    const metricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    const sdk = buildSdk(
      { serviceName: 'svc', serviceVersion: '1.0.0', environment: 'test' },
      { traceExporter: new InMemorySpanExporter(), metricReader },
    );

    expect(() => sdk.start()).not.toThrow();
    await expect(sdk.shutdown()).resolves.toBeUndefined();
  });
});
