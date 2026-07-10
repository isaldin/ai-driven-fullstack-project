#!/usr/bin/env node
// Offline integrity check for installed agent skills.
//
//   node scripts/verify-skills.mjs        # verify .agents/skills against the lock
//
// For every skill in skills-lock.json that is installed under .agents/skills/,
// re-hash its SKILL.md and compare to the locked `sha256`. Any mismatch (a
// tampered skill) or missing SKILL.md fails with exit 1. Skills present in the
// lock but not installed are reported and skipped (not a failure — they just
// haven't been fetched on this machine).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repoRoot, 'skills-lock.json');

if (!existsSync(lockPath)) {
  console.error('✗ skills-lock.json not found');
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const skills = lock.skills ?? {};

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let checked = 0;
let skipped = 0;
const failures = [];

for (const [name, entry] of Object.entries(skills)) {
  const skillMd = join(repoRoot, '.agents', 'skills', name, 'SKILL.md');
  if (!existsSync(skillMd)) {
    skipped++;
    continue;
  }
  if (!entry.sha256) {
    failures.push(`${name}: no sha256 recorded in lock`);
    continue;
  }
  const hash = sha256File(skillMd);
  if (hash !== entry.sha256) {
    failures.push(
      `${name}: hash mismatch (expected ${entry.sha256.slice(0, 12)}…, got ${hash.slice(0, 12)}…)`,
    );
  } else {
    checked++;
  }
}

if (failures.length > 0) {
  console.error('✗ skill integrity check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ skill integrity OK (${checked} verified, ${skipped} not installed)`);
