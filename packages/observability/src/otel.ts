import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface OtelOptions {
  serviceName: string;
  /** OTLP base endpoint (e.g. OpenObserve). Empty/disabled => OTel is a no-op. */
  otlpEndpoint?: string;
  otlpHeaders?: string;
  disabled?: boolean;
}

let sdk: NodeSDK | undefined;

/** Start OpenTelemetry (traces + metrics over OTLP). No-op when disabled or without an endpoint. */
export function startOtel(options: OtelOptions): void {
  if (options.disabled || !options.otlpEndpoint) return;
  if (sdk) return;

  const headers = parseHeaders(options.otlpHeaders);
  const base = options.otlpEndpoint.replace(/\/$/, '');

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }),
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
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
