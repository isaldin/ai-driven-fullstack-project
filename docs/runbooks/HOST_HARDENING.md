# Runbook: VPS Host Hardening

Defense-in-depth for the single-VPS deploy: an Ansible `host_hardening` role hardens the
**host**, and `docker-compose.yml` hardens every **container**. This runbook documents each
control, the one deliberate exception, network segmentation, log/disk bounds, and a
verification checklist.

Source of truth:
- `infra/ansible/roles/host_hardening/defaults/main.yml` — toggles
- `infra/ansible/roles/host_hardening/tasks/main.yml` — tasks
- `infra/docker/docker-compose.yml` — container hardening + networks

## The `host_hardening` Ansible role

Master switch: `harden_host: true`. Every concern below is individually toggleable so the
role fits hosts you fully own **and** hosts where some concerns are managed elsewhere.

### Firewall — ufw (`manage_firewall: true`)

Default-deny inbound, allow outbound, and open only what's needed:

- Allows **SSH** (`ssh_port`, default `22`, from `ssh_allowed_cidr`, default `0.0.0.0/0`).
- Allows **80/443** (`public_tcp_ports`) — the only application ports, all served by Caddy.
- Sets policy `deny` incoming / `allow` outgoing, then enables ufw.

> **Lockout safety:** the SSH allow rule is applied **before** ufw is enabled (see task
> ordering in `tasks/main.yml`), so enabling the default-deny policy can never cut your own
> session. Tighten `ssh_allowed_cidr` to your admin network/CIDR for a real deploy.

> **Docker + ufw caveat:** Docker's `iptables` rules can **bypass ufw** for published
> container ports. This is exactly why the stack publishes **only Caddy's** 80/443 — no
> other container maps a host port, so there's nothing for Docker to punch through ufw for.
> Never add a `ports:` mapping to postgres/redis/backend in the production compose file.

### Automatic security updates (`manage_unattended_upgrades: true`)

Installs `unattended-upgrades` + `apt-listchanges` and writes
`/etc/apt/apt.conf.d/20auto-upgrades` enabling periodic package-list updates and unattended
security upgrades.

### Docker daemon log limits (`manage_docker_logging: true`)

Writes `/etc/docker/daemon.json` with a global `json-file` log driver capped at
`docker_log_max_size` (`10m`) × `docker_log_max_file` (`5`), plus `"live-restore": true`
(containers keep running across a daemon restart). This is a belt-and-suspenders default
underneath the per-container limits below, and restarts Docker via handler when changed.

### Time synchronization (`manage_time_sync: true`)

Ensures `systemd-timesyncd` is enabled and running (correct clocks matter for TLS validity,
JWT expiry, and log/trace correlation). `failed_when: false` so hosts using a different NTP
daemon don't fail the run.

### Optional SSH hardening (`manage_ssh_hardening: false` — OFF by default)

When enabled, drops `/etc/ssh/sshd_config.d/10-hardening.conf` with `PermitRootLogin no`,
`PasswordAuthentication no`, `ChallengeResponseAuthentication no`, and restarts sshd.

> **Why it's off by default:** flipping these on a host where you haven't confirmed
> key-based access **will lock you out** (no password fallback, no root login). Enable it
> deliberately only after you've verified you can SSH in with a key. The role has a `rescue`
> block that fails loudly and points back here if any hardening step errors.

Run just this role (or the full deploy which includes it):

```bash
cd infra/ansible
ansible-playbook -i inventory.yml deploy.yml --tags host_hardening
# Enable SSH hardening only after key access is confirmed:
#   ansible-playbook ... -e manage_ssh_hardening=true
# If a firewall rule risks lockout, recover with: -e manage_firewall=false
```

## Container hardening (docker-compose.yml)

Shared `x-hardening` anchor + per-service settings apply to every stateless container:

- **Non-root users** — frontend runs `nginx-unprivileged` (UID 101, listens on 8080); the
  bot image runs `USER node`; Caddy drops to non-root and binds 80/443 via a single added
  capability.
- **`cap_drop: ALL`** — all Linux capabilities dropped. Only **Caddy** adds back
  `NET_BIND_SERVICE` (to bind the privileged 80/443 ports as non-root).
- **`no-new-privileges:true`** — no setuid privilege escalation.
- **`read_only: true` rootfs + `tmpfs`** for stateless services (frontend, telegram-bot,
  Caddy) — the filesystem is immutable; writable scratch is a small tmpfs (`/tmp`, and for
  nginx also `/var/cache/nginx` + `/var/run`).
- **`init: true`** — a real PID 1 to reap zombies and forward signals.
- **Resource limits** — per-service `memory` / `cpus` / `pids` caps (e.g. backend 768m/1.0/300,
  postgres 1g/1.0/200) to contain runaway processes and fork bombs.
