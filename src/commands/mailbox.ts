import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { ApiClient } from '../api-client.js';
import { ensureConfirmed } from '../lib/confirm.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { resolveMailboxId } from '../resolve.js';
import { formatTable, output } from '../format.js';
import { parseIntOption } from './_validate.js';
import { ApiError } from '../types.js';
import type { ScannerPolicy, BulkAddResponse } from '../types.js';

/**
 * Parse the --emails option value: either a comma-separated list of addresses
 * or an @file path (one address per line). Returns a non-empty array.
 * Fails with LocalCliError (exit 2) on an empty list or when the cap is exceeded.
 */
export function parseEmailsOption(raw: string, cap: number = 1000): string[] {
  let emails: string[];
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      throw new LocalCliError(
        `Cannot read emails file '${filePath}': ${msg}`,
        'FILE_READ_ERROR',
        { path: filePath },
        2,
      );
    }
    emails = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } else {
    emails = raw.split(',').map((e) => e.trim()).filter(Boolean);
  }

  if (emails.length === 0) {
    throw new LocalCliError(
      '--emails must contain at least one address',
      'INVALID_OPTION',
      { option: '--emails' },
      2,
    );
  }

  if (emails.length > cap) {
    throw new LocalCliError(
      `--emails exceeds the ${cap}-entry cap (got ${emails.length})`,
      'INVALID_OPTION',
      { option: '--emails', count: emails.length, cap },
      2,
    );
  }

  return emails;
}

/**
 * Emit a bulk-add result. In JSON mode: prints the full partial-success object
 * via output(). In human mode: prints the counts summary + any invalid entries
 * with their reasons to stdout/stderr.
 */
function emitBulkResult(result: BulkAddResponse, jsonMode: boolean): void {
  if (jsonMode) {
    output(result, '', true);
    return;
  }
  const { counts, invalid } = result;
  console.log(
    `Bulk import: ${counts.added} added, ${counts.already_existed} already existed, ${counts.invalid} invalid (${counts.total} total)`,
  );
  if (invalid.length > 0) {
    console.error('Invalid entries:');
    for (const entry of invalid) {
      console.error(`  ${entry.email}: ${entry.reason}`);
    }
  }
}

function mergeScannerPolicy(current: ScannerPolicy | null | undefined, patch: ScannerPolicy): ScannerPolicy {
  const merged: ScannerPolicy = {
    ...(current ?? {}),
    ...patch,
  };

  if (current?.outbound_pii_policy || patch.outbound_pii_policy) {
    merged.outbound_pii_policy = {
      ...(current?.outbound_pii_policy ?? {}),
      ...(patch.outbound_pii_policy ?? {}),
    };
  }

  if (current?.outbound_review_policy || patch.outbound_review_policy) {
    merged.outbound_review_policy = {
      ...(current?.outbound_review_policy ?? {}),
      ...(patch.outbound_review_policy ?? {}),
    };
  }

  return merged;
}

export function mailboxCommand(): Command {
  const mailbox = new Command('mailbox').description('Manage mailboxes');

  mailbox.addCommand(createCommand());
  mailbox.addCommand(listCommand());
  mailbox.addCommand(deleteCommand());
  mailbox.addCommand(updateCommand());
  // Migration 036.
  mailbox.addCommand(setPolicyCommand());
  // Migration 085 — thread-scoped reply bypass toggle.
  mailbox.addCommand(setThreadRepliesCommand());
  // Single "agent sends" open/restricted control.
  mailbox.addCommand(setAgentSendsCommand());
  // Top-level mailbox detail (renders the derived agent-sends control).
  mailbox.addCommand(showCommand());
  // Per-mailbox policy verbs (design-review G1/G2/G4/G5/G3 + S1-SAFE).
  mailbox.addCommand(setHitlCommand());
  mailbox.addCommand(setPiiModeCommand());
  mailbox.addCommand(setSubaddressModeCommand());
  mailbox.addCommand(setAttachmentPolicyCommand());
  mailbox.addCommand(setRedactionCommand());
  mailbox.addCommand(attachmentPolicyCommand());
  mailbox.addCommand(allowlistCommand());
  // Migration 047 — inbound firewall.
  mailbox.addCommand(setSenderPolicyCommand());
  mailbox.addCommand(inboundAllowlistCommand());

  return mailbox;
}

// S2.4 — a paid account's first mailbox create can race its sending-domain
// provisioning (the server answers 409 DOMAIN_PROVISIONING_PENDING with a
// Retry-After while DNS verifies). The CLI absorbs that transient by
// default, retrying for up to 60s; `--no-wait` passes the 409 through for
// callers that manage their own retry loop.
const DOMAIN_PROVISIONING_WAIT_BUDGET_MS = 60_000;

