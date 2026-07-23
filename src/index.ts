import { Command } from 'commander';
import { signupCommand } from './commands/signup.js';
import { authCommand } from './commands/auth.js';
import { mailboxCommand } from './commands/mailbox.js';
import { domainCommand } from './commands/domain.js';
import { sendCommand } from './commands/send.js';
import { inboxCommand } from './commands/inbox.js';
import { replyCommand } from './commands/reply.js';
import { recipientsCommand } from './commands/recipients.js';
import { accountCommand } from './commands/account.js';
import { apiKeyCommand } from './commands/api-key.js';
import { draftCommand } from './commands/draft.js';
import { suppressionsCommand } from './commands/suppressions.js';
import { inboundBlocklistCommand } from './commands/inbound-blocklist.js';
import { firewallReleaseCommand } from './commands/firewall-release.js';
import { legalHoldCommand } from './commands/legal-hold.js';
import { webhookCommand } from './commands/webhook.js';
import { simulateCommand } from './commands/simulate.js';
import { versionCommand } from './commands/version.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { policyCommand } from './commands/policy.js';
import { ApiError } from './types.js';
import { LocalCliError, getFriendlyHint, resolveAuthExitCode, EXIT } from './errors.js';
import { resolveCliVersion } from './build-metadata.js';
import { strictApiErrorExitCode } from './lib/strict-outcome.js';

// Version resolution is single-sourced in build-metadata.ts so commander's
// `--version` flag and the `version` subcommand can never drift. The SEA
// bundle substitutes the literal at build time; source mode reads
// package.json. See build-metadata.ts for the SEA/source gating rationale.
const packageJson = { version: resolveCliVersion() };

/**
 * Commander error codes → structured CLI error codes.
 *
 * The raw `commander_code` is also emitted in JSON output as a forensic
 * escape hatch — if commander minor-bumps and adds new codes, unmapped
 * codes fall back to `CLI_ERROR` but the raw value is still visible.
 * `commander-errors.test.ts` is the canary.
 */
const COMMANDER_CODE_MAP: Record<string, string> = {
  'commander.missingMandatoryOptionValue': 'MISSING_REQUIRED_OPTION',
  'commander.missingArgument': 'MISSING_REQUIRED_ARGUMENT',
  'commander.unknownOption': 'UNKNOWN_OPTION',
  'commander.unknownCommand': 'UNKNOWN_COMMAND',
  'commander.invalidArgument': 'INVALID_OPTION',
  'commander.invalidOptionArgument': 'INVALID_OPTION',
  'commander.optionMissingArgument': 'MISSING_REQUIRED_OPTION',
};

/**
 * Module-scoped JSON-mode flag set by `run()` before any commander
 * parsing. `program.configureOutput({ writeErr })` is registered before
 * commander binds the global --json flag, so reading `program.opts()`
 * inside writeErr would be stale; this flag is the single source of
 * truth for "did the caller ask for JSON?".
 *
 * Falls back to scanning process.argv so the helper also works for
 * out-of-band calls (e.g. tests that import createProgram() without
 * going through run()).
 */
let _jsonModeFlag = false;

/**
 * True iff --json was requested on argv. Used both by the `writeErr`
 * filter (registered before commander parses argv, so commander itself
 * hasn't bound the global flag yet) and by the catch block.
 */
