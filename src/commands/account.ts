import { Command } from 'commander';
import readline from 'node:readline';
import { writeFileSync, chmodSync } from 'node:fs';
import { ApiClient } from '../api-client.js';
import { requireApiKey, deleteCredentialFile } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { ApiError } from '../types.js';
import { output } from '../format.js';
import type { UsageResponse, AgentQuotaResponse, LinkScanningStatus } from '../types.js';
// The local web-risk mirror (generated from the canonical source; this package
// carries no private-monorepo dependency at runtime).
import {
  WEB_RISK_NOTICE,
  WEB_RISK_ADVISORY_URL,
  CURRENT_URL_REPUTATION_DISCLAIMER_VERSION,
} from '../lib/web-risk-acceptance.js';

export function accountCommand(): Command {
  const account = new Command('account').description('Manage your ReplyLayer account');

  account.addCommand(usageCommand());
  account.addCommand(quotaCommand());
  account.addCommand(exportCommand());
  account.addCommand(linkScanningCommand());
  account.addCommand(deleteCommand());

  return account;
}

// Malicious link scanning (URL reputation, backed by Google Web Risk).
function linkScanningCommand(): Command {
  const group = new Command('link-scanning').description('Malicious link scanning (URL reputation)');

  group.command('status')
    .description('Show whether malicious link scanning is enabled')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.getLinkScanningStatus();
      output(result, formatLinkScanningStatus(result), opts.json);
    });

  group.command('enable')
    .description('Enable malicious link scanning (requires an admin key; acknowledges the disclosure)')
    .option('--accept', 'Acknowledge the disclosure and enable (required)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const accepted = localOpts.accept === true;
      const apiKey = requireApiKey(opts.apiKey);

      // --json must not emit the free-form Google disclosure text; fail closed
      // with the structured code (the disclosure is shown in human mode only).
      if (opts.json && !accepted) {
        throw new LocalCliError(
          'Pass --accept to enable malicious link scanning when using --json (the disclosure is shown in human mode).',
          'LINK_SCANNING_ACCEPT_REQUIRED',
          undefined,
          1,
        );
      }

      // Human mode: show the disclosure (visible even if --accept is missing).
      if (!opts.json) {
        console.error('Enabling malicious link scanning sends URL hash-prefixes from inbound mail to');
        console.error('Google Web Risk to flag phishing/malware links.');
        console.error('');
        console.error(`  ${WEB_RISK_NOTICE}`);
        console.error(`  Advisory: ${WEB_RISK_ADVISORY_URL}`);
        console.error('');
      }

      if (!accepted) {
        if (!opts.json) console.error('Re-run with: rly account link-scanning enable --accept');
        throw new LocalCliError(
          'You must pass --accept to acknowledge the disclosure and enable malicious link scanning.',
          'LINK_SCANNING_ACCEPT_REQUIRED',
        );
      }

      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      let result;
      try {
        result = await client.enableLinkScanning(CURRENT_URL_REPUTATION_DISCLAIMER_VERSION);
      } catch (err) {
        // Agent keys cannot enable an account-wide feature — surface the fix.
        if (err instanceof ApiError && err.code === 'INSUFFICIENT_SCOPE' && !opts.json) {
          console.error('Enabling malicious link scanning needs an admin API key or a dashboard session.');
          console.error('Agent-scoped keys can read status but cannot enable an account-wide feature.');
        }
        throw err;
      }
      output(
        result,
        `Malicious link scanning: on (accepted ${result.url_reputation.accepted_version}).`,
        opts.json,
      );
    });

  return group;
}

function formatLinkScanningStatus(s: LinkScanningStatus): string {
  if (s.active) return `Malicious link scanning: on (accepted ${s.accepted_version}).`;
  if (!s.privacy_ok) {
    return 'Malicious link scanning: off — your acknowledged privacy policy predates this feature; review and acknowledge the current Privacy Policy in the dashboard first.';
  }
  return "Malicious link scanning: off — run 'rly account link-scanning enable' to turn it on (needs an admin key).";
}

// G9 — GDPR Art. 20 data portability export.
function exportCommand(): Command {
  return new Command('export')
    .description('Export your account data (GDPR portability) as JSON')
    .option('--out <file>', 'Write the export to a file (mode 0600) instead of stdout')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.exportAccount();
      if (localOpts.out) {
        const outPath = localOpts.out as string;
        writeFileSync(outPath, JSON.stringify(result, null, 2), { mode: 0o600 });
        // writeFileSync's `mode` only applies when the file is CREATED; an
        // existing file keeps its old perms. A PII-heavy export must not stay
        // world/group-readable, so enforce 0600 explicitly afterwards.
        chmodSync(outPath, 0o600);
        output({ written: outPath }, `Account export written to ${outPath} (mode 0600).`, opts.json);
      } else {
        // The export IS the payload — emit it as JSON to stdout regardless of --json.
        output(result, JSON.stringify(result, null, 2), opts.json);
      }
    });
}

function usageCommand(): Command {
  return new Command('usage')
    .description('Show account usage and limits')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.getUsage();
      output(result, formatUsage(result), opts.json);
    });
}

function quotaCommand(): Command {
  return new Command('quota')
    .description('Show your send-budget quota (works with agent-scoped keys)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.getQuota();
      output(result, formatQuota(result), opts.json);
    });
}

