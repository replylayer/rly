#!/usr/bin/env node
// PUBLIC layer of the two-layer README contract. The root README is npm's
// README: it must carry the full consumer contract (install truth, quickstart,
// auth/bootstrap, agent --json/exit/--strict semantics, inbox cursor example)
// alongside the trust/verification material — and must never regress into the
// npm↔native-binary conflation.
//
// This copy holds only publishable generic rules. The canonical upstream runs a
// stricter private parity layer; the shared fixtures under
// .github/fixtures/readme-contract/ are committed in BOTH places so the two
// copies cannot silently drift — a rule change must land in both, with
// fixtures, or one side's CI fails.
//
// Usage:
//   node .github/scripts/check-readme-contract.mjs README.md
//   node .github/scripts/check-readme-contract.mjs --fixtures .github/fixtures/readme-contract

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const REQUIRED_ANCHORS = [
  { id: 'product-scope', all: [/safe email for AI agents/i, /not a bulk/i] },
  { id: 'npm-install-truth', all: [/npm i(?:nstall)? -g rly/, /Node\.js 22/] },
  { id: 'pypi-install-truth', all: [/pipx install rly/, /no Node toolchain/i] },
  { id: 'quickstart', all: [/## Quickstart/, /rly doctor --json/, /simulator\.replylayer\.net/, /`status`/] },
  { id: 'auth', all: [/## Auth/, /REPLYLAYER_API_KEY/, /rly auth login/, /auth verify/] },
  { id: 'agent-contract', all: [/--json/, /[Ee]xit/, /--strict/] },
  { id: 'inbox-cursor', all: [/inbox wait/, /--since/] },
  { id: 'verification', all: [/SHA256SUMS/, /KEYS\.txt/] },
  { id: 'security-contact', all: [/security@replylayer\.ai/] },
  { id: 'source-status', all: [/## Source/] },
  { id: 'langchain-mirror', all: [/langchain-python/, /langchain-replylayer/] },
];

export const FORBIDDEN_PHRASES = [
  { re: /no Node requirement/i, why: 'npm install requires host Node 22+' },
  { re: /carries its own runtime/i, why: 'only PyPI wheels / winget bundle a runtime; name the artifact' },
  { re: /ship(?:s|ped)? inside (?:the )?npm/i, why: 'native binaries ship inside the PyPI wheels only' },
];

export function checkCommonRules(readme) {
  // Both rule sets run against whitespace-normalized text so a prose reflow
  // can neither break a required anchor nor hide a forbidden phrase across a
  // line break.
  const flat = readme.replace(/\s+/g, ' ');
  const violations = [];
  for (const { id, all } of REQUIRED_ANCHORS) {
    for (const re of all) {
      if (!re.test(flat)) violations.push(`missing-anchor:${id}: /${re.source}/ not found`);
    }
  }
  for (const { re, why } of FORBIDDEN_PHRASES) {
    if (re.test(flat)) violations.push(`forbidden: /${re.source}/ — ${why}`);
  }
  return violations;
}

export async function runFixtures(dir) {
  const failures = [];
  const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  if (entries.length === 0) failures.push(`no fixtures found in ${dir}`);
  for (const f of entries) {
    const body = await fs.readFile(path.join(dir, f), 'utf8');
    const violations = checkCommonRules(body);
    if (f.startsWith('pass-') && violations.length > 0) {
      failures.push(`${f}: expected PASS but got: ${violations.join('; ')}`);
    } else if (f.startsWith('fail-') && violations.length === 0) {
      failures.push(`${f}: expected FAIL but the common rules found nothing`);
    } else if (!f.startsWith('pass-') && !f.startsWith('fail-')) {
      failures.push(`${f}: fixture names must start with pass- or fail-`);
    }
  }
  return failures;
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--fixtures') {
    const failures = await runFixtures(path.resolve(args[1] ?? '.github/fixtures/readme-contract'));
    if (failures.length) {
      console.error('✗ readme-contract fixture self-test FAILED:');
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log('✓ readme-contract fixture self-test passed');
  } else {
    const readmePath = args[0] ?? 'README.md';
    const violations = checkCommonRules(await fs.readFile(path.resolve(readmePath), 'utf8'));
    if (violations.length) {
      console.error(`✗ README contract FAILED (${violations.length}):`);
      for (const v of violations) console.error(`  ${v}`);
      process.exit(1);
    }
    console.log('✓ README carries the required consumer/trust contract');
  }
}
