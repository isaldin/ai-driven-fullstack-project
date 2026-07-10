#!/usr/bin/env node
// Upgrade migration gate: prove the PREVIOUS release's schema upgrades cleanly to
// the current one via committed migrations (not just fresh installs).
//
//   1. resolve the previous release ref (latest tag before HEAD, else HEAD~1);
//   2. check out ONLY that ref's migrations dir and `zen migrate deploy` it onto
//      an empty database;
//   3. restore the current migrations and `zen migrate deploy` the new ones on top;
//   4. `zen migrate status` must report the DB in sync.
//
// A broken, missing or edited migration makes step 2/3/4 fail. When no previous
// ref exists (single-commit repo) it degenerates to a fresh apply — still a valid
// gate. Requires DATABASE_URL in the environment (the CI job provides it).
import { execSync } from 'node:child_process';

const MIGRATIONS = 'apps/backend/src/zenstack/migrations';
const MIGRATE = 'pnpm --filter @app/backend db:migrate';
const STATUS =
  'pnpm --filter @app/backend exec zen migrate status --schema src/zenstack/schema.zmodel';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const capture = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

/** Latest release tag before HEAD, else the previous commit, else null. */
function previousRef() {
  const tag = capture('git describe --tags --abbrev=0 HEAD^');
  if (tag) return tag;
  const commit = capture('git rev-parse --verify --quiet HEAD~1');
  return commit || null;
}

function hasMigrationsAt(ref) {
  const listed = capture(`git ls-tree ${ref} -- ${MIGRATIONS}`);
  return listed.length > 0;
}

const prev = previousRef();

if (!prev || !hasMigrationsAt(prev)) {
  console.log(
    prev
      ? `• previous ref ${prev} has no migrations — treating as empty baseline (fresh apply)`
      : '• no previous ref (single-commit repo) — fresh apply as the upgrade baseline',
  );
  run(MIGRATE);
} else {
  console.log(`• previous release ref: ${prev}`);
  console.log('• applying previous-release migrations onto an empty database…');
  run(`git checkout ${prev} -- ${MIGRATIONS}`);
  try {
    run(MIGRATE);
  } finally {
    // Always restore the current migrations, even if the previous apply failed.
    run(`git checkout HEAD -- ${MIGRATIONS}`);
  }
  console.log('• applying current-release migrations on top…');
  run(MIGRATE);
}

console.log('• verifying migration history is in sync…');
run(STATUS);
console.log('✓ upgrade migration gate passed');