function createCommand(): Command {
  return new Command('create')
    .description('Create a new mailbox')
    .argument('<name>', 'Mailbox name (e.g., support-bot)')
    .option('--imap-folder <folder>', 'Self-hosted IMAP folder to bind to this mailbox')
    .option('--display-name <name>', 'Recipient-visible From display name (defaults to the mailbox name; server-validated)')
    .option('--no-wait', 'Do not auto-retry while the sending domain is being provisioned (pass the 409 through)')
    .action(async (name: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts() as { imapFolder?: string; displayName?: string; wait?: boolean };
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const deadline = Date.now() + DOMAIN_PROVISIONING_WAIT_BUDGET_MS;
      let waitedNotice = false;
      let result;
      for (;;) {
        try {
          result = await client.createMailbox(name, localOpts.imapFolder, localOpts.displayName);
          break;
        } catch (err) {
          const isPending =
            err instanceof ApiError && err.code === 'DOMAIN_PROVISIONING_PENDING';
          if (!isPending || localOpts.wait === false) throw err;
          const retryAfterSeconds =
            typeof err.details?.retry_after === 'number' ? err.details.retry_after : 15;
          if (Date.now() + retryAfterSeconds * 1000 > deadline) throw err;
          if (!opts.json && process.stderr.isTTY && !waitedNotice) {
            process.stderr.write('Setting up your sending domain');
            waitedNotice = true;
          }
          if (waitedNotice) process.stderr.write('.');
          await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
        }
      }
      if (waitedNotice) process.stderr.write('\n');

      output(
        result,
        `Created mailbox: ${result.address}`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List all mailboxes')
    // `formatTable` pads (no wrap), so the policy columns are gated behind
    // --verbose to avoid overflowing narrow terminals. `--json` always carries
    // the full server payload regardless.
    .option('--verbose', 'Add per-mailbox policy columns (HITL / PII mode / sub-address / attachment tier)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.listMailboxes();

      const headers = localOpts.verbose
        ? ['NAME', 'ADDRESS', 'SENDS AS', 'DISPLAY NAME', 'STATUS', 'RECIPIENT POLICY', 'THREAD REPLIES', 'HITL', 'PII MODE', 'SUBADDR', 'ATTACHMENT', 'CREATED']
        : ['NAME', 'ADDRESS', 'SENDS AS', 'STATUS', 'RECIPIENT POLICY', 'THREAD REPLIES', 'CREATED'];

      const rows = result.mailboxes.map((m) => {
        // "Sends as" = the server-computed recipient-visible From. Fall back to
        // display_name ?? name when an older server omits the computed field.
        const sendsAs = m.effective_from_display ?? m.display_name ?? m.name;
        const base = [
          m.name,
          m.address,
          sendsAs,
          m.status,
          m.recipient_policy_mode ?? 'blocklist',
          // Inert in blocklist mode; shown for transparency. Migration 085.
          m.allow_thread_replies === false ? 'off' : 'on',
        ];
        if (!localOpts.verbose) return [...base, m.created_at];
        return [
          m.name,
          m.address,
          sendsAs,
          m.display_name ?? '—',
          m.status,
          m.recipient_policy_mode ?? 'blocklist',
          m.allow_thread_replies === false ? 'off' : 'on',
          m.hitl_mode ?? 'disabled',
          m.pii_mode ?? 'passthrough',
          m.default_subaddress_mode ?? 'none',
          m.attachment_exposure_mode ?? 'metadata_only',
          m.created_at,
        ];
      });

      output(result, formatTable(headers, rows), opts.json);
    });
}

function deleteCommand(): Command {
  return new Command('delete')
    .description('Delete a mailbox')
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .option('-y, --yes', 'Skip confirmation prompt (alias for --confirm)')
    .option('--confirm', 'Skip confirmation prompt')
    .action(async (nameOrId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const id = await resolveMailboxId(client, nameOrId);

      // Fail closed in non-interactive / --json mode (CONFIRM_REQUIRED) rather
      // than silently deleting when stdin is not a TTY. Both --confirm and the
      // legacy -y/--yes bypass; interactively this requires a typed "yes"
      // (parity with `account`/`webhook`/`domain` delete).
      await ensureConfirmed(
        opts.json,
        !!(localOpts.confirm || localOpts.yes),
        `Delete mailbox ${nameOrId}? Type "yes": `,
      );

      await client.deleteMailbox(id);

      output(
        { status: 'deleted', id },
        `Deleted mailbox: ${nameOrId}`,
        opts.json,
      );
    });
}

function updateCommand(): Command {
  return new Command('update')
    .description('Update a mailbox scanner policy and/or recipient-visible display name')
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .option('--scanner-policy <json>', 'Scanner policy as JSON')
    .option('--disable-scanner <name...>', 'Disable specific scanners')
    .option('--disable-criterion <name...>', 'Disable specific proxy criteria')
    .option('--language-mode <mode>', 'Language mode: english_only (best-effort non-English quarantine, not containment), allow_all_languages, disabled')
    .option('--reset-policy', 'Reset to platform defaults')
    .option('--display-name <name>', 'Set the recipient-visible From display name (server-validated)')
    .option('--clear-display-name', 'Clear the display name (From falls back to the mailbox name)')
    .action(async (nameOrId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();

      // --reset-policy is mutually exclusive with the per-field policy flags:
      // a reset clears the whole policy to platform defaults, so combining it
      // with --scanner-policy / --language-mode / --disable-scanner /
      // --disable-criterion is contradictory. Fail loud (exit 2, before any
      // network call) rather than silently letting the reset win and dropping
      // the other flags (UAT-02 audit follow-up). The display-name flags are
      // orthogonal — a reset + set-display-name is a legitimate combined PATCH.
      if (
        localOpts.resetPolicy &&
        (localOpts.scannerPolicy ||
          localOpts.languageMode ||
          localOpts.disableScanner ||
          localOpts.disableCriterion)
      ) {
        throw new LocalCliError(
          '--reset-policy cannot be combined with other scanner-policy flags ' +
            '(--scanner-policy / --language-mode / --disable-scanner / --disable-criterion). ' +
            'A reset clears the whole policy to platform defaults.',
          'CONFLICTING_OPTIONS',
          undefined,
          2,
        );
      }

      // Set-a-name and clear-the-name are contradictory. Fail network-free.
      if (localOpts.displayName !== undefined && localOpts.clearDisplayName) {
        throw new LocalCliError(
          '--display-name and --clear-display-name are mutually exclusive ' +
            '(set a display name or clear it, not both).',
          'CONFLICTING_OPTIONS',
          undefined,
          2,
        );
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const id = await resolveMailboxId(client, nameOrId);

      // Sparse patch: send ONLY the fields the caller asked to change. A
      // display-name-only update must NOT resubmit scanner_policy (a bare
      // resubmit needlessly re-reads + re-writes the whole policy).
      const patch: {
        scanner_policy?: ScannerPolicy | null;
        display_name?: string | null;
      } = {};

      const wantsScanner = !!(
        localOpts.resetPolicy ||
        localOpts.scannerPolicy ||
        localOpts.languageMode ||
        localOpts.disableScanner ||
        localOpts.disableCriterion
      );
      const wantsDisplay =
        localOpts.displayName !== undefined || localOpts.clearDisplayName === true;

      // Include scanner_policy when a scanner flag is present, OR when there is
      // no display-name change on its own — the latter preserves the legacy
      // no-flag `update` behavior (a scanner-policy no-op resubmit).
      if (wantsScanner || !wantsDisplay) {
        // --reset-policy sends a literal `scanner_policy: null` — the server's
        // (PR-C / UAT-02) "reset to platform defaults" signal that nulls the
        // column past its COALESCE guard. Sending `{}` was a no-op merge and
        // never reset anything. The two branches diverge entirely (a reset
        // doesn't read or merge the current policy), so handle it first.
        let policy: ScannerPolicy | null;
        if (localOpts.resetPolicy) {
          policy = null;
        } else {
          let policyPatch: ScannerPolicy;
          if (localOpts.scannerPolicy) {
            policyPatch = JSON.parse(localOpts.scannerPolicy);
          } else {
            policyPatch = {};
            if (localOpts.languageMode) policyPatch.language_mode = localOpts.languageMode;
            if (localOpts.disableScanner) policyPatch.disabled_scanners = localOpts.disableScanner;
            if (localOpts.disableCriterion) policyPatch.disabled_proxy_criteria = localOpts.disableCriterion;
          }
          policy = mergeScannerPolicy((await client.getMailbox(id)).scanner_policy, policyPatch);
        }
        patch.scanner_policy = policy;
      }

      // Presence-aware: an explicit clear sends `null`; a set sends the string.
      if (localOpts.clearDisplayName) {
        patch.display_name = null;
      } else if (localOpts.displayName !== undefined) {
        patch.display_name = localOpts.displayName;
      }

      const result = await client.updateMailbox(id, patch);

      const changed: string[] = [];
      if (wantsScanner) changed.push('scanner policy');
      if (wantsDisplay) changed.push(localOpts.clearDisplayName ? 'display name (cleared)' : 'display name');
      const label = changed.length > 0 ? changed.join(' + ') : 'scanner policy';

      output(
        result,
        `Updated ${label} for mailbox: ${nameOrId}`,
        opts.json,
      );
    });
}

// ───────────────────────────────────────────────────────────────────────
// Migration 036 — recipient policy mode + allowlist subcommands.
//
// `rly mailbox set-policy <mailbox> <blocklist|allowlist> [--force-empty]`
//   Flip the mailbox's recipient policy. 400 ALLOWLIST_EMPTY when flipping
//   to allowlist on an empty list unless --force-empty is passed.
//
// `rly mailbox allowlist list <mailbox>`
// `rly mailbox allowlist add <mailbox> <email>`
// `rly mailbox allowlist remove <mailbox> <email> [--force-empty]`
//   Mutations are admin-only — agent keys get 403 INSUFFICIENT_SCOPE.
// ───────────────────────────────────────────────────────────────────────

function setPolicyCommand(): Command {
  return new Command('set-policy')
    .description("Set mailbox recipient policy ('blocklist' or 'allowlist')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<mode>', 'blocklist or allowlist')
    .option('--force-empty', "Acknowledge flipping to allowlist on an empty list (agent sends to new/off-thread recipients 403 until you add entries; in-thread replies and human sends are unaffected)")
    .action(async (
      nameOrId: string,
      mode: string,
      _ignored: unknown,
      cmd: Command,
    ) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      if (mode !== 'blocklist' && mode !== 'allowlist') {
        throw new LocalCliError(
          "mode must be 'blocklist' or 'allowlist'",
          'INVALID_OPTION',
          { option: 'mode', value: mode },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, {
        recipient_policy_mode: mode as 'blocklist' | 'allowlist',
        ...(localOpts.forceEmpty ? { force_empty: true } : {}),
      });
      output(
        result,
        `Set recipient policy on ${nameOrId} → ${mode}`,
        opts.json,
      );
    });
}

// `rly mailbox set-thread-replies <name-or-id> <on|off>`
//   Toggle the thread-scoped reply bypass (migration 085). Inert in blocklist
//   mode; in allowlist mode `on` lets an agent reply to / follow up with any
//   inbound participant of a thread without that address gaining standing
//   send-authority. `off` restores strict allowlist-only sends.
function setThreadRepliesCommand(): Command {
  return new Command('set-thread-replies')
    .description("Toggle thread-scoped reply bypass for allowlist mailboxes ('on' or 'off')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<on|off>', "'on' to allow thread replies, 'off' to require strict allowlist")
    .action(async (
      nameOrId: string,
      value: string,
      _ignored: unknown,
      cmd: Command,
    ) => {
      const opts = cmd.optsWithGlobals();
      if (value !== 'on' && value !== 'off') {
        throw new LocalCliError(
          "value must be 'on' or 'off'",
          'INVALID_OPTION',
          { option: 'value', value },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, {
        allow_thread_replies: value === 'on',
      });
      output(
        result,
        `Set thread-scoped reply bypass on ${nameOrId} → ${value}`,
        opts.json,
      );
    });
}

// `rly mailbox set-agent-sends <name-or-id> <open|restricted> [--confirm-open-human-sends]`
//   Single "agent sends" control — the thin front door over the recipient
//   policy + agent-send-containment fields. `open` lets the agent send to any
//   new recipient; `restricted` gates it. Opening on an allowlist mailbox now
//   succeeds directly — the server flips the mailbox to blocklist and clears
//   agent containment, with no consent required (human sends are never
//   allowlist-restricted). --confirm-open-human-sends is deprecated + ignored
//   by the server (a no-op, kept for back-compat).
function setAgentSendsCommand(): Command {
  return new Command('set-agent-sends')
    .description("Set the agent-sends policy ('open' or 'restricted')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<open|restricted>', "'open' to let the agent send to any recipient, 'restricted' to gate it")
    .option(
      '--confirm-open-human-sends',
      '(Deprecated, no-op) Ignored by the server — opening the agent on an allowlist mailbox no longer requires consent. Kept for back-compat.',
    )
    .action(async (
      nameOrId: string,
      value: string,
      _ignored: unknown,
      cmd: Command,
    ) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts() as { confirmOpenHumanSends?: boolean };
      if (value !== 'open' && value !== 'restricted') {
        throw new LocalCliError(
          "value must be 'open' or 'restricted'",
          'INVALID_OPTION',
          { option: 'value', value },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, {
        agent_send_policy: value,
        ...(localOpts.confirmOpenHumanSends ? { confirm_open_human_sends: true } : {}),
      });
      output(
        result,
        `Set agent-sends policy on ${nameOrId} → ${value}` +
          (result.restricted_by ? ` (restricted_by: ${result.restricted_by})` : ''),
        opts.json,
      );
    });
}

// `rly mailbox show <name-or-id>` — mailbox detail, including the derived
// single "agent sends" control (agent_send_policy + restricted_by).
function showCommand(): Command {
  return new Command('show')
    .description('Show mailbox detail (recipient policy, agent-sends control, etc.)')
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .action(async (nameOrId: string, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const mb = await client.getMailbox(id);
      const table = formatTable(['FIELD', 'VALUE'], [
        ['name', String(mb.name)],
        ['address', String(mb.address)],
        ['display_name', mb.display_name ?? '(none — uses name)'],
        // "Sends as" = the server-computed recipient-visible From. Fall back to
        // display_name ?? name when an older server omits the computed field.
        ['sends_as', String(mb.effective_from_display ?? mb.display_name ?? mb.name)],
        ['recipient_policy_mode', String(mb.recipient_policy_mode ?? 'blocklist')],
        ['agent_send_policy', String(mb.agent_send_policy ?? '(unknown)')],
        ['restricted_by', mb.restricted_by ?? '(none — open)'],
        ['allow_thread_replies', String(mb.allow_thread_replies !== false)],
        ['hitl_mode', String(mb.hitl_mode ?? 'disabled')],
        ['pii_mode', String(mb.pii_mode ?? 'passthrough')],
      ]);
      output(mb, table, opts.json);
    });
}

// ───────────────────────────────────────────────────────────────────────
// Per-mailbox policy verbs (design-review G1/G2/G4/G5/G3 + S1-SAFE). All
// mirror the set-X pattern: resolveMailboxId → updateMailbox / attachment-
// access (admin-only at the server via requireAdmin; agent keys get 403).
// No server or SDK change — the PATCH/attachment-access routes already accept
// these fields. raw-download ENABLE/WIDEN stays dashboard-only (S1 deferred).
// ───────────────────────────────────────────────────────────────────────

const ATTACHMENT_FAMILIES = ['pdf', 'text', 'csv', 'image'];

// Mirror of the canonical VALID_PII_DETECTORS enum, hardcoded locally because
// the CLI ships as a dependency-minimal bundled binary with no workspace deps
// (same pattern as ATTACHMENT_FAMILIES above). Keep this list in sync with the
// server's detector constant.
const PII_DETECTORS = [
  'PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'US_SSN', 'CREDIT_CARD',
  'US_BANK_NUMBER', 'US_DRIVER_LICENSE', 'US_ITIN', 'US_PASSPORT', 'UK_NHS',
  'IBAN_CODE', 'MEDICAL_LICENSE', 'CRYPTO',
];

// G1 — enable/disable the per-mailbox HITL outbound-review queue.
function setHitlCommand(): Command {
  return new Command('set-hitl')
    .description("Enable/disable the per-mailbox human-in-the-loop (HITL) outbound-review queue ('on'|'off')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<on|off>', "'on' = review all outbound (all_outbound); 'off' = disabled")
    .action(async (nameOrId: string, value: string, _ignored: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      if (value !== 'on' && value !== 'off') {
        throw new LocalCliError("value must be 'on' or 'off'", 'INVALID_OPTION', { option: 'value', value }, 2);
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, { hitl_mode: value === 'on' ? 'all_outbound' : 'disabled' });
      if (value === 'off' && !opts.json) {
        // Cosmetic safety advisory to STDERR. Suppressed under --json so it
        // doesn't leak into `2>&1` consumers (JSON-STDERR-001 b).
        console.error('Note: HITL review is now disabled — outbound is no longer held for human approval on this mailbox.');
      }
      output(result, `Set HITL review on ${nameOrId} → ${value}`, opts.json);
    });
}

// G2 — per-mailbox inbound PII delivery mode.
function setPiiModeCommand(): Command {
  return new Command('set-pii-mode')
    .description("Set the per-mailbox inbound PII delivery mode ('passthrough'|'redacted')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<passthrough|redacted>', 'PII mode')
    .action(async (nameOrId: string, value: string, _ignored: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      if (value !== 'passthrough' && value !== 'redacted') {
        throw new LocalCliError("mode must be 'passthrough' or 'redacted'", 'INVALID_OPTION', { option: 'mode', value }, 2);
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, { pii_mode: value });
      output(result, `Set PII mode on ${nameOrId} → ${value}`, opts.json);
    });
}

// G4 — mailbox default outbound sub-address mode.
function setSubaddressModeCommand(): Command {
  return new Command('set-subaddress-mode')
    .description("Set the mailbox default outbound sub-address mode ('reply_to'|'from'|'none')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<reply_to|from|none>', 'Default sub-address mode')
    .action(async (nameOrId: string, value: string, _ignored: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      if (value !== 'reply_to' && value !== 'from' && value !== 'none') {
        throw new LocalCliError("mode must be 'reply_to', 'from', or 'none'", 'INVALID_OPTION', { option: 'mode', value }, 2);
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, { default_subaddress_mode: value });
      output(result, `Set default sub-address mode on ${nameOrId} → ${value}`, opts.json);
    });
}

// G5 — attachment exposure tier (metadata_only|derived_content). raw-download
// ENABLE/WIDEN is rejected locally (dashboard-only); --families is rejected
// (the server discards families for these modes).
function setAttachmentPolicyCommand(): Command {
  return new Command('set-attachment-policy')
    .description("Set the per-mailbox attachment exposure tier ('metadata_only'|'derived_content')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<metadata_only|derived_content>', 'Exposure mode')
    .option('--accept-disclaimer <version>', 'Disclaimer version to accept (required for a first-time derived_content write)')
    .option('--families <csv>', 'Not valid here — use `attachment-policy narrow` for raw-download families')
    .action(async (nameOrId: string, mode: string, _ignored: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      if (mode === 'raw_download_selected_types') {
        throw new LocalCliError(
          'Approved (raw) downloads require a re-authenticated dashboard session (REAUTH_REQUIRES_SESSION). Enable them from the dashboard, not the CLI.',
          'REAUTH_REQUIRES_SESSION', { mode }, 2,
        );
      }
      if (mode !== 'metadata_only' && mode !== 'derived_content') {
        throw new LocalCliError("mode must be 'metadata_only' or 'derived_content'", 'INVALID_OPTION', { option: 'mode', value: mode }, 2);
      }
      if (localOpts.families !== undefined) {
        throw new LocalCliError(
          'The server discards --families for metadata_only/derived_content. Use `mailbox attachment-policy narrow <mailbox> --families ...` on a raw-download mailbox instead.',
          'INVALID_OPTION', { option: 'families' }, 2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.setAttachmentAccess(id, {
        mode,
        ...(localOpts.acceptDisclaimer ? { accept_disclaimer_version: localOpts.acceptDisclaimer as string } : {}),
      });
      output(result, `Set attachment policy on ${nameOrId} → ${mode}`, opts.json);
    });
}

// G3 — per-mailbox PII redaction config (per-detector overrides). Thin JSON
// path; the dashboard stays the exploratory home.
function setRedactionCommand(): Command {
  return new Command('set-redaction')
    .description('Set or reset the per-mailbox PII redaction config (per-detector overrides)')
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .option('--config <json>', 'pii_redaction_config as JSON (per-detector visibility/operators)')
    .option('--reset', 'Reset redaction config to defaults (null)')
    .addHelpText('after', [
      '',
      'Valid PII detector keys for --config:',
      '  ' + PII_DETECTORS.join(', '),
      '',
      'Each key maps to a visibility/operator object; the dashboard Safety page',
      'is the exploratory home for the full per-detector shape.',
    ].join('\n'))
    .action(async (nameOrId: string, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const hasConfig = localOpts.config !== undefined;
      const hasReset = localOpts.reset === true;
      if (hasConfig === hasReset) {
        throw new LocalCliError('exactly one of --config <json> or --reset is required', 'INVALID_OPTION', {}, 2);
      }
      let config: Record<string, unknown> | null = null;
      if (hasConfig) {
        try {
          config = JSON.parse(localOpts.config as string);
        } catch {
          throw new LocalCliError('--config must be valid JSON', 'INVALID_OPTION', { option: 'config' }, 2);
        }
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.updateMailbox(id, { pii_redaction_config: config });
      output(result, `${hasReset ? 'Reset' : 'Updated'} PII redaction config on ${nameOrId}`, opts.json);
    });
}

// S1-SAFE — attachment-policy show / disable / narrow (the only attachment
// ops that do NOT trip the REAUTH_REQUIRES_SESSION enablement gate).
function attachmentPolicyCommand(): Command {
  const group = new Command('attachment-policy').description(
    'Inspect / disable / narrow the per-mailbox attachment policy (safe reads; ' +
      'enabling Approved raw downloads is dashboard-only).',
  );

  group.addCommand(
    new Command('show')
      .description('Show the current attachment exposure policy for a mailbox')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .action(async (nameOrId: string, _opts: unknown, c: Command) => {
        const opts = c.optsWithGlobals();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const mb = await client.getMailbox(id);
        const table = formatTable(['FIELD', 'VALUE'], [
          ['exposure_mode', String(mb.attachment_exposure_mode ?? 'metadata_only')],
          ['allowed_file_families', (mb.attachment_allowed_file_families ?? []).join(',') || '(none)'],
          ['reauth_at', String(mb.attachment_reauth_at ?? '(none)')],
          ['policy_version', String(mb.attachment_policy_version ?? '(none)')],
          ['current_disclaimer_version', String(mb.current_disclaimer_version ?? '(none)')],
          ['legacy attachment mode', mb.legacy_wildcard_active ? 'yes' : 'no'],
        ]);
        output(mb, table, opts.json);
      }),
  );

  group.addCommand(
    new Command('disable')
      .description('Disable attachment access (kill-switch → metadata_only, clears families)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .action(async (nameOrId: string, _opts: unknown, c: Command) => {
        const opts = c.optsWithGlobals();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.setAttachmentAccess(id, { enable: false });
        output(result, `Disabled attachment access on ${nameOrId} (reset to metadata_only).`, opts.json);
      }),
  );

  group.addCommand(
    new Command('narrow')
      .description('Narrow raw-download file families to a subset (raw-download mailboxes only)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .requiredOption('--families <csv>', 'Comma-separated subset of pdf,text,csv,image')
      .action(async (nameOrId: string, _opts: unknown, c: Command) => {
        const opts = c.optsWithGlobals();
        const localOpts = c.opts();
        const families = String(localOpts.families).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = families.filter((f) => !ATTACHMENT_FAMILIES.includes(f));
        if (bad.length > 0) {
          throw new LocalCliError(
            `invalid file famil${bad.length > 1 ? 'ies' : 'y'}: ${bad.join(', ')} (allowed: ${ATTACHMENT_FAMILIES.join(', ')})`,
            'INVALID_OPTION', { option: 'families', value: bad }, 2,
          );
        }
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        // A widen (or a non-raw row) is rejected server-side with
        // REAUTH_REQUIRES_SESSION — surfaced verbatim; the CLI does not pre-flight.
        const result = await client.setAttachmentAccess(id, { mode: 'raw_download_selected_types', allowed_file_families: families });
        output(result, `Narrowed raw-download families on ${nameOrId} → ${families.join(',')}`, opts.json);
      }),
  );

  return group;
}

function allowlistCommand(): Command {
  const cmd = new Command('allowlist').description(
    'Manage the per-mailbox recipient allowlist (admin-only mutations)',
  );
  cmd.addCommand(
    new Command('list')
      .description('List allowlist entries for a mailbox')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .option('--all', 'paginate through every row', false)
      .option('--limit <n>', 'page size (1..500, default 100)', '100')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Hoisted above resolveMailboxId so a bad --limit fails network-free.
        const limitNum = parseIntOption(localOpts.limit ?? '100', '--limit', 1, 500);
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);

        const all: Array<{
          email: string;
          created_at: string;
          added_by_actor_type: string | null;
          pattern_type?: 'email' | 'domain';
        }> = [];
        let cursor: string | undefined;
        do {
          const page = await client.listAllowlist(id, { limit: limitNum, cursor });
          all.push(...page.allowlist);
          cursor = page.next_cursor ?? undefined;
          if (!localOpts.all) break;
        } while (cursor);

        const table = formatTable(
          ['ENTRY', 'TYPE', 'ADDED', 'ADDED BY'],
          all.map((e) => [
            e.email,
            // Fallback to string-inspection if pre-0.5.0 server omits it.
            e.pattern_type ?? (e.email.startsWith('@') ? 'domain' : 'email'),
            e.created_at,
            e.added_by_actor_type ?? '—',
          ]),
        );
        if (!localOpts.all && cursor && !opts.json) {
          console.error(`Showing first ${all.length} rows. Use --all to list every entry.`);
        }
        output({ allowlist: all, next_cursor: cursor ?? null }, table, opts.json);
      }),
  );
  cmd.addCommand(
    new Command('add')
      .description('Add an email or domain pattern (@corp.com) to the mailbox allowlist (admin-only)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .argument('<email-or-domain>', 'Recipient email (alice@corp.com) or domain pattern (@corp.com)')
      .action(async (nameOrId: string, email: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.addAllowlist(id, email);
        const normalized = result.email;
        if (normalized !== email && normalized !== email.trim() && !opts.json) {
          console.error(`Note: stored as ${normalized} (lowercased).`);
        }
        const msg = result.already_existed
          ? `${normalized} is already on the allowlist for ${nameOrId}.`
          : `Added ${normalized} to allowlist for ${nameOrId}.`;
        output(result, msg, opts.json);
      }),
  );
  // FIND-007 (WS4) — bulk-add up to 1000 outbound allowlist entries in one
  // request. Accepts comma-separated addresses or an @file path (one per line).
  cmd.addCommand(
    new Command('add-bulk')
      .description('Bulk-add up to 1000 entries to the mailbox allowlist (admin-only); --emails accepts csv or @file')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .requiredOption('--emails <csv|@file>', 'Comma-separated emails or @/path/to/file (one per line, max 1000)')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Parse and cap-check before any network call.
        const emails = parseEmailsOption(String(localOpts.emails), 1000);
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.addAllowlistBulk(id, emails);
        emitBulkResult(result, opts.json);
      }),
  );
  cmd.addCommand(
    new Command('remove')
      .description('Remove an email from the mailbox allowlist (admin-only)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .argument('<email>', 'Recipient email address')
      .option('--force-empty', 'Acknowledge deleting the last entry while in allowlist mode (agent sends to new/off-thread recipients 403 until you add entries; in-thread replies and human sends are unaffected)')
      .action(async (nameOrId: string, email: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.deleteAllowlist(id, email, {
          forceEmpty: localOpts.forceEmpty === true,
        });
        output(result, `Removed ${result.email} from allowlist for ${nameOrId}.`, opts.json);
      }),
  );
  // Migration 038 — blocked-attempts log. `--raw` toggles per-attempt history.
  cmd.addCommand(
    new Command('blocked')
      .description('List sends blocked by the allowlist gate (aggregated by default; --raw for per-attempt history)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .option('--raw', 'Return per-attempt raw rows instead of aggregated top-N')
      .option('--limit <n>', 'page size (1..500, default 500)', '500')
      .option('--all', 'enumerate all rows (raw mode only; capped at 10 000)')
      .option('--within-days <n>', 'recency filter (1..365); applies created_at >= NOW() - N days')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Hoisted above resolveMailboxId so a bad --limit/--within-days fails network-free.
        const limitNum = parseIntOption(localOpts.limit ?? '500', '--limit', 1, 500);
        let withinDays: number | undefined;
        if (localOpts.withinDays !== undefined) {
          withinDays = parseIntOption(String(localOpts.withinDays), '--within-days', 1, 365);
        }
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);

        const aggregate = localOpts.raw !== true;
        // Aggregated view does not paginate (next_cursor is always null).
        if (aggregate) {
          const page = await client.listBlockedAttempts(id, { limit: limitNum, aggregate: true, withinDays });
          const table = formatTable(
            ['RECIPIENT', 'COUNT', 'ACTOR', 'LAST ATTEMPTED'],
            page.attempts.map((a) => [
              String(a.recipient ?? ''),
              String(a.count ?? ''),
              `${a.actor_type ?? ''}:${a.actor_id ?? ''}`,
              String(a.last_attempted_at ?? ''),
            ]),
          );
          output(page, table, opts.json);
          return;
        }

        const all: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        do {
          const page = await client.listBlockedAttempts(id, {
            limit: limitNum, cursor, aggregate: false, withinDays,
          });
          all.push(...page.attempts);
          cursor = page.next_cursor ?? undefined;
          if (!localOpts.all) break;
        } while (cursor);

        const table = formatTable(
          ['ATTEMPTED', 'RECIPIENT', 'ACTOR', 'ORIGIN'],
          all.map((a) => [
            String(a.attempted_at ?? ''),
            String(a.recipient ?? ''),
            `${a.actor_type ?? ''}:${a.actor_id ?? ''}`,
            String(a.origin ?? ''),
          ]),
        );
        if (!localOpts.all && cursor && !opts.json) {
          console.error(`Showing first ${all.length} rows. Use --all to list every attempt.`);
        }
        output({ attempts: all, next_cursor: cursor ?? null }, table, opts.json);
      }),
  );
  return cmd;
}

// ───────────────────────────────────────────────────────────────────────
// Migration 047 — inbound firewall (per-mailbox sender allowlist + sender
// policy mode toggle). Symmetric counterpart to the outbound surfaces above.
// Auth: BOTH admin AND agent for read AND mutate (the customer is being
// protected from external senders, not contained against their own agents).
// ───────────────────────────────────────────────────────────────────────

function setSenderPolicyCommand(): Command {
  return new Command('set-sender-policy')
    .description("Set mailbox inbound firewall mode ('blocklist' or 'allowlist')")
    .argument('<name-or-id>', 'Mailbox name or UUID')
    .argument('<mode>', 'blocklist or allowlist')
    .option('--force-empty', "Acknowledge flipping to allowlist on an empty list (all incoming senders firewall_blocked until you add entries)")
    .action(async (
      nameOrId: string,
      mode: string,
      _ignored: unknown,
      cmd: Command,
    ) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      if (mode !== 'blocklist' && mode !== 'allowlist') {
        throw new LocalCliError(
          "mode must be 'blocklist' or 'allowlist'",
          'INVALID_OPTION',
          { option: 'mode', value: mode },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, nameOrId);
      const result = await client.setSenderPolicy(
        id,
        mode as 'blocklist' | 'allowlist',
        { forceEmpty: localOpts.forceEmpty === true },
      );
      output(
        result,
        `Set sender policy on ${nameOrId} → ${mode}` +
          (result.previous_mode !== result.sender_policy_mode
            ? ` (was ${result.previous_mode})`
            : ''),
        opts.json,
      );
    });
}

function inboundAllowlistCommand(): Command {
  const cmd = new Command('inbound-allowlist').description(
    'Manage the per-mailbox inbound sender allowlist (admin + agent)',
  );
  cmd.addCommand(
    new Command('list')
      .description('List inbound allowlist entries for a mailbox')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .option('--all', 'paginate through every row', false)
      .option('--limit <n>', 'page size (1..500, default 100)', '100')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Hoisted above resolveMailboxId so a bad --limit fails network-free.
        const limitNum = parseIntOption(localOpts.limit ?? '100', '--limit', 1, 500);
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);

        const all: Array<{
          email: string;
          created_at: string;
          added_by_actor_type: string | null;
          pattern_type?: 'email' | 'domain';
        }> = [];
        let cursor: string | undefined;
        do {
          const page = await client.listInboundAllowlist(id, { limit: limitNum, cursor });
          all.push(...page.allowlist);
          cursor = page.next_cursor ?? undefined;
          if (!localOpts.all) break;
        } while (cursor);

        const table = formatTable(
          ['ENTRY', 'TYPE', 'ADDED', 'ADDED BY'],
          all.map((e) => [
            e.email,
            e.pattern_type ?? (e.email.startsWith('@') ? 'domain' : 'email'),
            e.created_at,
            e.added_by_actor_type ?? '—',
          ]),
        );
        if (!localOpts.all && cursor && !opts.json) {
          console.error(`Showing first ${all.length} rows. Use --all to list every entry.`);
        }
        output({ allowlist: all, next_cursor: cursor ?? null }, table, opts.json);
      }),
  );
  cmd.addCommand(
    new Command('add')
      .description('Add an email or domain pattern (@corp.com) to the inbound allowlist')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .argument('<email-or-domain>', 'Sender email (alice@corp.com) or domain pattern (@corp.com)')
      .action(async (nameOrId: string, email: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.addInboundAllowlist(id, email);
        const normalized = result.email;
        if (normalized !== email && normalized !== email.trim() && !opts.json) {
          console.error(`Note: stored as ${normalized} (lowercased).`);
        }
        const msg = result.already_existed
          ? `${normalized} is already on the inbound allowlist for ${nameOrId}.`
          : `Added ${normalized} to inbound allowlist for ${nameOrId}.`;
        output(result, msg, opts.json);
      }),
  );
  // FIND-008 (WS4) — bulk-add up to 1000 inbound allowlist entries in one
  // request. Accepts comma-separated addresses or an @file path.
  cmd.addCommand(
    new Command('add-bulk')
      .description('Bulk-add up to 1000 entries to the inbound allowlist (admin + agent); --emails accepts csv or @file')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .requiredOption('--emails <csv|@file>', 'Comma-separated emails or @/path/to/file (one per line, max 1000)')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Parse and cap-check before any network call.
        const emails = parseEmailsOption(String(localOpts.emails), 1000);
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.addInboundAllowlistBulk(id, emails);
        emitBulkResult(result, opts.json);
      }),
  );
  cmd.addCommand(
    new Command('remove')
      .description('Remove an entry from the inbound allowlist')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .argument('<email>', 'Sender email or @domain pattern')
      .option('--force-empty', 'Acknowledge deleting the last entry while in allowlist mode (all incoming senders firewall_blocked until you add entries)')
      .action(async (nameOrId: string, email: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);
        const result = await client.deleteInboundAllowlist(id, email, {
          forceEmpty: localOpts.forceEmpty === true,
        });
        output(result, `Removed ${result.email} from inbound allowlist for ${nameOrId}.`, opts.json);
      }),
  );
  cmd.addCommand(
    new Command('blocked')
      .description('List incoming senders rejected by the inbound firewall (aggregated by default; --raw for per-attempt history)')
      .argument('<name-or-id>', 'Mailbox name or UUID')
      .option('--raw', 'Return per-attempt raw rows instead of aggregated top-N')
      .option('--limit <n>', 'page size (1..500, default 500)', '500')
      .option('--all', 'enumerate all rows (raw mode only; capped at 10 000)')
      .option('--within-days <n>', 'recency filter (1..365)')
      .action(async (nameOrId: string, _ignored, parentCmd: Command) => {
        const opts = parentCmd.optsWithGlobals();
        const localOpts = parentCmd.opts();
        // Hoisted above resolveMailboxId so a bad --limit/--within-days fails network-free.
        const limitNum = parseIntOption(localOpts.limit ?? '500', '--limit', 1, 500);
        let withinDays: number | undefined;
        if (localOpts.withinDays !== undefined) {
          withinDays = parseIntOption(String(localOpts.withinDays), '--within-days', 1, 365);
        }
        const apiKey = requireApiKey(opts.apiKey);
        const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
        const id = await resolveMailboxId(client, nameOrId);

        const aggregate = localOpts.raw !== true;
        if (aggregate) {
          const page = await client.listInboundFirewallBlockedAttempts(id, {
            limit: limitNum, aggregate: true, withinDays,
          });
          const table = formatTable(
            ['SENDER', 'FIELD', 'MODE', 'CODE', 'COUNT', 'LAST ATTEMPTED'],
            page.attempts.map((a) => [
              String(a.sender ?? ''),
              String(a.matched_field ?? '—'),
              String(a.mode ?? ''),
              String(a.reason_code ?? ''),
              String(a.count ?? ''),
              String(a.last_attempted_at ?? ''),
            ]),
          );
          output(page, table, opts.json);
          return;
        }

        const all: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        do {
          const page = await client.listInboundFirewallBlockedAttempts(id, {
            limit: limitNum, cursor, aggregate: false, withinDays,
          });
          all.push(...page.attempts);
          cursor = page.next_cursor ?? undefined;
          if (!localOpts.all) break;
        } while (cursor);

        const table = formatTable(
          ['ATTEMPTED', 'ENVELOPE', 'FROM', 'MATCHED', 'MODE', 'CODE'],
          all.map((a) => [
            String(a.attempted_at ?? ''),
            String(a.envelope_sender ?? ''),
            String(a.from_address ?? ''),
            String(a.matched_pattern ?? ''),
            String(a.mode ?? ''),
            String(a.reason_code ?? ''),
          ]),
        );
        if (!localOpts.all && cursor && !opts.json) {
          console.error(`Showing first ${all.length} rows. Use --all to list every attempt.`);
        }
        output({ attempts: all, next_cursor: cursor ?? null }, table, opts.json);
      }),
  );
  return cmd;
}