function deleteCommand(): Command {
  return new Command('delete')
    .description('Delete your account (30-day grace period before permanent erasure)')
    .option('--confirm', 'Skip confirmation prompt')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);

      // RL-UAT-020 (S2): in --json mode we cannot drive the interactive prompt,
      // and promptConfirmation's readline writes to stderr — so prompting then
      // throwing USER_ABORTED would put a prompt string AND a JSON envelope on
      // stderr, breaking the single-JSON-object contract an agent pipes to jq.
      // Fail closed with an actionable code BEFORE the prompt is ever created.
      if (opts.json && !localOpts.confirm) {
        throw new LocalCliError(
          'Pass --confirm to delete your account when using --json (cannot prompt interactively)',
          'CONFIRM_REQUIRED',
          undefined,
          1,
        );
      }

      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      // The API requires the account's own email echoed back as the delete
      // intent gate (a stray Bearer-only delete no longer succeeds). Fetch
      // it up front — it also lets us name the exact account in the prompt.
      // (Not stored locally; the credential file holds only the API key.)
      const me = await client.getAccount();

      if (!localOpts.confirm) {
        const confirmed = await promptConfirmation(
          `This will schedule account ${me.email} for deletion.\n` +
          'You have 30 days to contact support to reinstate.\n' +
          'All mailboxes, messages, and data will be permanently erased.\n\n' +
          'Type "delete" to confirm: ',
        );
        if (confirmed !== 'delete') {
          throw new LocalCliError('Aborted', 'USER_ABORTED', undefined, 130);
        }
      }

      const result = await client.deleteAccount(me.email);

      deleteCredentialFile();

      output(
        result,
        `${result.message}\nLocal credentials removed.`,
        opts.json,
      );
    });
}

function promptConfirmation(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatUsage(usage: UsageResponse): string {
  const lines = [
    'Account usage',
    '',
    // RL-UAT-030 — `?? 'unknown'` guards a pre-030 server that omits the field.
    `Tier: ${usage.tier ?? 'unknown'}`,
    `Sends today: ${usage.today.count.toLocaleString()} / ${usage.today.limit.toLocaleString()}`,
    `Mailboxes: ${usage.mailbox_count.toLocaleString()} / ${usage.mailbox_limit.toLocaleString()}`,
    `Pending review: ${usage.pending_review_count.toLocaleString()}`,
    '',
    'Storage',
    `  Used: ${formatBytes(usage.storage.used_bytes)} / ${formatLimit(usage.storage.limit_bytes)}`,
    `  State: ${usage.storage.state}`,
    `  Raw MIME: ${formatBytes(usage.storage.breakdown.raw_mime_bytes)}`,
    `  Previews: ${formatBytes(usage.storage.breakdown.derivative_bytes)}`,
  ];
  if (usage.storage.percent_used !== null && Number.isFinite(usage.storage.percent_used)) {
    lines.splice(9, 0, `  Percent: ${trimFixed(usage.storage.percent_used, 2)}%`);
  }
  return lines.join('\n');
}

export function formatQuota(quota: AgentQuotaResponse): string {
  // The "Bound mailboxes" line is driven by `scope`, NEVER by
  // `bound_mailbox_ids.length`. An admin/session key carries `bound_mailbox_ids: []`
  // meaning ALL mailboxes; a zero-bound agent key ALSO carries `[]` but means NONE.
  // These two []-states are semantically opposite — rendering an empty agent
  // binding as "all" would misrepresent the most-restricted caller as the
  // least-restricted (F7). So we branch on `scope` first.
  let boundLine: string;
  if (quota.scope === 'admin') {
    boundLine = 'all (admin key)';
  } else if (quota.bound_mailbox_ids.length > 0) {
    boundLine = quota.bound_mailbox_ids.join(', ');
  } else {
    boundLine = 'none (agent key has no bound mailboxes — cannot send)';
  }

  const lines = [
    'Send quota',
    '',
    `Sends today:     ${quota.today.count.toLocaleString()} / ${quota.today.limit.toLocaleString()}`,
    `Sends remaining: ${quota.sends_remaining.toLocaleString()}`,
    `Resets at:       ${quota.reset_at}`,
    `Bound mailboxes: ${boundLine}`,
  ];

  // Warm-up block — present ONLY while a new paid account is ramping on the
  // shared sending pool. The escape hatch (verify your own domain) is given
  // equal prominence, matching the disclosure resolution on this feature.
  if (quota.warmup) {
    const untilDate = new Date(quota.warmup.until);
    const untilLabel = Number.isNaN(untilDate.getTime())
      ? quota.warmup.until
      : untilDate.toLocaleDateString();
    lines.push(
      '',
      `Warm-up (new paid account): shared-domain limit ${quota.warmup.shared_domain_daily_limit.toLocaleString()}/day until ${untilLabel} — verify your own domain for instant full volume.`,
    );
  }

  return lines.join('\n');
}

function formatLimit(limitBytes: number | null): string {
  return limitBytes === null ? 'No cap' : formatBytes(limitBytes);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${trimFixed(bytes / 1_000, 1)} KB`;
  if (bytes < 1_000_000_000) return `${trimFixed(bytes / 1_000_000, 1)} MB`;
  return `${trimFixed(bytes / 1_000_000_000, 2)} GB`;
}

function trimFixed(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