- **Pinned images** — every image is pinned to a version tag (`caddy:2.10-alpine`,
  `postgres:17-alpine`, `redis:7-alpine`, `otel/opentelemetry-collector-contrib:0.114.0`,
  …), never `:latest`. Real releases pin immutable `@sha256:` digests via the release overlay.
- **Bounded logging** — every service uses the shared `x-logging` anchor (`json-file`,
  `max-size: 10m`, `max-file: 5`).

### Documented exception: the backend is NOT `read_only`

The **backend** container intentionally omits `read_only: true`. Its boot command runs
`zen migrate deploy` (the Prisma migration engine + pnpm), which writes temporary state to
the container filesystem. This is the **single documented exception** to the
read-only-rootfs rule (also noted inline in `docker-compose.yml`).

Everything else still applies to the backend: `cap_drop: ALL`, `no-new-privileges`,
`init: true`, resource/PID limits, bounded logging, pinned image. It's a writable rootfs —
not a privileged or root-capable container.

## Network segmentation

Three Docker networks, two of them egress-blocked (`internal: true`):

| Network                    | `internal`? | Members                                          |
| -------------------------- | ----------- | ------------------------------------------------ |
| `edge`                     | no          | caddy, frontend, backend, telegram-bot           |
| `app_internal`             | **yes**     | postgres, redis, backend, telegram-bot           |
| `observability_internal`   | **yes**     | otel-collector, openobserve, caddy, backend, bot |

Consequences:

- **`app_internal` and `observability_internal` have no route to the internet.** Postgres,
  Redis, the collector, and OpenObserve cannot make outbound connections.
- **Egress** for backend and telegram-bot comes from their membership in `edge` (the bot
  needs it to reach Telegram; the backend for any outbound calls).
- **Postgres and Redis are ONLY on `app_internal`** and publish **no** host ports — reachable
  only by service name from backend/bot, never from the host or the internet.
- **The frontend is on `edge` only** — it physically **cannot reach postgres/redis** (they're
  not on `edge`). A compromised SPA container has no path to the data plane.
- **OpenObserve is not on the app data plane** (`app_internal`) — telemetry storage is
  isolated on `observability_internal`, reachable in prod only via Caddy's `${OBSERVE_DOMAIN}`.

## Log rotation / disk

Disk usage from logs is bounded on two levels:

1. **Per-container** — every service's `logging:` caps json-file at 10m × 5 files.
2. **Docker daemon default** — `/etc/docker/daemon.json` (from the role) applies the same
   cap to any container that didn't set its own.

Verify:

```bash
# Per-container effective log options
docker inspect --format '{{.Name}} {{json .HostConfig.LogConfig}}' $(docker ps -q)

# Daemon-wide defaults
cat /etc/docker/daemon.json

# Disk headroom (watch /var/lib/docker)
df -h /var/lib/docker
docker system df
```

## Verification checklist

```bash
# 1. Firewall: only SSH + 80/443 allowed, default-deny inbound.
sudo ufw status verbose        # expect: Default deny (incoming); allow 22, 80, 443 only

# 2. From an EXTERNAL host: only 80/443 reachable (postgres/redis/backend not exposed).
nmap -Pn -p 22,80,443,3000,5432,6379,5080 <vps-ip>   # 80/443 open; 5432/6379/3000/5080 closed/filtered

# 3. Frontend cannot reach the data plane (should fail / not resolve).
docker compose -f infra/docker/docker-compose.yml exec frontend sh -c \
  'getent hosts postgres || echo "no route to postgres (expected)"'
#   postgres is not resolvable/reachable from frontend because it's not on app_internal.

# 4. Containers run as non-root.
for c in frontend telegram-bot caddy; do
  echo -n "$c: "; docker compose -f infra/docker/docker-compose.yml exec $c id
done   # expect non-zero uid (nginx=101, node=1000, caddy non-root)

# 5. Read-only rootfs on stateless services (write should fail); backend is the exception.
docker compose -f infra/docker/docker-compose.yml exec frontend sh -c \
  'touch /tmp/ok && touch /usr/share/nginx/html/x 2>&1 || echo "rootfs read-only (expected)"'

# 6. Automatic updates + time sync active.
systemctl is-enabled unattended-upgrades 2>/dev/null; cat /etc/apt/apt.conf.d/20auto-upgrades
timedatectl status | grep -iE 'synchronized|NTP service'
```

Expected results:
- [ ] `ufw status` shows default-deny inbound and only `22`, `80`, `443` allowed
- [ ] From outside, only `80`/`443` reachable; `5432`/`6379`/`3000`/`5080` closed/filtered
- [ ] `docker exec frontend` cannot resolve/reach `postgres` or `redis`
- [ ] `docker exec <c> id` returns a non-root UID for frontend/bot/caddy
- [ ] Stateless containers reject rootfs writes; backend (documented exception) is writable
- [ ] `unattended-upgrades` enabled and clock is NTP-synchronized
</content>