function isJsonArgv(argv?: string[]): boolean {
  if (_jsonModeFlag) return true;
  if (argv && argv.includes('--json')) return true;
  return process.argv.includes('--json');
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('rly')
    .description('ReplyLayer CLI — email for AI agents')
    .version(packageJson.version)
    .option(
      '--api-url <url>',
      'API base URL (env: REPLYLAYER_API_URL)',
      process.env.REPLYLAYER_API_URL || 'https://api.replylayer.ai',
    )
    .option('--api-key <key>', 'API key (overrides stored credential)')
    .option('--json', 'Output JSON instead of formatted text', false);

  // Register commands
  program.addCommand(signupCommand());
  program.addCommand(authCommand());
  program.addCommand(domainCommand());
  program.addCommand(mailboxCommand());
  program.addCommand(sendCommand());
  program.addCommand(inboxCommand());
  program.addCommand(replyCommand());
  program.addCommand(recipientsCommand());
  program.addCommand(accountCommand());
  program.addCommand(policyCommand());
  program.addCommand(apiKeyCommand());
  program.addCommand(draftCommand());
  program.addCommand(suppressionsCommand());
  program.addCommand(inboundBlocklistCommand());
  program.addCommand(firewallReleaseCommand());
  program.addCommand(legalHoldCommand());
  program.addCommand(webhookCommand());
  program.addCommand(simulateCommand());
  program.addCommand(versionCommand());
  program.addCommand(configCommand());
  program.addCommand(doctorCommand());

  // Suppress commander's plain-text stderr under --json so the catch
  // block in run() can emit the single structured object instead.
  // Non-JSON mode passes through verbatim — commander's outputError()
  // writes its own human message before throwing, and the catch block
  // does NOT double-print (verified at commander/lib/command.js:1942).
  //
  // `addCommand()` does NOT copy outputConfiguration OR the
  // exitOverride callback to children (verified at
  // commander/lib/command.js:288 — unlike `.command()` at line 176
  // which calls `copyInheritedSettings` after registering). We
  // therefore configure each subcommand explicitly via a tree walk so
  // both `--json` suppression AND the thrown-CommanderError contract
  // hold for errors at any nesting level (e.g. `auth login`,
  // `mailbox allowlist add`).
  applyJsonAwareOutputAndExitOverride(program);

  return program;
}

/**
 * Recursively apply our JSON-aware outputConfiguration AND the
 * exitOverride contract to a command and all its registered
 * subcommands. Mirrors what `.command()` does via
 * `copyInheritedSettings`, but for the `.addCommand()` graph.
 *
 * The `as unknown as { commands?: Command[] }` cast is the only such
 * cast in this file — commander doesn't expose `.commands` on its
 * public typings even though it has been part of the runtime API
 * since 1.x.
 */
function applyJsonAwareOutputAndExitOverride(cmd: Command): void {
  cmd.configureOutput({
    writeErr: (str: string) => {
      if (isJsonArgv()) return;
      process.stderr.write(str);
    },
  });
  cmd.exitOverride();
  const children = (cmd as unknown as { commands?: Command[] }).commands ?? [];
  for (const child of children) {
    applyJsonAwareOutputAndExitOverride(child);
  }
}

