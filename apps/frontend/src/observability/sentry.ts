// Frontend error + Session Replay capture (Sentry), correlated with the OpenTelemetry trace.
//
// Deliberately NOT a second tracer. OpenTelemetry (`observability/tracing.ts`) owns fetch spans
// and W3C trace propagation, so the end-to-end frontend→backend trace stays single-sourced. Sentry
// here is errors + Session Replay + Web Vitals only: no `browserTracingIntegration` and
// `tracesSampleRate: 0`, so it never creates competing spans or injects rival trace headers.
//
// The bridge that makes the trace "good for inspecting errors": `beforeSend` stamps the *active
// OTel trace_id/span_id* onto each Sentry event when a span is active (e.g. an error thrown during
// an instrumented API call). Copy that trace_id from the Sentry issue into the Traces view
// (OpenObserve/Tempo) to see the whole click → API → DB waterfall with the recorded exception.
// Errors with no active span (a pure render/UI error, nothing distributed happened) simply carry
// no trace_id — that is expected.
//
// No-op unless VITE_SENTRY_DSN is set, mirroring the opt-in model of the rest of observability.
import { trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/vue';
import type { App } from 'vue';

export function initSentry(app: App): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return; // opt-in: no DSN ⇒ Sentry stays off

  Sentry.init({
    app,
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    // Errors + Session Replay only. Omitting browserTracingIntegration and pinning
    // tracesSampleRate to 0 keeps OpenTelemetry the single distributed tracer.
    tracesSampleRate: 0,
    integrations: [
      // Replay masks all text and blocks media by default, so no page content or PII leaves
      // the browser — only the DOM structure needed to replay the session.
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    // Record a replay for a share of sessions (0 by default), but always when an error occurs.
    replaysSessionSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAY_SAMPLE_RATE ?? 0),
    replaysOnErrorSampleRate: 1.0,
    // Correlate a Sentry event with the OTel trace when a span is active at capture time.
    beforeSend(event) {
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (spanContext?.traceId) {
        event.tags = { ...event.tags, trace_id: spanContext.traceId, span_id: spanContext.spanId };
      }
      return event;
    },
  });
}
