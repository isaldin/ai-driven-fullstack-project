# Observability

How logs, health, traces, and metrics are wired — what runs out of the box, what is opt-in, how to
turn it on, how to read it in OpenObserve, and how log↔trace correlation is achieved.

Shared code lives in [`packages/observability`](../packages/observability) (`@app/observability`): a
Pino logger (`src/logger.ts`) and the backend/bot OpenTelemetry SDK setup (`src/otel.ts`). The backend
(`apps/backend/src/main.ts`) and the Telegram bot (`apps/telegram-bot/src/index.ts`) use it. The
frontend has its own browser tracing (`apps/frontend/src/observability/tracing.ts`) and opt-in error
tracking (`apps/frontend/src/observability/sentry.ts`).

## Architecture

For the OTLP signals (traces/metrics/logs) the app never talks to storage directly: an **OpenTelemetry
Collector** is the single egress — it receives traces/metrics over OTLP, tails container stdout for
logs, and forwards all three to **OpenObserve**. The app holds no OpenObserve credentials — the
collector does. Frontend **errors + Session Replay** are the one exception: the browser sends those
straight to **Sentry** (a separate, opt-in path), because Sentry is not an OTLP sink.

```
 browser (opt-in) ── OTLP :4318 (fetch spans) ─────────────►┐
      │  + W3C traceparent header on API calls               │
      │                                                       │
      ├── errors + Session Replay (opt-in) ───────────────────────────────────────► Sentry
      ▼                                                       │
 backend / bot ── OTLP :4318 (traces, metrics) ─────────────►├─ otel-collector ── OTLP/HTTP ─► OpenObserve
      │                                                       │   (parses stdout logs, promotes    (UI + API
      └── JSON logs to stdout ─────────────────────────────► ┘    trace_id/span_id to trace          :5080)
              (Docker json-file logs)                              context, forwards all signals)
```

Because the browser injects a `traceparent` header on its API calls, the backend span becomes a **child**
of the browser span — one end-to-end trace from the click to the DB query (verified). A 5xx along the way
is recorded on its span (§3), and a Sentry error carries that trace's `trace_id` (§4b), so the trace is
the hub for inspecting failures across all three services.

Why a collector (not a direct pino→OTLP log exporter): the app writes `trace_id`/`span_id` onto every
log line (see correlation below), but that only becomes a real log↔trace link if it lands on the OTLP
log record's *trace context*. The collector's filelog pipeline does that promotion reliably from the
stdout the app already produces — no in-process log exporter, no import-order fragility.

## The on/off model

Logging and health run always; everything that leaves the process is opt-in, so a fresh clone needs no
extra container and emits nothing into the void.

| Signal | State out of the box | Turned on by |
| --- | --- | --- |
| **Structured logs** (Pino → stdout) | ✅ always emitted | nothing |
| **Health checks** (`/health/*`) | ✅ always served | nothing |
| **Backend/bot traces + metrics** (OTel → collector) | ⚪ dark (SDK loads, exports nothing) | `OTEL_SDK_DISABLED=false` **and** a non-empty `OTEL_EXPORTER_OTLP_ENDPOINT` |
| **Browser traces** (frontend → collector) | ⚪ off | a non-empty `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` at build/dev time |
| **Frontend errors + Replay** (Sentry) | ⚪ off | a non-empty `VITE_SENTRY_DSN` at build/dev time (see §4) |
| **Collector + OpenObserve** (log shipping, correlation, UI) | ⚪ not started | the `observability` Compose profile |
| **Verbose spans / request logs** | ⚪ suppressed (see §7) | `OTEL_VERBOSE_SPANS=true` / `LOG_LEVEL=debug` |

## 1. Logs (Pino → stdout)

- Backend uses `nestjs-pino`; the bot uses `createLogger`. Both go through the shared
  `createLoggerOptions`, so log shapes are identical.
- **JSON on stdout by default.** Pretty-printing (`pino-pretty`) is enabled **only when
  `NODE_ENV=development`** — containers (`NODE_ENV=production`) emit JSON, which is what the collector
  parses. The collector drops non-JSON lines, so host `pnpm dev` pretty logs are not shipped (expected).
- Level is `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`, default `info`).
- **Two kinds of lines share the stream:** *application* logs you emit in code (e.g. the
  `login succeeded` line in `AuthService`) and *request access logs* that `nestjs-pino` writes
  automatically per HTTP request. The access logs are demoted to `debug` (see §7), so at the default
  `info` level you mostly see application logs — clean signal.