export async function run(argv?: string[]): Promise<void> {
  // Stash --json early so the writeErr filter (registered inside
  // createProgram) sees the right value regardless of process.argv.
  // Mirror behavior on the catch path via the local `jsonMode` variable.
  const resolvedArgv = argv || process.argv;
  _jsonModeFlag = resolvedArgv.includes('--json');
  const jsonMode = _jsonModeFlag;
  const program = createProgram();

  try {
    await program.parseAsync(resolvedArgv);
  } catch (err) {
    if (err instanceof ApiError) {
      if (jsonMode) {
        // SP4-HINT-001: carry the friendly hint into --json errors so agents
        // (the primary --json consumers) get the same guidance the human
        // branch renders. Drop the leading blank-line spacer entries.
        const friendlyHint =
          getFriendlyHint(err)
            ?.filter((l) => l.trim())
            .join(' ') || undefined;
        console.error(
          JSON.stringify(
            {
              error: err.message,
              code: err.code,
              details: err.details,
              ...(err.conflictingMailbox
                ? { conflicting_mailbox: err.conflictingMailbox }
                : {}),
              ...(friendlyHint ? { hint: friendlyHint } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`Error: ${err.message}`);
        if (err.code) {
          console.error(`Code: ${err.code}`);
        }
        const hint = getFriendlyHint(err);
        if (hint) hint.forEach((line) => console.error(line));
        if (err.conflictingMailbox) {
          console.error(
            `Conflicting mailbox: ${err.conflictingMailbox.name} ` +
              `<${err.conflictingMailbox.full_address}> (${err.conflictingMailbox.id})`,
          );
        }
        if (err.details && Object.keys(err.details).length > 0) {
          console.error(`Details: ${JSON.stringify(err.details)}`);
        }
      }
      // SP-1 (RL-UAT-024/026): set process.exitCode + return instead of a
      // synchronous process.exit(). Letting run() resolve drains the event
      // loop, closing any lingering keepalive socket cleanly before Node
      // exits with this code — removing the Windows libuv "exit mid-close"
      // race (Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)).
      // resolveAuthExitCode keeps the historical `1` unless the caller opted
      // into the distinct auth code (REPLYLAYER_AUTH_EXIT_CODE=1) and this is
      // a 401 — default behavior is unchanged.
      //
      // Track 2 (Governed Email-Effect Contract v1) — `rly send --strict` /
      // `rly reply --strict` forwards `Prefer: outcome=strict`, so the server
      // maps a non-delivered outcome to a 422/409/503 carrying email_effect in
      // details. Map that to the strict exit codes (blocked→4, infra→5; a
      // held_for_review 409 is releasable → 0). This is self-gating: details
      // only carries email_effect when the request opted into strict mode, so a
      // non-strict caller's errors are never remapped.
      const strictExit = strictApiErrorExitCode(err);
      process.exitCode =
        strictExit !== null ? strictExit : resolveAuthExitCode(err, EXIT.FAILURE);
      return;
    }

    // Local CLI errors (validation, mutual-exclusion, lookup failures,
    // interactive aborts, terms-not-accepted). Mirrors the ApiError
    // branch above so `--json` callers always get a structured object.
    if (err instanceof LocalCliError) {
      if (jsonMode) {
        // SP4-HINT-001: mirror the ApiError --json branch — surface the
        // friendly hint so --json callers get the same guidance.
        const friendlyHint =
          getFriendlyHint(err)
            ?.filter((l) => l.trim())
            .join(' ') || undefined;
        console.error(
          JSON.stringify(
            {
              error: err.message,
              code: err.code,
              details: err.details,
              ...(friendlyHint ? { hint: friendlyHint } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`Error: ${err.message}`);
        console.error(`Code: ${err.code}`);
        const hint = getFriendlyHint(err);
        if (hint) hint.forEach((line) => console.error(line));
        if (err.details && Object.keys(err.details).length > 0) {
          console.error(`Details: ${JSON.stringify(err.details)}`);
        }
      }
      // SP-1 (RL-UAT-024/026): drain-then-exit (see ApiError branch above).
      // resolveAuthExitCode keeps err.exitCode unless the opt-in auth code is
      // enabled and this is API_KEY_REQUIRED.
      process.exitCode = resolveAuthExitCode(err, err.exitCode);
      return;
    }

    // Commander errors (help, version, missing required option, unknown
    // command, etc.). Read `CommanderError.code` directly — no stderr
    // parsing. The `writeErr` filter above already suppressed
    // commander's own stderr under --json; non-JSON mode let it through.
    // In non-JSON mode we MUST NOT write a second "Error: ..." line —
    // commander's outputError() already wrote its message before throwing
    // (verified at commander/lib/command.js:1942). Just exit.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      'exitCode' in err
    ) {
      const ce = err as { code: string; exitCode: number; message: string };
      // commander.help and commander.version use exitCode=0; pass through.
      if (ce.exitCode === 0) {
        process.exit(0);
      }
      if (jsonMode) {
        const mappedCode = COMMANDER_CODE_MAP[ce.code] ?? 'CLI_ERROR';
        console.error(
          JSON.stringify(
            {
              error: ce.message,
              code: mappedCode,
              commander_code: ce.code,
            },
            null,
            2,
          ),
        );
      }
      // SP-1 (RL-UAT-024/026): drain-then-exit (see ApiError branch above).
      // Every nonzero commander error is a parse/usage failure (unknown
      // command/option, missing required option/argument, invalid argument) —
      // commander's own exitCode for these is `1`, but the machine-interface
      // contract (docs/cli-machine-interface.md) maps local usage errors to
      // EXIT.USAGE. help/version (exitCode 0) already returned above.
      process.exitCode = EXIT.USAGE;
      return;
    }

    // Unknown errors
    console.error(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    // SP-1 (RL-UAT-024/026): drain-then-exit (see ApiError branch above).
    // The trailing return is the last statement of run().
    process.exitCode = 1;
    return;
  }
}

// Re-exports for programmatic use
export { ApiClient } from './api-client.js';
export { ApiError } from './types.js';
export type { ApiClientOptions } from './api-client.js';
