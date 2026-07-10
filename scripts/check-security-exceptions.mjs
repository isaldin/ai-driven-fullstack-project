#!/usr/bin/env node
// Validate .security/exceptions.yaml and (optionally) emit ignore lists for the
// audit / image-scan gates.
//
//   node scripts/check-security-exceptions.mjs            # validate only (CI gate)
//   node scripts/check-security-exceptions.mjs --write-trivyignore
//
// Rules (see .security/exceptions.yaml header):
//   - required non-empty fields: advisory, component, severity, reason,
//     compensating_controls, owner, created, expires;
//   - severity in {critical, high, moderate, low};
//   - created/expires are YYYY-MM-DD and parse to real dates;
//   - expires is in the future (expired => fail);
//   - high/critical exceptions may not exceed 30 days from `created`;
//   - no duplicate advisory ids.
//
// Exit 1 on any violation (so an unowned / expired / over-long exception turns CI
// red). Also usable as a module: `import { loadActiveExceptions } from ...`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Path override exists for tests; CI uses the default committed file.
const EXCEPTIONS_PATH =
  process.env.SECURITY_EXCEPTIONS_PATH || join(repoRoot, '.security', 'exceptions.yaml');
const TRIVYIGNORE_PATH = join(repoRoot, '.trivyignore');

const REQUIRED_FIELDS = [
  'advisory',
  'component',
  'severity',
  'reason',
  'compensating_controls',
  'owner',
  'created',
  'expires',
];
const SEVERITIES = new Set(['critical', 'high', 'moderate', 'low']);
const MAX_HIGH_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a YYYY-MM-DD string to a UTC Date, or null if malformed. */
function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read + parse the exceptions file, returning the raw list (never throws on empty). */
function readExceptions() {
  if (!existsSync(EXCEPTIONS_PATH)) return [];
  const doc = parse(readFileSync(EXCEPTIONS_PATH, 'utf8')) ?? {};
  const list = doc.exceptions ?? [];
  if (!Array.isArray(list)) {
    throw new Error('.security/exceptions.yaml: `exceptions` must be a list');
  }
  return list;
}

/** Validate every entry; returns { errors: string[], entries }. */
export function validateExceptions(now = new Date()) {
  const errors = [];
  let entries;
  try {
    entries = readExceptions();
  } catch (e) {
    return { errors: [e.message], entries: [] };
  }

  const seen = new Set();
  entries.forEach((entry, i) => {
    const at = `exceptions[${i}]`;
    if (entry === null || typeof entry !== 'object') {
      errors.push(`${at}: must be a mapping`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      const v = entry[field];
      if (v === undefined || v === null || String(v).trim() === '') {
        errors.push(`${at}: missing required field "${field}"`);
      }
    }
    const id = entry.advisory ? String(entry.advisory) : `#${i}`;
    if (entry.advisory) {
      if (seen.has(entry.advisory)) errors.push(`${at}: duplicate advisory ${id}`);
      seen.add(entry.advisory);
    }
    if (entry.severity && !SEVERITIES.has(String(entry.severity).toLowerCase())) {
      errors.push(`${at} (${id}): invalid severity "${entry.severity}"`);
    }
    const created = parseDate(entry.created);
    const expires = parseDate(entry.expires);
    if (entry.created && !created) errors.push(`${at} (${id}): created must be YYYY-MM-DD`);
    if (entry.expires && !expires) errors.push(`${at} (${id}): expires must be YYYY-MM-DD`);
    if (expires && expires.getTime() <= now.getTime()) {
      errors.push(
        `${at} (${id}): expired on ${entry.expires} — fix the finding or renew with justification`,
      );
    }
    if (created && expires) {
      const days = Math.round((expires.getTime() - created.getTime()) / DAY_MS);
      const sev = String(entry.severity).toLowerCase();
      if ((sev === 'high' || sev === 'critical') && days > MAX_HIGH_DAYS) {
        errors.push(`${at} (${id}): ${sev} exception spans ${days}d — max is ${MAX_HIGH_DAYS}d`);
      }
      if (days <= 0) errors.push(`${at} (${id}): expires must be after created`);
    }
  });

  return { errors, entries };
}

/** Advisory ids for exceptions that are currently valid (not expired). */
export function loadActiveExceptions(now = new Date()) {
  const { entries } = validateExceptions(now);
  return entries
    .filter((e) => {
      const expires = parseDate(e?.expires);
      return e?.advisory && expires && expires.getTime() > now.getTime();
    })
    .map((e) => String(e.advisory));
}

function main() {
  const args = process.argv.slice(2);
  const { errors, entries } = validateExceptions();

  if (errors.length > 0) {
    console.error('✗ security exceptions invalid:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (args.includes('--write-trivyignore')) {
    const active = loadActiveExceptions();
    const body = active.length
      ? `# Generated from .security/exceptions.yaml — do not edit by hand.\n${active.join('\n')}\n`
      : '# No active security exceptions.\n';
    writeFileSync(TRIVYIGNORE_PATH, body);
    console.log(`✓ wrote .trivyignore (${active.length} active exception(s))`);
  }

  console.log(
    `✓ security exceptions valid (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