- **Trace correlation:** `traceContextMixin` stamps every line with `trace_id`/`span_id`/`trace_flags`
  whenever a span is active. Visible in `docker logs`, and promoted to real trace context by the
  collector (see §6).
- **Secret redaction.** `createLoggerOptions` sets a Pino `redact` list (`LOG_REDACT_PATHS` in
  `logger.ts`) that replaces secrets with `[REDACTED]` before a line is written. The real leak vector
  is the automatic request/response access log, which carries **every** req/res header — so the
  bearer `authorization`, the session `cookie`, the bot's `x-service-token`, and the refresh
  `set-cookie` are censored, along with `password`/`accessToken`/`refreshToken` field names (top level
  and one nesting level). This matters because `LOG_LEVEL=debug` turns those header-bearing access logs
  on (§7). Add a path when you introduce a new secret-bearing field or header; see also the
  never-collect list in §11.

## 2. Health checks — always on

`apps/backend/src/health/` exposes two **public** endpoints via `@nestjs/terminus`:

| Endpoint | Checks | Use |
| --- | --- | --- |
| `GET /health/live` | none — "process is up" | liveness; safe before the DB exists |
| `GET /health/ready` | pings Postgres | readiness; 200 only when the DB is reachable |

The backend container's Compose healthcheck hits `/health/ready`; frontend Playwright e2e gates on
`/health/live` (the e2e DB only exists after its globalSetup runs). `/health*` requests are excluded
from tracing, so health probes never clutter the traces.

## 3. Backend/bot traces + metrics (OpenTelemetry) — opt-in

`startOtel(...)` runs at boot in both services but is a **no-op unless both** hold (guard in
`otel.ts`): `OTEL_SDK_DISABLED=false` **and** a non-empty `OTEL_EXPORTER_OTLP_ENDPOINT`. When active:

- **Auto-instrumentation** (`@opentelemetry/auto-instrumentations-node`) — HTTP server/client spans,
  Node runtime + V8 metrics. `fs` is disabled, `/health*` requests are ignored, the Pino
  instrumentation is disabled (we correlate via the mixin), and the per-middleware/route-layer
  instrumentations (`express`, `router`, `connect`) are **off by default** (see §7).
- **Resource attributes:** `service.name` (`OTEL_SERVICE_NAME`), `service.version` (`SERVICE_VERSION`),
  `deployment.environment.name` (`NODE_ENV`).
- **Traces:** OTLP → `<endpoint>/v1/traces`. **Metrics:** OTLP push every 15s → `<endpoint>/v1/metrics`.
  With `METRICS_EXPORTER=prometheus` the app instead serves a pull `/metrics` endpoint on `:9464`
  (bypasses the collector — for a Prometheus backend).
- **Exceptions on the span.** A global interceptor (`observability/otel-exception.interceptor.ts`,
  wired in `AppModule`) records any **5xx** thrown by a handler/service onto the active request span
  — an exception event with type/message/stack, plus an `ERROR` span status — then rethrows so Nest's
  response is unchanged. That's what makes a failing trace *inspectable* (§9), not just red. 4xx like a
  401 are expected responses and are left as OK on purpose. It's a no-op when OTel is off (no active
  span), so it's always safe.
- **A dropped DB connection surfaces as a 5xx, it does not crash the API.** `DatabaseService`
  attaches an `error` listener to the pg pool; an idle-client error (Postgres restarts, network blip)
  is logged (`context=DatabaseService`, error level) and the pool reconnects on the next query. Without
  that listener node-postgres rethrows the idle-client error and Node exits — a transient blip would
  crash-loop the process. In-flight queries during the outage reject as 5xx and are recorded on their
  span by the interceptor above, so the outage is visible in the trace.

`<endpoint>` is the collector (`http://otel-collector:4318` in Compose).

## 4. Frontend (browser): tracing + errors — opt-in

The frontend has two independent, opt-in signals: **OpenTelemetry** owns the distributed *trace*
(this subsection), and **Sentry** owns *error tracking + Session Replay* (§4b). They are deliberately
split so there is exactly one distributed tracer — Sentry never patches fetch for tracing.

### Browser tracing (OpenTelemetry)

