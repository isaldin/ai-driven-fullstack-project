/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Collector OTLP/HTTP endpoint for browser tracing. Empty/unset ⇒ browser tracing off. */
  readonly VITE_OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** `service.name` for browser spans (default `app-frontend`). */
  readonly VITE_OTEL_SERVICE_NAME?: string;
  /** Sentry DSN for frontend error + Session Replay capture. Empty/unset ⇒ Sentry off. */
  readonly VITE_SENTRY_DSN?: string;
  /** Sentry `environment` (defaults to Vite's `MODE`). */
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  /** Sentry `release` (e.g. a git SHA) for grouping regressions by deploy. */
  readonly VITE_SENTRY_RELEASE?: string;
  /** Share of sessions (0..1) to record a replay for; error sessions are always recorded. */
  readonly VITE_SENTRY_REPLAY_SAMPLE_RATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
