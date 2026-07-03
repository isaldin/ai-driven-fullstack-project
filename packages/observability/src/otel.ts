import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { type MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// semconv `deployment.environment.name` lives in the incubating entrypoint; referenced by
// literal so we don't depend on the unstable `/incubating` import path.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

/** Port the Prometheus pull endpoint (`/metrics`) binds when METRICS_EXPORTER=prometheus. */
export const DEFAULT_PROMETHEUS_PORT = 9464;

export interface OtelOptions {
  serviceName: string;
  /** `service.version` resource attribute — correlates telemetry with a release. */
  serviceVersion?: string;
  /** `deployment.environment.name` resource attribute (e.g. NODE_ENV). */
  environment?: string;
  /** OTLP base endpoint (e.g. OpenObserve). Empty/disabled => OTel is a no-op. */
  otlpEndpoint?: string;
  otlpHeaders?: string;
  /** 'otlp' pushes metrics over OTLP; 'prometheus' serves a pull `/metrics` endpoint. */
  metricsExporter?: 'otlp' | 'prometheus';
  prometheusPort?: number;
  disabled?: boolean;
}

/** Test seam: inject in-memory exporters to assert emission without a real collector. */
export interface SdkExporterOverrides {
  traceExporter?: SpanExporter;
  metricReader?: MetricReader;
}

let sdk: NodeSDK | undefined;

/** Build the OTel resource with service + deployment identity attributes. */
export function buildResource(options: OtelOptions): Resource {
  const attrs: Record<string, string> = { [ATTR_SERVICE_NAME]: options.serviceName };
  if (options.serviceVersion) attrs[ATTR_SERVICE_VERSION] = options.serviceVersion;
  if (options.environment) attrs[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = options.environment;
  return resourceFromAttributes(attrs);
}

/** Auto-instrumentations tuned for a web service: no noisy fs spans, health probes ignored. */
export function buildInstrumentations(): Instrumentation[] {
  return getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (req) => (req.url ?? '').startsWith('/health'),
    },
  });
}

/** Choose the metric reader from METRICS_EXPORTER: OTLP push (default) or Prometheus pull. */
export function buildMetricReader(
  options: OtelOptions,
  base?: string,
  headers?: Record<string, string>,
): MetricReader {
  if (options.metricsExporter === 'prometheus') {
    return new PrometheusExporter({ port: options.prometheusPort ?? DEFAULT_PROMETHEUS_PORT });
  }
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }),
    exportIntervalMillis: 15_000,
  });
}

/** Construct (but do not start) the NodeSDK. Exporters are injectable for tests. */
export function buildSdk(options: OtelOptions, overrides: SdkExporterOverrides = {}): NodeSDK {
  const headers = parseHeaders(options.otlpHeaders);
  const base = options.otlpEndpoint?.replace(/\/$/, '');
  const traceExporter =
    overrides.traceExporter ??
    (base ? new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }) : undefined);
  const metricReader = overrides.metricReader ?? buildMetricReader(options, base, headers);
  return new NodeSDK({
    resource: buildResource(options),
    ...(traceExporter ? { traceExporter } : {}),
    metricReader,
    instrumentations: [buildInstrumentations()],
  });
}

/** Start OpenTelemetry (traces + metrics). No-op when disabled or without an endpoint. */
export function startOtel(options: OtelOptions): void {
  if (options.disabled || !options.otlpEndpoint) return;
  if (sdk) return;
  sdk = buildSdk(options);
  sdk.start();
}

/** True when the global SDK singleton is running (test/introspection helper). */
export function isOtelStarted(): boolean {
  return sdk !== undefined;
}

export async function stopOtel(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

function parseHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return Object.keys(out).length ? out : undefined;
}
