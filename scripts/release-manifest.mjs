#!/usr/bin/env node
// Emit a release manifest (JSON on stdout) that binds a commit to the exact
// image digests, the migration version, and SBOM references. Deploys pin these
// digests; rollback restores a previous manifest. Values come from the
// environment (the release workflow sets them):
//   RELEASE_TAG, RELEASE_SHA, BACKEND_IMAGE, FRONTEND_IMAGE, BOT_IMAGE
//
// The migration version is the newest committed migration directory name, so a
// manifest also records the schema state a rollback must be compatible with.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'apps', 'backend', 'src', 'zenstack', 'migrations');

function latestMigration() {
  try {
    return (
      readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

const required = ['BACKEND_IMAGE', 'FRONTEND_IMAGE', 'BOT_IMAGE'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`release-manifest: missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const manifest = {
  schema: 1,
  releaseTag: process.env.RELEASE_TAG ?? null,
  commitSha: process.env.RELEASE_SHA ?? null,
  // ISO timestamp is injected by the caller to keep this script deterministic.
  createdAt: process.env.RELEASE_CREATED_AT ?? null,
  images: {
    backend: process.env.BACKEND_IMAGE,
    frontend: process.env.FRONTEND_IMAGE,
    bot: process.env.BOT_IMAGE,
  },
  migrationVersion: latestMigration(),
  sbom: {
    backend: 'sbom-backend.cdx.json',
    inRegistryAttestation: true,
  },
};

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
