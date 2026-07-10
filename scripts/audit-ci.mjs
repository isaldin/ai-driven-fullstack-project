#!/usr/bin/env node
// Dependency-audit gate for CI.
//
//   node scripts/audit-ci.mjs                 # prod deps, block >= high
//   node scripts/audit-ci.mjs --dev           # include dev deps (triage build risk)
//   node scripts/audit-ci.mjs --level moderate
//
// Wraps `pnpm audit --json` and applies policy the raw command can't:
//   - blocks on any advisory at/above the level (default: high) in scope;
//   - suppresses advisories listed as ACTIVE (non-expired) in
//     .security/exceptions.yaml — an expired/invalid exception is already a hard
//     failure via scripts/check-security-exceptions.mjs;
//   - distinguishes a registry/network OUTAGE (audit could not run) from a clean
//     "0 findings" result — an outage is NOT a pass.
//
// Exit codes: 0 = clean (or fully excepted), 1 = un-excepted findings, 2 = audit
// could not be completed (outage) — CI should treat 2 as a failed check too, but
// the distinct code lets an operator tell "vulnerable" from "couldn't check".
import { spawnSync } from 'node:child_process';
import { loadActiveExceptions } from './check-security-exceptions.mjs';

const args = process.argv.slice(2);
const includeDev = args.includes('--dev');
const levelIdx = args.indexOf('--level');
const level = levelIdx >= 0 ? args[levelIdx + 1] : 'high';

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const threshold = SEVERITY_RANK[level] ?? SEVERITY_RANK.high;

const auditArgs = ['audit', '--json'];
if (!includeDev) auditArgs.push('--prod');

const res = spawnSync('pnpm', auditArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// A non-zero exit from pnpm audit means "found something" (expected) OR the
// command itself failed. Parse stdout; if it isn't JSON, treat as an outage.
let report;
try {
  report = JSON.parse(res.stdout || '{}');
} catch {
  console.error('✗ audit could not be completed (no parseable report — registry/network outage?).');
  if (res.stderr) console.error(res.stderr.trim().split('\n').slice(-5).join('\n'));
  process.exit(2);
}

// pnpm audit --json shape: { advisories: { <id>: {...} }, metadata: { vulnerabilities: {...} } }
const advisories = report.advisories ?? {};
const active = new Set(loadActiveExceptions());

const findings = Object.values(advisories).filter(
  (a) => (SEVERITY_RANK[a.severity] ?? 0) >= threshold,
);

const blocking = [];
const excepted = [];
for (const a of findings) {
  const ghsa = a.github_advisory_id || a.url?.split('/').pop() || a.cves?.[0] || String(a.id);
  const ids = [ghsa, a.github_advisory_id, ...(a.cves ?? [])].filter(Boolean);
  if (ids.some((id) => active.has(id))) excepted.push({ a, ghsa });
  else blocking.push({ a, ghsa });
}

for (const { a, ghsa } of excepted) {
  console.log(
    `• excepted: ${a.severity.toUpperCase()} ${a.module_name} — ${ghsa} (see .security/exceptions.yaml)`,
  );
}

if (blocking.length === 0) {
  console.log(
    `✓ dependency audit clean at level "${level}"${includeDev ? ' (incl. dev)' : ' (prod)'}.`,
  );
  process.exit(0);
}

console.error(`✗ ${blocking.length} un-excepted advisory(ies) at/above "${level}":`);
for (const { a, ghsa } of blocking) {
  console.error(
    `  - ${a.severity.toUpperCase()} ${a.module_name} ${a.vulnerable_versions ?? ''} — ${ghsa}`,
  );
  if (a.url) console.error(`      ${a.url}`);
}
process.exit(1);