`apps/frontend/src/observability/tracing.ts` sets up a `WebTracerProvider` with the OTLP/HTTP exporter
and `@opentelemetry/instrumentation-fetch`. It's a **no-op unless `VITE_OTEL_EXPORTER_OTLP_ENDPOINT`
is set** (mirroring the backend's opt-in model). When on:

- Every `fetch` to the API gets a browser span **and** a W3C `traceparent` header. The backend
  continues that trace instead of starting a fresh root, so a click → API call → DB query is one trace
  spanning `app-frontend` and `app-backend`. (Verified: the backend server span is `ChildOf` the
  browser fetch span, same `trace_id`.)
- **Two things it needs, both handled here:**
  - **CORS for the trace header.** The frontend and API are different origins (5173 vs 3000), and
    `instrumentation-fetch` only propagates `traceparent` on cross-origin calls whose URL is
    allow-listed (`propagateTraceHeaderCorsUrls` → `VITE_API_URL`). The backend's CORS must allow the
    `traceparent` request header — NestJS `enableCors` reflects requested headers, so it does.
  - **CORS on the collector.** The browser posts OTLP straight to the collector; the collector's OTLP
    receiver allow-lists the dev origin (`otel-collector-config.yaml` → `cors.allowed_origins`).
- **Init ordering matters.** `tracing.ts` is imported as the **first line of `main.ts`** so it patches
  `window.fetch` before `@app/api-client` binds `globalThis.fetch` (which it does at module load). Wrong
  order ⇒ the client holds the un-instrumented fetch ⇒ no browser span, no `traceparent`.
- **Cost:** the OTel web packages add ~weight to the bundle even when tracing is off (the import is
  static so it ships regardless). Acceptable for a template; wrap the import in a dynamic
  `import()` gated on the env var if you need to keep it out of the default bundle.

> Browser tracing is RUM-adjacent but intentionally minimal — just fetch spans + propagation. It is **not**
> enabled by the Compose profile; set `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` (the collector's
> browser-reachable port, e.g. `http://localhost:4318`) for `pnpm dev` or a rebuilt frontend image.

### 4b. Frontend errors — Sentry (opt-in)

Browser OTel gives you the *trace* (where in click → API → DB the time or the failure is), but not
JS exceptions with source-mapped stacks, Session Replay, or Web Vitals. `@sentry/vue`
(`apps/frontend/src/observability/sentry.ts`, `initSentry(app)` in `main.ts`) adds those. **No-op
unless `VITE_SENTRY_DSN` is set.** When on:

- **Errors + Session Replay + Web Vitals only — not a second tracer.** It's initialised with no
  `browserTracingIntegration` and `tracesSampleRate: 0`, so it never creates competing spans or injects
  a rival trace header. OTel stays the single source of the distributed trace. Session Replay masks all
  text and blocks media by default (`maskAllText`/`blockAllMedia`) — only the DOM structure needed to
  replay leaves the browser, no page content or PII.
- **Correlated with the trace.** `beforeSend` stamps the **active OTel `trace_id`/`span_id`** onto each
  Sentry event when a span is active at capture time (e.g. an error thrown during an instrumented API
  call). So from a Sentry issue you copy `trace_id` and open the full frontend→backend trace in
  OpenObserve — the error, its Replay, *and* its distributed trace. An error with no active span (a pure
  render/UI error — nothing distributed happened) simply carries no `trace_id`; that's expected.
- **It wraps, and still calls, our last-resort `app.config.errorHandler`** (the `console.error` floor),
  so local-dev logging is unaffected whether Sentry is on or off.
- **Config:** `VITE_SENTRY_DSN` (required to turn on), `VITE_SENTRY_ENVIRONMENT` (defaults to Vite's
  `MODE`), `VITE_SENTRY_RELEASE` (group regressions by deploy), `VITE_SENTRY_REPLAY_SAMPLE_RATE`
  (0..1 share of sessions to replay; error sessions are always replayed). Source-map upload for readable
  stacks is a build-pipeline step — see [Sentry source maps](https://docs.sentry.io/platforms/javascript/guides/vue/sourcemaps/).

> **Why Sentry for the frontend and not browser OTel logs/errors?** As of 2026, OTel-JS traces are
> stable but browser error/log instrumentation is far less mature than Sentry's. The split here — OTel
> for the distributed trace, Sentry for error UX + Replay — is the pragmatic production baseline.

> **Bundle cost (honest note).** Both the OTel web packages *and* Sentry are static imports, so they ship
> in the bundle even when their env vars are unset (~170 kB gzip together). Acceptable for a template
> that demonstrates the capability. To keep them out of the default bundle, gate the imports behind a
> dynamic `import()` on the env var — straightforward for Sentry; for `tracing.ts` mind that it must
> still patch `window.fetch` before `@app/api-client` binds it.

## 5. Custom metrics — the pattern to copy

`apps/backend/src/observability/metrics.ts` defines a demo counter, incremented in the login flow
(`AuthService.login`) and exported as `auth_logins` with a `result` label:

```ts
const c = metrics.getMeter('app-backend').createCounter('auth.logins', { /* ... */ });
c.add(1, { result });
```

**Gotcha it demonstrates:** the instrument is created **lazily on first use**, not at module load.
This module is imported (via `AppModule`) before `bootstrap()` calls `startOtel()`, so an instrument
built at import time would bind to the API's no-op meter permanently and never export. Bind on first
record, by which point the SDK's MeterProvider is installed. (When OTel is off the meter is a no-op, so
recording is always safe.)

## 6. The collector

`infra/docker/otel-collector-config.yaml`, run as `otel/opentelemetry-collector-contrib` under the
`observability` profile:

- **otlp receiver** (`:4318`) — traces + metrics from the backend/bot, and browser fetch spans. CORS is
  enabled for the dev origin so the browser can post directly.
- **filelog receiver** — tails `/var/lib/docker/containers/*/*-json.log` (mounted read-only; the
  service runs as root to read them). It unwraps the Docker json-file envelope, parses the Pino JSON,
  lifts severity/timestamp, and **promotes `trace_id`/`span_id`/`trace_flags` to the log record's trace
  context**. A `filter` operator drops non-Pino lines (postgres, redis, OpenObserve, the collector
  itself) — this focuses OpenObserve on the app's own logs **and breaks the feedback loop** of the
  collector re-ingesting OpenObserve's ingest logs. Remove that operator to collect every container.
- **otlphttp exporter** → OpenObserve, authenticated with `OPENOBSERVE_AUTH_HEADER`
  (`Basic base64(email:password)` of the OpenObserve root user).

> OpenObserve's image is distroless (no shell/curl), so its container has **no healthcheck** — an
> in-container HTTP probe can't run. The collector tolerates OpenObserve not being ready by retrying.

## 7. Signal over noise — the verbose toggles

Auto-instrumentation is verbose out of the box. Two switches keep the default view clean while making
the detail available on demand — nothing is deleted, only suppressed.

| What | Default (`info` / off) | Turn on for detail |
| --- | --- | --- |
| **Per-request access logs** (method/url + **all** req/res headers) | hidden — demoted to `debug`; but 4xx→`warn` and 5xx→`error` still surface | `LOG_LEVEL=debug` |
| **Per-middleware / route-layer spans** (Express/router/connect) | off — a request is ~1 span (the HTTP server span) | `OTEL_VERBOSE_SPANS=true` → ~20 spans |

- **Logs.** `pinoHttp.customLogLevel` (in `app.module.ts`) returns `debug` for successful requests, so
  at the default `info` they don't emit at all — the wall of `res_headers_*` fields is gone. Failed
  requests still log (as `warn`/`error`), and your own application logs are unaffected.
- **Spans.** `buildInstrumentations(verboseSpans)` disables `express`, `router` **and** `connect` when
  off. (In Express 5 / NestJS 11 the "middleware - X" and "request handler - X" spans come mostly from
  the standalone `router` package, not the express instrumentation — disabling express alone is not
  enough.) The lean `POST` span keeps the route as attributes (`http.target`/`http.url`) and the status
  code; only the span's *display name* drops the route. Verbose mode restores the per-layer spans and
  the route-enriched name (`POST /auth/login`).

## 8. Log↔trace correlation

1. In-process, `traceContextMixin` writes `trace_id`/`span_id`/`trace_flags` onto each log line while a
   span is active (request access logs and any log you emit inside a handler — e.g. the
   `login succeeded` line in `AuthService`).
2. The collector's filelog `trace` block reads those fields and sets them as the OTLP log record's
   native trace context.
3. OpenObserve indexes them, so a log links to its trace and back.

Verified end-to-end: `login succeeded` logs share a `trace_id` that also exists in the traces stream.

## 9. Reading telemetry in OpenObserve

Open <http://localhost:5080> (`admin@example.com` / `ChangeMe123!`), org `default`. The log/trace
explorer has a few sharp edges — this section is the map.

### Traces (Traces tab, stream `default`)

- A **trace** is one request; each row in the waterfall is a **span** (a unit of work). Indentation is
  parent→child; the bars are start time + duration on a shared axis; the small numbers are per-span
  durations. The `s`/`i` badges mark server vs internal spans.
- **Click a span** to see its attributes: `http.method`, `http.target` (the route/path — this is where
  `/auth/login` lives even when the span name is a bare `POST`), `http.status_code`, etc.
- **"0 errors" on a 4xx is normal.** OTel marks a span as error only on 5xx; a 401 is an expected
  response, so the span isn't an error — but `http.status_code=401` is on it.
- The **Waterfall / Flame Graph / Trace Graph** tabs are three views of the same spans (timeline /
  time-share / service graph).
- **Why one span by default?** Per-middleware spans are off (§7). A login is a single `POST` span with
  the route in attributes. Set `OTEL_VERBOSE_SPANS=true` for the ~20-span middleware breakdown.

### Logs (Logs tab, stream `default`)

- **The frontend is not here.** The browser emits only **traces** (and Sentry errors), never logs — the
  collector's log pipeline tails container stdout, and the browser is not a container. So
  `service.name=app-frontend` shows up in **Traces**, not in Logs; don't hunt for it here.
- **Make the list readable:** the raw row is the whole JSON record, dominated by `res_headers_*`. Add
  columns from the left **Fields** panel (`body`, `level`, `service_name`, `context`, `req_method`,
  `req_url`, `trace_id`) to get a tidy table, or expand a row (the `>` chevron) for a key/value view.
- **Two gotchas that look like data loss but aren't:**
  - *Added columns show empty / a row expands to only `{_timestamp}`* → OpenObserve is in a
    field-projection mode. Press **Run query** again after adding columns; if a row still shows only
    `_timestamp`, turn **Quick Mode (⚡)** off, or use SQL mode `SELECT * FROM default WHERE …`.
  - *`res_statuscode` (and `res_headers_*`) are blank on application logs* → correct: those exist only
    on the per-request access log (written at the *end* of the request). An application log like
    `login succeeded` is written mid-request, before the response status exists. It still carries
    `req_method`/`req_url`/`context`/`trace_id` (nestjs-pino adds request context).
- **Useful queries:** `body='login succeeded'` (application logs) · `level=50` (errors; pino: 30 info,
  40 warn, 50 error, 60 fatal) · `res_statuscode=401` (failed requests — remember these are `warn`, so
  they show at `info`) · `trace_id='…'` (every log of one request).
- **Access logs hidden?** That's §7 — raise `LOG_LEVEL=debug` to see them.

### Metrics (Metrics tab)

- The custom counter is `auth_logins` with a `result` label. Auto metrics: `http_server_duration*`,
  `nodejs_*`, `v8js_*`. It's a **cumulative** counter, so don't read a summed value as "number of
  logins" — compare points over time or rate it.

### The log↔trace click-through (the point of it all)

From a log with a `trace_id`, jump to its trace; from a span, copy the `trace_id` and filter Logs by
`trace_id='…'` to see every log of that request. Two clicks from "something's wrong in a log" to "here's
the whole request, span by span".

### Inspecting an error end-to-end

The trace is built to answer "what broke, and where" without leaving it:

1. **Find the failing trace.** In Traces, filter for errors (spans with `ERROR` status, or
   `http.status_code >= 500`). A 5xx span is red because the backend interceptor set its status (§3).
2. **Open the exception.** Click the red span → its **Events/Exceptions** carry the exception
   `type`, `message`, and **stack trace** — recorded by the interceptor at the throw site. You see the
   error *in the waterfall*, next to the DB/HTTP spans that led to it, not as a bare status code.
3. **Walk the chain.** With browser tracing on, the root is the `app-frontend` fetch span, so you can
   see the failure in context of the click that caused it and the DB span that failed under it — one
   trace, three services.
4. **From a frontend error → the trace.** If Sentry is on (§4b), open the issue, copy its `trace_id`
   tag, and filter Traces by `trace_id='…'`. The Sentry issue gives you the source-mapped JS stack and
   the Session Replay; the trace gives you the server-side spans and exception. Same request, both lenses.

Remember: **4xx are intentionally not errors** (§9 Traces) — a validation 400 or auth 401 shows its
`http.status_code`, not a red span. Filter by status code when you care about those.

## 10. What to collect — metrics & spans

Auto-instrumentation already gives you HTTP/DB spans and runtime metrics. This is the menu to add to,
and where to stop.

**RED for every API route** — the three questions an on-call asks first:

- **Rate** — requests per route + method.
- **Errors** — the share of 5xx (and expected business errors you care about).
- **Duration** — p50/p95/p99 latency (a histogram, not an average).

**Standard metrics worth having** (most come free from auto-instrumentation):

| Metric | Meaning |
| --- | --- |
| `http.server.request.duration` | Inbound HTTP latency (the RED duration histogram). |
| `http.client.request.duration` | Outbound HTTP latency (calls to other services). |
| `db.client.operation.duration` | SQL/DB operation time. |
| `http.server.active_requests` | In-flight requests (concurrency). |
| `nodejs.eventloop.utilization` | Event-loop saturation — the Node "am I CPU-bound" signal. |
| `process.cpu.utilization` / `*.memory.usage` | Process CPU and memory. |

**Workers & queues** (if/when you add background jobs to the bot or a worker): `jobs.started` /
`jobs.completed` / `jobs.failed` counters, a `job.duration` histogram keyed by `job.type`, and gauges
for `queue.depth` and `queue.oldest_job.age`. These are the inputs to the worker/queue alerts in §12.

**Manual business spans** — wrap *notable* operations (an external call, a DB transaction, a job step,
a business action like `payment.process` or `telegram.message.fetch`) in a span so they show in the
trace. The `auth.logins` counter in §5 is the metric analogue; a manual span is the trace analogue.

> **Don't trace every function.** A span should be a notable unit of work — an external call, a DB query,
> a job, a business step. Span-per-function explodes cost and makes the waterfall unreadable. This is the
> same reasoning as the per-middleware spans being off by default (§7).

## 11. Cardinality, privacy & sampling

**Never use high-cardinality or sensitive values as metric labels / span attributes you index on.**
Each distinct label value is a new time series; unbounded label values (an id, an email) blow up
storage and query cost. Keep them in *logs/trace attributes* (searchable, not indexed as series) if you
need them at all.

| ✅ Good labels (bounded) | ❌ Never as labels (unbounded / sensitive) |
| --- | --- |
| `http.request.method`, `http.route` (`/orders/:id`) | `user_id`, `email`, `order_id`, `request_id`, `message_id` |
| `http.response.status_code` | `full_url` (query string), raw SQL, `error_message` |
| `deployment.environment.name`, `service.name`, `job.type` | anything unbounded or free-text |

**Never collect these at all** (redact them — see §1): `Authorization`, `Cookie`/`Set-Cookie`,
`password`, access/refresh tokens, API keys, the bot's `x-service-token`, bank details, full request
bodies, Telegram session strings. `LOG_REDACT_PATHS` in `logger.ts` enforces the header/credential
cases in logs; keep it in sync when you add a secret.

**Sampling** — 100% locally, sample in production but keep what matters. Two layers:

| Environment / trace kind | Recommendation |
| --- | --- |
| Local / staging | 100% (see everything) |
| Production, ordinary requests | 5–10% head sampling |
| Errors, slow requests | 100% via **tail** sampling |
| Critical business operations | elevated or 100% |

*Head* sampling (decide at span start) is a `TraceIdRatioBased` sampler. The NodeSDK here reads the
standard OTel env vars directly (no code change): set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and
`OTEL_TRACES_SAMPLER_ARG=0.1` (10%) in the backend/bot environment. *Tail* sampling
(decide once the whole trace is seen, so you can **keep 100% of error/slow traces and sample the rest**)
belongs in the collector, not the app: add a [`tail_sampling` processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor)
to `otel-collector-config.yaml` with policies for `status_code = ERROR` and a latency threshold, plus a
probabilistic policy for the rest. This keeps the "app generates signals; the collector delivers them"
split (Architecture) — the app doesn't make sampling policy.

## 12. Dashboards & alerts

OpenObserve has dashboards and alerting built in (Alerts → create a scheduled/real-time alert on a
stream + condition; Dashboards → panels over the same streams). Five alerts worth starting with:

| Alert | Starting threshold |
| --- | --- |
| API error rate | 5xx > 2% over 5 min |
| API latency | p95 > 1 s over 10 min |
| Service availability | no successful health check for > 2 min |
| Worker failures | job error rate > 5% over 10 min |
| Queue lag | oldest job age exceeds its business SLA |

A first **API dashboard**: requests/sec by route · error rate by route + status · p50/p95/p99 latency ·
top slow routes · DB operation duration · CPU/memory/event-loop · and a link from a spike to an
exemplar `trace_id`.

> **What makes an alert good:** it means a user or the business is hurting, or is about to. Don't page on
> a momentary CPU spike with no confirmed impact on latency or errors. An alert with no action is noise
> that trains people to ignore the pager.

## 13. Definition of done

A telemetry setup is "done" when:

- Any 5xx is findable in logs by `trace_id`/request context, and opens the related trace with the
  recorded exception (§3, §9).
- Every signal carries `service.name`, `service.version`, and `deployment.environment.name`, so you can
  compare error rate and latency between releases after a deploy.
- No secrets in logs or traces — tokens, cookies, passwords are redacted (§1, §11).
- Metric labels are bounded (§11).
- There's a dashboard for the API (and workers, if present) and the five alerts above (§12).
- The collector has a health check and is itself monitored.

## 14. References

Official docs behind the choices here:

- OpenTelemetry JavaScript — [status/releases](https://opentelemetry.io/docs/languages/js/),
  [Node getting started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/),
  [exporters](https://opentelemetry.io/docs/languages/js/exporters/),
  [resources](https://opentelemetry.io/docs/languages/js/resources/),
  [context propagation](https://opentelemetry.io/docs/languages/js/propagation/),
  [handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/).
- Semantic conventions — [HTTP metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/),
  [database metrics](https://opentelemetry.io/docs/specs/semconv/database/database-metrics/).
- Collector — [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/),
  [`tail_sampling` processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor).
- Sentry — [Vue SDK](https://docs.sentry.io/platforms/javascript/guides/vue/),
  [Session Replay](https://docs.sentry.io/platforms/javascript/session-replay/),
  [source maps](https://docs.sentry.io/platforms/javascript/guides/vue/sourcemaps/).

## Turn it on

**Locally (the containerized demo) — don't pass `--env-file .env`.** The repo-root `.env` is
host-oriented (`DATABASE_URL`/`REDIS_URL`/`OTEL_EXPORTER_OTLP_ENDPOINT` all point at `localhost`); under
`--env-file` those *override* Compose's in-network service names, so the backend looks for Postgres at
`localhost:5432` inside its own container and crash-loops. Compose's built-in defaults already wire the
services together in-network (`postgres`, `redis`, `otel-collector`) with throwaway `change-me` secrets —
exactly what a local demo wants. Enable the SDK via the shell (Compose reads it for
`${OTEL_SDK_DISABLED:-true}`) and start the profile:

```bash
OTEL_SDK_DISABLED=false docker compose -f infra/docker/docker-compose.yml --profile observability up -d
```

`OTEL_EXPORTER_OTLP_ENDPOINT` then defaults to the collector (`otel-collector:4318`),
`OPENOBSERVE_AUTH_HEADER` matches the OpenObserve defaults, and the services get their per-service names
(`app-backend`, `app-telegram-bot`). *(Verified: with this command, fresh `app-backend` spans land in
OpenObserve.)* To change the OpenObserve creds, regenerate the header:
`printf '%s' 'admin@example.com:ChangeMe123!' | base64`.

Then, optionally:

- **Browser tracing** (the frontend→backend distributed trace). Easiest via host `pnpm dev`: Vite reads
  `VITE_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` from `.env` at dev time, and the dev origin
  (`:5173`) is already allow-listed in both the backend `CORS_ORIGIN` and the collector's
  `cors.allowed_origins`. For the *containerized* frontend (`:8080` — also allow-listed on both) you must
  bake `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` in at **image build time**; it's a Vite build-time var, not a
  runtime one. Exercise the app; a click's trace spans `app-frontend` + `app-backend`.
- **Frontend errors (Sentry).** Set `VITE_SENTRY_DSN` — also a Vite build-time var (`pnpm dev` or a
  rebuilt image) (§4b). Errors + Session Replay flow to Sentry, each tagged with the OTel `trace_id` for
  jump-to-trace. Independent of the collector/OpenObserve stack.

Open OpenObserve at <http://localhost:5080> (`admin@example.com` / `ChangeMe123!`). Traces, metrics (incl.
`auth_logins`), and correlated logs appear under the `default` org.

**In production it's the reverse:** Ansible renders a *container-oriented* `.env` (service-name hosts +
real vault secrets) and passes `--env-file`, so there you enable it via `group_vars`
(`otel_sdk_disabled: "false"` + `compose_profiles: ["observability"]`) — see
[Production / VPS](#production--vps), not this local shortcut.

## Environment variable reference

Validated by `@app/config` (`packages/config/src/index.ts`); add new vars there **and** in `.env.example`.
Frontend `VITE_*` vars are read by Vite from the root `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Pino level. `debug` also emits per-request access logs (with headers). |
| `OTEL_SERVICE_NAME` | `app` | `service.name` + Pino logger `name` (Compose: `app-backend` / `app-telegram-bot`). |
| `SERVICE_VERSION` | `0.0.0` | `service.version` — set to your release tag/SHA. |
| `OTEL_SDK_DISABLED` | `false` | `true` makes `startOtel` a no-op. `.env.example`/Compose ship `true`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `''` | Where backend/bot traces/metrics are pushed; empty ⇒ dark. Compose default: the collector. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `''` | OTLP headers (unused app→collector; the collector holds backend auth). |
| `OTEL_VERBOSE_SPANS` | `false` | `true` keeps per-middleware/route-layer spans (~20 spans/request). |
| `METRICS_EXPORTER` | `otlp` | `otlp` push (via collector) or `prometheus` pull (`/metrics` on `:9464`). |
| `OPENOBSERVE_AUTH_HEADER` | `Basic …` | Collector→OpenObserve auth; `Basic base64(ZO_ROOT_USER_EMAIL:ZO_ROOT_USER_PASSWORD)`. |
| `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD` | `admin@example.com` / `ChangeMe123!` | OpenObserve root login (Compose). |
| `OPENOBSERVE_PORT` / `OTEL_COLLECTOR_PORT` | `5080` / `4318` | Host ports for the OpenObserve UI and the collector OTLP endpoint. |
| `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` | `''` | Browser tracing target (collector, browser-reachable). Empty ⇒ browser tracing off. |
| `VITE_OTEL_SERVICE_NAME` | `app-frontend` | `service.name` for browser spans. |
| `VITE_SENTRY_DSN` | `''` | Frontend Sentry DSN. Empty ⇒ Sentry off (§4b). |
| `VITE_SENTRY_ENVIRONMENT` | Vite `MODE` | Sentry `environment` for the frontend. |
| `VITE_SENTRY_RELEASE` | `''` | Sentry `release` (e.g. git SHA) to group regressions by deploy. |
| `VITE_SENTRY_REPLAY_SAMPLE_RATE` | `0` | Share (0..1) of sessions to Session-Replay; error sessions always replayed. |
| `SENTRY_DSN` | `''` | Reserved for optional backend Sentry (unused by default; backend errors go on the span + logs). |

## Production / VPS

Everything above is localhost; on a deployed VPS (Docker Compose via Ansible — `infra/ansible/`) the
wiring is identical but a few knobs and one security fact differ.

- **Enable it.** In `infra/ansible/group_vars/all.yml` set `compose_profiles: ["observability"]` (starts
  the collector + OpenObserve) **and** `otel_sdk_disabled: "false"` (turns the app SDK on), then redeploy
  (`pnpm deploy:vps`). The app still exports to the **collector** (`otel_exporter_otlp_endpoint:
  http://otel-collector:4318`), never straight to OpenObserve — so it holds no storage credentials, same
  as local.
- **Auth is derived, not hard-coded.** `templates/env.j2` renders `OPENOBSERVE_AUTH_HEADER` from the vault
  OpenObserve creds (`vault_openobserve_email`/`vault_openobserve_password`), so the collector's auth
  always matches whatever password you vault. Set a real `vault_openobserve_password` — don't ship
  `ChangeMe123!`.
- **The sink is publicly exposed by default.** Unlike Postgres/Redis (bound to `127.0.0.1`), the
  OpenObserve UI (`:5080`) and the collector's OTLP port (`:4318`) publish on `0.0.0.0`. On a public host:
  - **Change the default OpenObserve password** (above) — the UI is reachable from the internet.
  - **Don't expose `:5080` raw.** Put it behind your reverse proxy (TLS + auth), or bind `OPENOBSERVE_PORT`
    to `127.0.0.1` and tunnel — it holds all your logs/traces.
  - **`:4318` only needs to be public if you run *browser* tracing in prod** (the browser posts OTLP to
    it). The backend and bot reach the collector over the Compose network by name regardless, so firewall
    `:4318` too if you don't do prod RUM.
- **Browser tracing in prod.** Set `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` to the collector's public URL at
  build time **and** add the prod frontend origin to the collector's `cors.allowed_origins`
  (`otel-collector-config.yaml`). Without both, the browser's OTLP POST is CORS-blocked.

## Using a different backend

Because the collector is the single egress, swapping backends is a change to **one exporter**, not the
app:

- **Grafana + Prometheus** — add a `prometheus`/`prometheusremotewrite` exporter (or set
  `METRICS_EXPORTER=prometheus` and scrape `:9464`). Metrics-focused; logs/traces need Loki/Tempo.
- **Managed (Grafana Cloud, Axiom, …)** — point the collector's otlphttp exporter at the vendor's OTLP
  URL + token. The app is unchanged.
- **SigNoz / Uptrace** — OTLP-native like OpenObserve; repoint the exporter.

**Why OpenObserve is the default:** one small VPS, a single lightweight sink for all three signals, and
the collector makes the backend swappable. See the design discussion in git history for the full
comparison.
