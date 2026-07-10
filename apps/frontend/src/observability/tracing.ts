// Browser (RUM) tracing.
//
// Imported for its SIDE EFFECT as the very first line of main.ts: ES module imports are
// evaluated in source order, so this patches window.fetch before `@app/api-client` binds it
// (lib/api.ts captures `globalThis.fetch` at module load). Get the order wrong and the client
// keeps a reference to the un-instrumented fetch, so no browser span and no `traceparent`.
//
// Off unless VITE_OTEL_EXPORTER_OTLP_ENDPOINT is set, mirroring the backend's opt-in model.
// When on, fetch calls to the API get a client span AND a W3C `traceparent` header, so the
// backend server span becomes a child of the browser span — one end-to-end trace spanning
// app-frontend and app-backend.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StackContextManager, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function startWebTracing(): void {
  const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
  if (!endpoint) return; // opt-in: no endpoint ⇒ browser tracing stays off

  const apiBase = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: import.meta.env.VITE_OTEL_SERVICE_NAME || 'app-frontend',
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
  });
  provider.register({ contextManager: new StackContextManager() });

  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        // fetch instrumentation skips trace propagation on cross-origin (CORS) calls unless
        // the URL is allow-listed here — the frontend (5173) and API (3000) are different
        // origins, so without this the backend never receives the `traceparent`.
        propagateTraceHeaderCorsUrls: [new RegExp(escapeRegExp(apiBase))],
        // Never instrument the exporter's own POSTs to the collector (would feed back on itself).
        ignoreUrls: [new RegExp(escapeRegExp(endpoint))],
      }),
    ],
  });
}

startWebTracing();
