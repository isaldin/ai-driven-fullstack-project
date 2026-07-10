# Runbook: Reverse Proxy & TLS (Caddy)

How the production stack terminates TLS, redirects HTTP→HTTPS, and adds security headers —
plus how to configure the domains, test certificate renewal safely, and verify the result.

Source of truth:
- `infra/docker/docker-compose.yml` — the `caddy` service (gated behind the `edge` profile)
- `infra/docker/Caddyfile` — TLS/ACME, security headers, routing, browser OTLP
- `infra/docker/nginx.conf` — the frontend's own response headers (CSP)
- `infra/ansible/group_vars/all.yml` + `infra/ansible/templates/env.j2` — how domains are set

## Architecture

**Caddy is the only service that publishes host ports** — `80`, `443`, and `443/udp`
(HTTP/3). Everything else is `expose`-only and reachable across the `edge` Docker network by
service name:

- `frontend:8080` (non-root nginx)
- `backend:3000` (NestJS API)
- `openobserve:5080` (telemetry UI, observability profile)

Caddy:

- **Terminates TLS** with **automatic ACME** (Let's Encrypt) — it obtains and renews certs
  with no manual steps, storing them in the `caddy_data` volume.
- **Redirects HTTP→HTTPS** automatically (Caddy default for any site with a real hostname).
- **Adds HSTS + security headers** via the reusable `security_headers` snippet.

Caddy runs **only under the `edge` compose profile** (production). Local dev
(`docker-compose.dev.yml`) leaves Caddy off and talks to services directly on republished
host ports — so there is no TLS locally.

```
                 :80/:443/:443udp (only published ports)
Internet ───────────────► Caddy (edge profile)
                            │  TLS termination, HTTP→HTTPS, HSTS + headers
              ┌─────────────┼───────────────────────────┐
              ▼             ▼                            ▼
      APP_DOMAIN     API_DOMAIN                  OBSERVE_DOMAIN
   frontend:8080   backend:3000                openobserve:5080
                   (+ /otlp/* → otel-collector:4318, opt-in)
```

## Configuration

Domains and the ACME contact reach Caddy as **environment variables**, which flow:

```
group_vars/all.yml  →  templates/env.j2  →  container-oriented .env  →  compose  →  Caddyfile
   (Ansible vars)        (renders KEY=val)      (--env-file .env)      (environment:)  ({$VAR})
```

The Caddy service reads these (with `example.com` fallbacks) and the `Caddyfile` references
them as `{$APP_DOMAIN}` etc.:

| Env var               | Sets                                    | Caddyfile use                          |
| --------------------- | --------------------------------------- | -------------------------------------- |
| `APP_DOMAIN`          | Frontend SPA hostname                   | `{$APP_DOMAIN}` site → `frontend:8080` |
| `API_DOMAIN`          | Backend API hostname                    | `{$API_DOMAIN}` site → `backend:3000`  |
| `OBSERVE_DOMAIN`      | OpenObserve UI hostname                 | `{$OBSERVE_DOMAIN}` → `openobserve:5080` |
| `ACME_EMAIL`          | Let's Encrypt account email             | global `email {$ACME_EMAIL}`           |
| `ENABLE_BROWSER_OTLP` | `"true"` opens the `/otlp` ingest path  | guards the `{$API_DOMAIN}/otlp/*` block |

For a real deploy, set these in `infra/ansible/group_vars/all.yml` (secrets go in the vault,
but these are non-secret and belong here):

```yaml
app_domain: "app.yourdomain.com"
api_domain: "api.yourdomain.com"
observe_domain: "observe.yourdomain.com"
acme_email: "ops@yourdomain.com"        # a monitored mailbox — ACME expiry notices go here
enable_browser_otlp: ""                  # leave empty unless you enable browser (RUM) tracing
compose_profiles: ["edge"]               # "edge" starts Caddy; add "observability" for telemetry
```

DNS prerequisite: `app_domain`, `api_domain`, and (if used) `observe_domain` must each have an
A/AAAA record pointing at the VPS **before** deploy, or ACME's HTTP/TLS challenge fails.

## Testing issuance / renewal safely

Let's Encrypt **production** has strict rate limits (e.g. certs-per-domain per week). To test
issuance or a renewal without burning them, switch Caddy to the **Let's Encrypt staging**
CA using the commented line in the global block of the `Caddyfile`:

```caddyfile
{
    email {$ACME_EMAIL}
    # Uncomment to test issuance/renewal without hitting Let's Encrypt rate limits:
    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```

Staging issues certs from an **untrusted** root, so browsers/`curl` will warn — that's
expected; you're only proving the ACME flow works end to end.

Controlled renewal test:

```bash
# 1. Uncomment the acme_ca staging line in infra/docker/Caddyfile, redeploy.
# 2. Force a fresh cert by clearing Caddy's stored certs (staging), then restart Caddy:
docker compose -f infra/docker/docker-compose.yml --profile edge exec caddy \
  sh -c 'rm -rf /data/caddy/certificates && true'
docker compose -f infra/docker/docker-compose.yml --profile edge restart caddy

# 3. Confirm a NEW staging cert was issued (issuer = "(STAGING) Let's Encrypt"):
echo | openssl s_client -connect app.yourdomain.com:443 -servername app.yourdomain.com 2>/dev/null \
  | openssl x509 -noout -issuer -dates

# 4. Re-comment acme_ca, redeploy, and clear certs ONCE more so Caddy re-issues a
#    trusted PRODUCTION cert. Verify issuer is the real "Let's Encrypt".
```

Caddy **auto-renews** in the background (well before expiry) — there is no cron job to set up.
Renewal uses the same ACME flow; the staging switch above is only for a controlled dry run.

## Security headers

**Caddy** applies these to every site via the `security_headers` snippet:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (HSTS)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `X-Frame-Options: DENY`
- `-Server` (strips Caddy's version noise)

**The frontend nginx** (`nginx.conf`) adds the app-content headers on every response,
notably a strict **Content-Security-Policy** (`default-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'self'`, …), plus its own copies of the nosniff /
Referrer-Policy / Permissions-Policy / X-Frame-Options headers (duplicated per-location
because nginx doesn't inherit parent `add_header` into a location that sets its own).

> **HSTS ordering:** only turn HSTS on **after** TLS is confirmed working end to end. HSTS
> tells browsers to refuse plain HTTP for `max-age` (a year, with `preload`); shipping it
> before certs are valid can hard-block the site. The header is defined in the snippet — if
> you're mid-bringup and unsure, comment out the `Strict-Transport-Security` line until the
> cert chain verifies, then re-enable.

## Swagger `/docs` is NOT served in production

The backend gates Swagger on `NODE_ENV` (`apps/backend/src/main.ts`): `SwaggerModule.setup('docs', …)`
runs only when `!isProd`. In production (`NODE_ENV=production`) the `/docs` UI is never
mounted and returns **404**. Helmet's full CSP is also only enabled in production (it's
relaxed in dev precisely so the Swagger UI works). The curated OpenAPI contract still comes
from the hand-written controllers — `/docs` is just the unauthenticated HTML explorer, which
we don't expose publicly.

## Browser OTLP (`/otlp`) — opt-in, locked down

The `{$API_DOMAIN}/otlp/*` route only forwards to the collector when
`ENABLE_BROWSER_OTLP=true`; otherwise it `respond 404` and the collector stays **fully
internal** (no public ingest at all). When enabled it is deliberately restricted:

- **CORS allowlist** to the app origin only: `Access-Control-Allow-Origin: https://{$APP_DOMAIN}`
  (methods `POST, OPTIONS`; headers `content-type, traceparent, tracestate`), with OPTIONS
  preflight answered `204`.
- **256KB request-body cap** (`request_body { max_size 256KB }`) so a public collector can't
  be used to flood telemetry storage.
- Strips the `/otlp` prefix and forwards to `otel-collector:4318` as `/v1/...`.

Leave `ENABLE_BROWSER_OTLP` empty unless the frontend actually emits browser traces (RUM).

## Verification checklist

```bash
# Cert is valid, trusted, with a full chain (issuer = Let's Encrypt in prod).
echo | openssl s_client -connect app.yourdomain.com:443 -servername app.yourdomain.com \
  -showcerts 2>/dev/null | openssl x509 -noout -issuer -subject -dates
curl -sSI https://app.yourdomain.com | head -n1        # HTTP/2 200

# HTTP→HTTPS redirect (301/308 to https://).
curl -sSI http://app.yourdomain.com | grep -iE 'HTTP/|location'

# HSTS + security headers present on HTTPS responses.
curl -sSI https://app.yourdomain.com | grep -iE \
  'strict-transport-security|x-content-type-options|x-frame-options|referrer-policy|permissions-policy|content-security-policy'

# Only 80/443 open publicly (postgres/redis/backend not reachable).
nmap -Pn -p 22,80,443,3000,5432,6379,5080 <vps-ip>     # 80/443 open; others closed/filtered

# /docs is 404 in production.
curl -sS -o /dev/null -w '%{http_code}\n' https://api.yourdomain.com/docs   # 404

# Browser OTLP: 404 when disabled; CORS-restricted 204 preflight when enabled.
curl -sS -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.yourdomain.com/otlp/traces
```

Expected results:
- [ ] Valid, trusted certificate with full chain; `https://` returns 200
- [ ] Plain HTTP redirects (301/308) to HTTPS
- [ ] `Strict-Transport-Security` + the other security headers present (HSTS only after TLS confirmed)
- [ ] Only `80`/`443` reachable from the public internet
- [ ] `GET /docs` returns `404` in production
- [ ] `/otlp` returns `404` unless `ENABLE_BROWSER_OTLP=true`
</content>
