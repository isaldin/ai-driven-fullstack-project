# VPS Deployment (Ansible + Docker Compose)

Automated deploy of the full stack (backend, frontend, telegram-bot, postgres,
redis, optional OpenObserve) to a VPS. Ansible syncs the repo to the server,
renders a `.env`, builds images, applies DB migrations, and starts the stack.

## Prerequisites

- **Control machine** (your laptop / CI): `ansible-playbook` installed.
- **Target VPS**: SSH access as a sudo-capable user, with **Docker Engine +
  the Compose v2 plugin** installed. The playbook fails fast with a clear
  message if either is missing (it checks but does not install them).

## Files

| Path | Purpose |
|------|---------|
| `inventory.ini` | Hosts in the `app` group. Edit the placeholder host/user. |
| `group_vars/all.yml` | Non-secret defaults (ports, domains, repo URL). Committed. |
| `templates/env.j2` | Renders the target `.env` from vars + vault. |
| `deploy.yml` | The playbook. |
| `vault.example.yml` | Template for secrets — copy, fill, and **encrypt**. |

## Secrets: ansible-vault

Secrets (JWT signing keys, DB password / URL, service + bot tokens) must never
sit in `group_vars/all.yml` in plaintext. Keep them in an **encrypted vault**:

```bash
# 1. Create your secrets file from the template
cp infra/ansible/vault.example.yml infra/ansible/vault.yml

# 2. Fill in real values, then encrypt it
ansible-vault encrypt infra/ansible/vault.yml
```

`deploy.yml` auto-loads `infra/ansible/vault.yml` (or the conventional
`group_vars/all/vault.yml`) when present, overriding the `vault_*` placeholders
in `group_vars/all.yml`. The decrypted file is **git-ignored** — never commit it.

Edit later with:

```bash
ansible-vault edit infra/ansible/vault.yml
```

## Configure

1. Edit `inventory.ini` — set `ansible_host` and `ansible_user` for your VPS.
2. Edit `group_vars/all.yml` — set `repo_url`, `repo_version`, and your real
   `cors_origin` / `cookie_domain` / `vite_api_url` domains. To also run
   OpenObserve, set `compose_profiles: ["observability"]`.
3. Create and encrypt `vault.yml` (above).

## Deploy

From the repo root:

```bash
pnpm deploy:vps -- --ask-vault-pass
```

`pnpm deploy:vps` runs:

```bash
ansible-playbook -i infra/ansible/inventory.ini infra/ansible/deploy.yml
```

Append `--ask-vault-pass` (or `--vault-password-file <file>`) so the encrypted
`vault.yml` can be decrypted. Without a vault file the playbook still runs using
the `change-me` placeholders — useful for a dry run, not for production.

Useful flags:

```bash
# Preview without changing anything
pnpm deploy:vps -- --check --diff --ask-vault-pass

# Validate playbook structure only (no SSH, no vault needed)
ansible-playbook --syntax-check -i infra/ansible/inventory.ini infra/ansible/deploy.yml
```

## What the playbook does

1. Verifies Docker CLI, the Compose plugin, and a running daemon on the target.
2. Clones/updates the repo into `{{ app_dir }}` (default `/opt/app`).
3. Renders `{{ app_dir }}/.env` (mode `0600`) from vars + vault.
4. `docker compose build` all images.
5. Starts `postgres` + `redis`, then runs `zen migrate deploy` via
   `docker compose run --rm backend pnpm --filter @app/backend db:migrate`.
   (The backend container also runs migrations on boot; this makes the step
   explicit and observable. Both are idempotent.)
6. `docker compose up -d` the full stack (plus any `compose_profiles`).
7. Prunes dangling images.
