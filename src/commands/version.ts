import { Command } from 'commander';
import { buildMetadata } from '../build-metadata.js';

/**
 * `rly version [--json]` (plan M1.3).
 *
 * Bare output is intentionally identical to `rly --version`: a single
 * version line. `--json` emits the full build-metadata object (version,
 * commit, channel, os, arch, runtime, node_version, build_time,
 * artifact_name) for machine consumers.
 */
export function versionCommand(): Command {
  return new Command('version')
    .description('Show the CLI version (full build metadata with --json)')
    .action((_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const meta = buildMetadata();
      if (opts.json) {
        console.log(JSON.stringify(meta, null, 2));
      } else {
        console.log(meta.version);
      }
    });
}
