#!/usr/bin/env node
// Install the agent skills used by this template.
//
// Zero-dependency Node (matches scripts/with-env.mjs). Replaces install-skills.sh:
// non-interactive (`-y`, so it never hangs on the `skills` CLI prompt in CI), and —
// importantly — it does NOT duplicate skill content on disk:
//
//   .agents/skills/<name>   canonical store, real files. The .agents-convention
//                           agents (Codex, Gemini CLI, Kimi, OpenCode, Warp, ...)
//                           read this directly.
//   .claude/skills/<name>   Claude Code reads here, so we MIRROR the canonical store
//                           as relative symlinks -> ../../.agents/skills/<name>
//                           (the same convention as the global ~/.claude/skills/).
//
// Idempotent: a skill already present in .agents/skills/ is not re-downloaded; the
// .claude/skills/ symlink is (re)created regardless. To force a fresh pull, delete
// .agents/skills/<name> (or use `npx skills update`).
//
// Source of truth for the list:
//   docs/superpowers/specs/2026-07-02-ai-ready-monorepo-template-design.md (## Skills)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalDir = join(repoRoot, '.agents', 'skills');
const claudeDir = join(repoRoot, '.claude', 'skills');
const lockPath = join(repoRoot, 'skills-lock.json');

// --- Integrity: pinned source + SKILL.md hash --------------------------------
// A skill is only activated (symlinked into .claude/skills) after its downloaded
// SKILL.md hash matches skills-lock.json. The lock records `sha256` per skill
// (trust-on-first-use: recorded on first trusted install, verified thereafter),
// plus the pinned `source` repo. A tampered SKILL.md fails the hash check and is
// NOT activated.
const lock = existsSync(lockPath)
  ? JSON.parse(readFileSync(lockPath, 'utf8'))
  : { version: 1, skills: {} };
lock.skills ??= {};
let lockDirty = false;

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Verify a downloaded/present skill against the lock. Returns true if it is safe
 * to activate. On first sight of a skill it records the hash (TOFU) and passes.
 */
function verifyIntegrity(skill, repo, canonical) {
  const skillMd = join(canonical, 'SKILL.md');
  if (!existsSync(skillMd)) {
    console.error(`  ✗ ${skill}: no SKILL.md found — refusing to activate`);
    return false;
  }
  const hash = sha256File(skillMd);
  lock.skills[skill] ??= {};
  const entry = lock.skills[skill];

  // Pinned source: the lock's source must match the requested repo.
  if (entry.source && entry.source !== repo) {
    console.error(`  ✗ ${skill}: source mismatch (lock=${entry.source}, requested=${repo})`);
    return false;
  }
  if (!entry.source) {
    entry.source = repo;
    lockDirty = true;
  }

  if (entry.sha256) {
    if (entry.sha256 !== hash) {
      console.error(
        `  ✗ ${skill}: SKILL.md hash mismatch — expected ${entry.sha256.slice(0, 12)}…, ` +
          `got ${hash.slice(0, 12)}… (tampered/changed) — NOT activated`,
      );
      return false;
    }
    return true;
  }

  // Trust on first use: record the hash for future verification.
  entry.sha256 = hash;
  lockDirty = true;
  console.log(`  • ${skill}: recorded integrity hash (first install)`);
  return true;
}

// [github repo (owner/name), skill name]
const skills = [
  ['ccheney/robust-skills', 'clean-ddd-hexagonal'],
  ['kadajett/agent-nestjs-skills', 'nestjs-best-practices'],
  ['wshobson/agents', 'nodejs-backend-patterns'],
  ['mrgoonie/claudekit-skills', 'backend-development'],
  ['hyf0/vue-skills', 'vue-best-practices'],
  ['claude-office-skills/skills', 'telegram-bot'],
  ['jeffallan/claude-skills', 'devops-engineer'],
  ['jeffallan/claude-skills', 'architecture-designer'],
  ['zenstackhq/skills', 'zenstack-project-setup'],
  ['zenstackhq/skills', 'zenstack-schema-modeling'],
  ['zenstackhq/skills', 'zenstack-access-control'],
  ['zenstackhq/skills', 'zenstack-querying'],
  ['zenstackhq/skills', 'zenstack-crud-server'],
  ['zenstackhq/skills', 'zenstack-db-migration'],
  ['aj-geddes/useful-ai-prompts', 'ansible-automation'],
  // Observability (OpenTelemetry). otel-instrumentation: Node/browser SDK, spans/metrics/logs,
  // resources, sensitive-data. otel-collector: pipelines/processors/sampling/RED metrics.
  // Advisory concept guidance — NOT a replacement for our programmatic SDK bootstrap
  // (packages/observability/src/otel.ts); see AGENTS.md.
  ['dash0hq/agent-skills', 'otel-instrumentation'],
  ['dash0hq/agent-skills', 'otel-collector'],
];

// `npx` is a shell shim on Windows. Pin the `skills` CLI version so an installer
// run is reproducible and a compromised newer CLI can't silently change behaviour.
const SKILLS_CLI_VERSION = '1.5.15';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
mkdirSync(claudeDir, { recursive: true });

const failures = [];
for (const [repo, skill] of skills) {
  const canonical = join(canonicalDir, skill);
  const link = join(claudeDir, skill);

  if (!existsSync(canonical)) {
    console.log(`\n▸ downloading ${skill}  (${repo})`);
    // Run under Claude Code, the `skills` CLI drops the skill straight into
    // .claude/skills/<name> as a real copy — it does NOT populate the canonical
    // .agents/skills/ store on its own.
    const result = spawnSync(
      npx,
      [
        '--yes',
        `skills@${SKILLS_CLI_VERSION}`,
        'add',
        `https://github.com/${repo}`,
        '--skill',
        skill,
        '--agent',
        'claude-code',
        '-y',
      ],
      { stdio: 'inherit', cwd: repoRoot },
    );
    // Promote that copy into the canonical store so there's a single source of
    // truth (also readable by the .agents-convention agents). Same filesystem,
    // so rename is atomic and cheap.
    if (!existsSync(canonical) && existsSync(link) && !lstatSync(link).isSymbolicLink()) {
      mkdirSync(canonicalDir, { recursive: true });
      renameSync(link, canonical);
    }
    if (result.status !== 0 || !existsSync(canonical)) {
      failures.push(skill);
      continue;
    }
  } else {
    console.log(`\n▸ ${skill}  (present in .agents/skills — skipping download)`);
  }

  // Integrity gate: verify pinned source + SKILL.md hash BEFORE activation.
  // A tampered/mismatched skill is left in the canonical store for inspection
  // but is NOT symlinked into .claude/skills, so agents never load it.
  if (!verifyIntegrity(skill, repo, canonical)) {
    failures.push(skill);
    rmSync(link, { recursive: true, force: true });
    continue;
  }

  // Mirror into .claude/skills/ as a relative symlink; no content duplication.
  rmSync(link, { recursive: true, force: true });
  symlinkSync(`../../.agents/skills/${skill}`, link, 'dir');
}

// Persist any TOFU-recorded hashes / sources.
if (lockDirty) {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log('\n• updated skills-lock.json (recorded new integrity hashes)');
}

if (failures.length > 0) {
  console.error(`\n✗ Failed / not activated (integrity or download): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(
  `\n✓ ${skills.length} skills ready — .agents/skills/ (canonical) + .claude/skills/ (symlinks)`,
);
