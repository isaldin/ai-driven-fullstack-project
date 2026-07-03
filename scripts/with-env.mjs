#!/usr/bin/env node
// Load the nearest .env (walking up from cwd) into process.env, then run the
// given command. Zero-dependency helper for CLIs that read process.env but do
// not load a .env themselves (e.g. `zen`/Prisma migrate, run from apps/backend
// while the repo-root .env lives two levels up).
//
// Semantics match Node's --env-file: existing process.env vars win (non-override),
// so this is safe in CI/containers where env is provided directly and no .env
// exists (it becomes a no-op).
//
// Usage: node scripts/with-env.mjs <command> [args...]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

let dir = process.cwd();
while (true) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break; // reached filesystem root, no .env found
  dir = parent;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('with-env.mjs: no command given');
  process.exit(1);
}

const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
if (result.error) {
  console.error(`with-env.mjs: failed to run "${command}":`, result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
