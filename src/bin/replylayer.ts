#!/usr/bin/env node
//
// Pre-import Node-version guard (ONB-EC-04). This file MUST stay dependency-
// free until the guard has run: the side-effect import of ../http-dispatcher.js
// loads undici (Node >=20.18.1) and crashes with a raw ReferenceError on Node
// 18 before ReplyLayer can format a helpful error. We version-check FIRST, then
// reach http-dispatcher.js / index.js only via dynamic import().
//
// This file backs BOTH published bin names — `rly` and the deprecated
// `replylayer` alias both resolve here (package.json `bin`) — and the `dev`
// script (`tsx src/bin/replylayer.ts`) runs the same source.

const MIN_NODE_MAJOR = 22;

function isJsonMode(argv: string[]): boolean {
  // Mirror index.ts's isJsonArgv() so JSON callers get a structured object.
  return argv.includes('--json');
}

/** Parse the major version, tolerating a leading `v` (e.g. "v18.19.1" → 18). */
function nodeMajor(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

/**
 * Version to evaluate. RLY_FORCE_NODE_VERSION is a TEST-ONLY hook (honored only
 * under NODE_ENV=test) so the unsupported branch is provable in CI without a
 * real Node 18 binary. It can never trip a real user's runtime.
 */
function currentNodeVersion(): string {
  if (process.env.NODE_ENV === 'test' && process.env.RLY_FORCE_NODE_VERSION) {
    return process.env.RLY_FORCE_NODE_VERSION;
  }
  return process.version;
}

function requireSupportedNode(argv: string[]): boolean {
  const current = currentNodeVersion();
  const major = nodeMajor(current);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return true;

  const required = `>=${MIN_NODE_MAJOR}`;
  // One shared, identical actionable line for human + JSON (single source of
  // guidance, matching the getFriendlyHint() convention in errors.ts).
  const hint =
    'Upgrade Node.js, or install without a Node toolchain via: pipx install rly';

  if (isJsonMode(argv)) {
    console.error(
      JSON.stringify(
        {
          error: 'Unsupported Node.js version',
          code: 'UNSUPPORTED_NODE_VERSION',
          details: { required, current },
          hint,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(
      `ReplyLayer CLI requires Node.js ${MIN_NODE_MAJOR} or newer. Current Node is ${current}.`,
    );
    console.error(hint);
  }

  // EXIT.USAGE (2) — local usage/configuration error per errors.ts +
  // docs/cli-machine-interface.md. Hardcoded as a literal to keep this file
  // import-free before the guard; the test pins it to EXIT.USAGE.
  process.exitCode = 2;
  return false;
}

async function main(): Promise<void> {
  if (!requireSupportedNode(process.argv)) return;

  // http-dispatcher installs the keepAlive-off global undici Agent and MUST
  // precede index.js (the SP-1 Windows-stability fix).
  await import('../http-dispatcher.js');
  const { run } = await import('../index.js');
  await run();
}

void main().catch((err) => {
  // run() never rejects (it converts every error to process.exitCode), so this
  // only fires if a dynamic import itself fails. Don't clobber an exit code a
  // future throwing run() may already have set.
  console.error(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  if (!process.exitCode) process.exitCode = 1;
});
