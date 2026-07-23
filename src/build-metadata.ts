import { createRequire } from 'node:module';

/**
 * Build/version metadata for `rly version --json` (plan M1.3).
 *
 * The symbols below are esbuild `--define` injection points. The SEA build
 * applies its `define` map globally across the whole bundle (see
 * packages/cli/scripts/build-sea.mjs → esbuild `define`), so any module that
 * references these names receives the substituted literal.
 *
 * Only `__BUNDLED_VERSION__` is injected today. The `__BUILD_*__` symbols are
 * reserved for the Milestone-1 CI plumbing slice (GITHUB_SHA → commit,
 * parse-tag is_rc → channel, matrix entry → artifact_name, build timestamp →
 * build_time). Until that lands they are undefined at runtime, so a
 * source-mode build reports `dev` / `unknown` — NEVER a misleading `stable`.
 *
 * The `typeof <symbol> !== 'undefined'` guard is the portable pattern: an
 * undeclared global yields the string "undefined" rather than a
 * ReferenceError, so the same code works both in tsc/source mode (symbols
 * absent) and in the SEA bundle (esbuild substituted literals). The
 * createRequire fallback MUST stay gated behind that guard — `import.meta.url`
 * is undefined in the CJS bundle and createRequire throws
 * ERR_INVALID_ARG_VALUE there.
 */
declare const __BUNDLED_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_CHANNEL__: string | undefined;
declare const __BUILD_TIME__: string | undefined;
declare const __BUILD_ARTIFACT__: string | undefined;

export type BuildChannel = 'dev' | 'rc' | 'stable';
export type CliRuntime = 'node-sea' | 'node-source';

export interface BuildMetadata {
  version: string;
  /** Git commit the binary was built from; `unknown` in source mode. */
  commit: string;
  /** ISO build timestamp, or null when not embedded (source mode / opt-in). */
  build_time: string | null;
  channel: BuildChannel;
  os: NodeJS.Platform;
  arch: string;
  runtime: CliRuntime;
  node_version: string;
  /** Release asset name the binary shipped as, or null in source mode. */
  artifact_name: string | null;
}

/** True when running from the SEA bundle (esbuild substituted the version). */
export function isBundled(): boolean {
  return typeof __BUNDLED_VERSION__ !== 'undefined';
}

/**
 * Resolve the CLI version, single-sourced for both commander's `--version`
 * flag (src/index.ts) and the `version` subcommand so they can never drift.
 * In the SEA bundle the version is an esbuild literal; in source mode it is
 * read from package.json.
 */
export function resolveCliVersion(): string {
  if (typeof __BUNDLED_VERSION__ !== 'undefined') {
    return __BUNDLED_VERSION__;
  }
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}

function normalizeChannel(raw: string | undefined): BuildChannel {
  // Only the two CI-set channels are trusted; everything else (including an
  // un-injected source build) is `dev`. This is the guard that prevents a
  // source-mode build from ever claiming `stable`.
  if (raw === 'stable' || raw === 'rc') return raw;
  return 'dev';
}

export function buildMetadata(): BuildMetadata {
  return {
    version: resolveCliVersion(),
    commit:
      typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
    build_time:
      typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null,
    channel: normalizeChannel(
      typeof __BUILD_CHANNEL__ !== 'undefined' ? __BUILD_CHANNEL__ : undefined,
    ),
    os: process.platform,
    arch: process.arch,
    runtime: isBundled() ? 'node-sea' : 'node-source',
    node_version: process.version,
    artifact_name:
      typeof __BUILD_ARTIFACT__ !== 'undefined' ? __BUILD_ARTIFACT__ : null,
  };
}
