import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { ApiError } from '../types.js';
import { output, formatTable } from '../format.js';
import { resolveMailboxId, resolveMailboxSelector } from '../resolve.js';
import type {
  MailboxPolicyResponse,
  AccountPolicyResponse,
  PolicyPreviewResponse,
  AgentAuthoringMode,
  MailboxHitlMode,
  DefaultPolicyMode,
} from '../types.js';

// The one dashboard page every policy-loosening refusal points at.
const POLICY_DASHBOARD_URL = 'https://app.replylayer.ai/policy';

export function policyCommand(): Command {
  const policy = new Command('policy').description('Read, preview, and tighten agent policy');
  policy.addCommand(showCommand());
  policy.addCommand(checkCommand());
  policy.addCommand(setModeCommand());
  policy.addCommand(capCommand());
  policy.addCommand(windowCommand());
  return policy;
}

// ---------------------------------------------------------------------------
// rly policy show --mailbox <id>
// ---------------------------------------------------------------------------
function showCommand(): Command {
  return new Command('show')
    .description('Show the effective policy for a mailbox (works with agent-scoped keys)')
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, opts.mailbox as string);
      const result = await client.getMailboxPolicy(id);
      output(result, formatMailboxPolicy(result), opts.json);
    });
}

// ---------------------------------------------------------------------------
// rly policy check --mailbox <id> --to a@b.com [--subject] [--body-file] [--at] [--content-scan]
// ---------------------------------------------------------------------------
function checkCommand(): Command {
  return new Command('check')
    .description('Dry-run: preview what your policy would do to a sample agent send')
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .requiredOption('--to <email>', 'Sample recipient address')
    .option('--subject <text>', 'Sample subject')
    .option('--body-file <path>', 'Read the sample body from a file')
    .option('--at <iso-time>', 'Evaluate the send window as of this ISO-8601 instant')
    .option('--content-scan', 'Also run the content-analysis layer (off by default)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, opts.mailbox as string);

      let body: string | undefined;
      if (localOpts.bodyFile) {
        try {
          body = await readFile(localOpts.bodyFile as string, 'utf8');
        } catch {
          throw new LocalCliError(
            `Could not read --body-file '${localOpts.bodyFile}'.`,
            'FILE_READ_ERROR',
            undefined,
            2,
          );
        }
      }

      const result = await client.previewMailboxPolicy(id, {
        to: localOpts.to as string,
        subject: localOpts.subject as string | undefined,
        body,
        at_time: localOpts.at as string | undefined,
        run_content_scan: localOpts.contentScan === true,
      });
      output(result, formatPreview(result), opts.json);
    });
}

// ---------------------------------------------------------------------------
// rly policy set-mode <mode> --mailbox <id> | --all-mailboxes
// ---------------------------------------------------------------------------
const MODES: DefaultPolicyMode[] = ['read_only', 'draft_only', 'supervised', 'trusted'];

function setModeCommand(): Command {
  return new Command('set-mode')
    .description('Apply a policy mode to a mailbox (one-command lockdown with --all-mailboxes)')
    .argument('<mode>', `One of: ${MODES.join(', ')}`)
    .option('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .option('--all-mailboxes', 'Apply to every mailbox (client-side iteration)')
    .option(
      '--force-empty',
      'Acknowledge applying a restricting mode to a mailbox whose recipient allowlist is empty (agent sends to new/off-thread recipients are blocked until entries are added; in-thread replies and human sends are unaffected)',
    )
    .action(async (mode: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      if (!MODES.includes(mode as DefaultPolicyMode)) {
        throw new LocalCliError(`Unknown mode '${mode}'. Use one of: ${MODES.join(', ')}.`, 'INVALID_OPTION', undefined, 2);
      }
      const targetMode = mode as DefaultPolicyMode;
      const selector = resolveMailboxSelector(localOpts.mailbox as string | undefined);
      const all = localOpts.allMailboxes === true;
      if (all && selector) {
        throw new LocalCliError('Pass either --mailbox or --all-mailboxes, not both.', 'INVALID_OPTION', undefined, 2);
      }
      if (!all && !selector) {
        throw new LocalCliError('Specify --mailbox <name-or-id> or --all-mailboxes.', 'MISSING_REQUIRED_OPTION', undefined, 2);
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // Resolve the target mailbox set.
      const targets: { id: string; name: string }[] = [];
      if (all) {
        const { mailboxes } = await client.listMailboxes();
        for (const m of mailboxes) targets.push({ id: m.id, name: m.name });
      } else {
        const id = await resolveMailboxId(client, selector!);
        targets.push({ id, name: selector! });
      }

      const forceEmpty = localOpts.forceEmpty === true;
      const rows: string[][] = [];
      const results: { mailbox: string; outcome: 'applied' | 'refused'; detail: string }[] = [];
      let anyReauthRefused = false;
      let anyEmptyRefused = false;

      for (const t of targets) {
        // Pre-check direction client-side so a loosening applies NOTHING (never a
        // partial write) and we can name exactly which fields loosen. The server
        // stays authoritative — a PATCH we believe tightens still gets 403'd there.
        const current = await client.getMailboxPolicy(t.id);
        const loosening = describeModeLoosening(current, targetMode);
        if (loosening.length > 0) {
          anyReauthRefused = true;
          rows.push([t.name, 'refused', loosening.join('; ')]);
          results.push({ mailbox: t.id, outcome: 'refused', detail: loosening.join('; ') });
          continue;
        }
        try {
          // FR-03 (final review 2026-07-16): a restricting mode on an OPEN
          // mailbox resolves to the native allowlist (PB-001 Option B), so an
          // empty list trips the server's ALLOWLIST_EMPTY pre-flip guard.
          // --force-empty passes the same acknowledgment the dashboard modal
          // sends, so this command can finish the documented tightening in
          // one step instead of dead-ending on the 400.
          await client.updateMailbox(t.id, {
            apply_policy_mode: targetMode,
            ...(forceEmpty ? { force_empty: true } : {}),
          });
          rows.push([t.name, 'applied', targetMode]);
          results.push({ mailbox: t.id, outcome: 'applied', detail: targetMode });
        } catch (err) {
          if (err instanceof ApiError && err.code === 'REAUTH_REQUIRES_SESSION') {
            anyReauthRefused = true;
            rows.push([t.name, 'refused', 'loosening needs the dashboard']);
            results.push({ mailbox: t.id, outcome: 'refused', detail: 'REAUTH_REQUIRES_SESSION' });
            continue;
          }
          if (err instanceof ApiError && err.code === 'ALLOWLIST_EMPTY') {
            anyEmptyRefused = true;
            rows.push([t.name, 'refused', 'empty allowlist — re-run with --force-empty or add a recipient']);
            results.push({ mailbox: t.id, outcome: 'refused', detail: 'ALLOWLIST_EMPTY' });
            continue;
          }
          throw err;
        }
      }

      const human = [
        formatTable(['MAILBOX', 'OUTCOME', 'DETAIL'], rows),
        ...(anyReauthRefused
          ? [
              '',
              `Some mailboxes were not changed: applying '${targetMode}' would loosen agent power there.`,
              `Loosening a policy needs a re-authenticated dashboard session: ${POLICY_DASHBOARD_URL}`,
            ]
          : []),
        ...(anyEmptyRefused
          ? [
              '',
              'Some mailboxes were not changed: their recipient allowlist is empty.',
              'Add an approved recipient first (rly mailbox allowlist add <mailbox> <email>), or',
              `re-run \`rly policy set-mode ${targetMode} ... --force-empty\` to acknowledge — agent sends`,
              'to new/off-thread recipients are blocked until entries are added (in-thread replies',
              'and your own dashboard/admin sends are unaffected).',
            ]
          : []),
      ].join('\n');

      output({ mode: targetMode, results }, human, opts.json);
      if (anyReauthRefused) {
        throw new LocalCliError('One or more mailboxes refused: loosening requires the dashboard.', 'REAUTH_REQUIRES_SESSION', { mode: targetMode }, 1);
      }
      if (anyEmptyRefused) {
        throw new LocalCliError('One or more mailboxes refused: empty recipient allowlist. Re-run with --force-empty to acknowledge, or add an entry first.', 'ALLOWLIST_EMPTY', { mode: targetMode }, 1);
      }
    });
}

// ---------------------------------------------------------------------------
// rly policy cap --daily N | --clear
// ---------------------------------------------------------------------------
function capCommand(): Command {
  return new Command('cap')
    .description('Set or clear your account daily send cap')
    .option('--daily <n>', 'Set the account-wide daily send cap (positive integer)')
    .option('--clear', 'Remove the account daily cap (loosening — dashboard only)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const hasDaily = localOpts.daily !== undefined;
      const hasClear = localOpts.clear === true;
      if (hasDaily === hasClear) {
        throw new LocalCliError('Pass exactly one of --daily <n> or --clear.', 'INVALID_OPTION', undefined, 2);
      }

      let cap: number | null;
      if (hasClear) {
        cap = null;
      } else {
        const n = Number(localOpts.daily);
        if (!Number.isInteger(n) || n < 1) {
          throw new LocalCliError('--daily must be a positive integer. To pause sending entirely, use `rly policy set-mode read_only`.', 'INVALID_OPTION', undefined, 2);
        }
        cap = n;
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      try {
        const result = await client.updateAccountPolicy({ custom_daily_send_limit: cap });
        const msg = cap === null
          ? 'Account daily cap cleared.'
          : `Account daily cap set to ${cap.toLocaleString()}/day.`;
        output(result, msg, opts.json);
      } catch (err) {
        rethrowLooseningWithPointer(err, opts.json, 'Raising or clearing the account cap');
      }
    });
}

// ---------------------------------------------------------------------------
// rly policy window --mailbox <id> --timezone ... | --remove
// ---------------------------------------------------------------------------
function windowCommand(): Command {
  return new Command('window')
    .description('Set or remove a mailbox send window (agent-origin sends only)')
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .option('--timezone <iana>', 'IANA timezone, e.g. Europe/London')
    .option('--days <list>', 'Comma-separated days, e.g. mon,tue,wed,thu,fri')
    .option('--start <hh:mm>', 'Window open time, 24h HH:MM')
    .option('--end <hh:mm>', 'Window close time, 24h HH:MM')
    .option('--outside-action <action>', 'require_approval | block', 'require_approval')
    .option('--remove', 'Remove the send window (always-open — loosening, dashboard only)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const id = await resolveMailboxId(client, opts.mailbox as string);

      if (localOpts.remove) {
        try {
          const result = await client.updateMailbox(id, { send_window: null });
          output(result, 'Send window removed (mailbox is always open).', opts.json);
        } catch (err) {
          rethrowLooseningWithPointer(err, opts.json, 'Removing or widening a send window');
        }
        return;
      }

      const missing = ['timezone', 'days', 'start', 'end'].filter((k) => !localOpts[k]);
      if (missing.length > 0) {
        throw new LocalCliError(
          `Setting a window needs --timezone, --days, --start, --end (missing: ${missing.map((m) => `--${m}`).join(', ')}). Use --remove to clear it.`,
          'MISSING_REQUIRED_OPTION',
          undefined,
          2,
        );
      }
      const outsideAction = localOpts.outsideAction as string;
      if (outsideAction !== 'require_approval' && outsideAction !== 'block') {
        throw new LocalCliError('--outside-action must be require_approval or block.', 'INVALID_OPTION', undefined, 2);
      }

      const window = {
        timezone: localOpts.timezone as string,
        days: (localOpts.days as string).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
        start: localOpts.start as string,
        end: localOpts.end as string,
        outside_action: outsideAction as 'require_approval' | 'block',
      };
      try {
        const result = await client.updateMailbox(id, { send_window: window });
        output(
          result,
          `Send window set: ${window.days.join(',')} ${window.start}–${window.end} ${window.timezone} (outside: ${window.outside_action}).`,
          opts.json,
        );
      } catch (err) {
        rethrowLooseningWithPointer(err, opts.json, 'Widening a send window');
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A policy loosening is a dashboard-only action (session + fresh re-auth). When
 * a bearer PATCH returns 403 REAUTH_REQUIRES_SESSION, print the specific policy
 * page (the shared code-keyed hint can't tell policy from attachments apart) and
 * rethrow so the exit code stays non-zero.
 */
function rethrowLooseningWithPointer(err: unknown, json: boolean, whatLoosens: string): never {
  if (err instanceof ApiError && err.code === 'REAUTH_REQUIRES_SESSION') {
    if (!json) {
      console.error('');
      console.error(`${whatLoosens} loosens your policy, which needs a re-authenticated dashboard session (not an API key).`);
      console.error(`Do it here: ${POLICY_DASHBOARD_URL}`);
    }
    throw err;
  }
  throw err;
}

// Mode application writes exactly the identity fields the template DEFINES
// (§3.1 algorithm 1). We mirror that here so a client-side pre-check names only
// the fields the apply would actually change.
function modeIdentityWrites(mode: DefaultPolicyMode): {
  agent_authoring_mode?: AgentAuthoringMode;
  agent_send_policy?: 'restricted' | 'open';
  hitl_mode?: MailboxHitlMode;
} {
  switch (mode) {
    case 'read_only':
      return { agent_authoring_mode: 'read_only' };
    case 'draft_only':
      return { agent_authoring_mode: 'draft_only', agent_send_policy: 'restricted' };
    case 'supervised':
      return { agent_authoring_mode: 'send_and_draft', agent_send_policy: 'restricted', hitl_mode: 'risky_only' };
    case 'trusted':
      return { agent_authoring_mode: 'send_and_draft', agent_send_policy: 'restricted', hitl_mode: 'disabled' };
  }
}

// §3.5 ordinals. authoring/send_policy: higher = looser. hitl: higher = stricter.
const AUTHORING_ORD: Record<AgentAuthoringMode, number> = { read_only: 0, draft_only: 1, send_and_draft: 2 };
const SEND_POLICY_ORD: Record<'restricted' | 'open', number> = { restricted: 0, open: 1 };
const HITL_ORD: Record<MailboxHitlMode, number> = { disabled: 0, risky_only: 1, all_outbound: 2 };

/**
 * Names each identity field that applying `mode` would LOOSEN relative to the
 * mailbox's current state (empty array => the apply is tightening/neutral).
 * Mirrors the §3.5 direction table for the three identity columns.
 */
export function describeModeLoosening(current: MailboxPolicyResponse, mode: DefaultPolicyMode): string[] {
  const writes = modeIdentityWrites(mode);
  const reasons: string[] = [];

  if (writes.agent_authoring_mode && writes.agent_authoring_mode !== current.agent_authoring_mode) {
    if (AUTHORING_ORD[writes.agent_authoring_mode] > AUTHORING_ORD[current.agent_authoring_mode]) {
      reasons.push(
        writes.agent_authoring_mode === 'send_and_draft' ? 'enables agent sending' : 'enables agent drafting',
      );
    }
  }
  if (writes.agent_send_policy && writes.agent_send_policy !== current.agent_send_policy) {
    if (SEND_POLICY_ORD[writes.agent_send_policy] > SEND_POLICY_ORD[current.agent_send_policy]) {
      reasons.push('opens agent sends to any recipient');
    }
  }
  if (writes.hitl_mode && writes.hitl_mode !== current.hitl_mode) {
    if (HITL_ORD[writes.hitl_mode] < HITL_ORD[current.hitl_mode]) {
      reasons.push('reduces human review of agent sends');
    }
  }
  return reasons;
}

// Human-facing labels for hitl_mode — matches the dashboard policy builder's
// vocabulary (mirrors the dashboard policy editor labels)
// so `rly policy show` and the dashboard describe the same posture the same way.
const HITL_LABELS: Record<MailboxHitlMode, string> = {
  disabled: 'Off',
  risky_only: 'Unusual sends only',
  all_outbound: 'Every send',
};

// The global rollout levers (risky_only / send_window) can hold a stored
// posture that isn't live yet — see PolicyEnforcement. This suffix is the
// honesty line so a stored-but-inactive control never reads as though it binds.
const NOT_YET_ACTIVE = '(saved — not yet active on this deployment)';

function formatMailboxPolicy(p: MailboxPolicyResponse): string {
  const modeLabel = p.policy_mode === 'custom' && p.last_applied_policy_mode
    ? `custom (was ${p.last_applied_policy_mode})`
    : p.policy_mode;
  const win = p.send_window
    ? `${p.send_window.days.join(',')} ${p.send_window.start}–${p.send_window.end} ${p.send_window.timezone} (outside: ${p.send_window.outside_action})`
    : 'always open';
  const humanReviewLabel = p.hitl_mode === 'risky_only' && p.enforcement.risky_only !== 'enforce'
    ? `${HITL_LABELS[p.hitl_mode]} — ${NOT_YET_ACTIVE}`
    : HITL_LABELS[p.hitl_mode];
  const sendWindowLabel = p.send_window && p.enforcement.send_window !== 'enforce'
    ? `${win} — ${NOT_YET_ACTIVE}`
    : win;
  const lines = [
    'Mailbox policy',
    '',
    `Mode:              ${modeLabel}`,
    `Agent authoring:   ${p.agent_authoring_mode}`,
    `Agent sends:       ${p.agent_send_policy}${p.restricted_by ? ` (restricted by ${p.restricted_by})` : ''}`,
    `Thread replies:    ${p.allow_thread_replies ? 'allowed' : 'not allowed'}`,
    `Human review:      ${humanReviewLabel}`,
    `Approval expiry:   ${p.approval_expiry}`,
    `Send window:       ${sendWindowLabel}`,
    `Recipient policy:  ${p.recipient_policy_mode}`,
    `Latest revision:   ${p.latest_revision_id ?? '(none)'}`,
    '',
    // What binds THIS key — the self-knowledge preflight.
    p.binding.scope === 'admin'
      ? 'This key: admin/session — human-exempt; every verb is permitted.'
      : `This key: agent — permitted verbs: ${p.binding.permitted_verbs.length > 0 ? p.binding.permitted_verbs.join(', ') : '(none — authoring disabled)'}`,
  ];
  return lines.join('\n');
}

function formatPreview(r: PolicyPreviewResponse): string {
  const lines: string[] = ['Policy preview', ''];
  const rows = r.trace.map((t) => [t.gate, t.outcome, t.reason]);
  lines.push(formatTable(['GATE', 'OUTCOME', 'REASON'], rows));
  lines.push('');
  lines.push(`Result:  ${r.result_summary}`);
  lines.push(`Effect:  ${r.email_effect.effect_status}`);
  lines.push(`Budget:  ${r.budget.remaining}/${r.budget.limit} remaining${r.budget.warmup_applied ? ' (warm-up applied)' : ''}`);
  // The honesty line — the deterministic gates always run; the content layer
  // runs only with --content-scan, so an unqualified "would send" is never shown.
  if (!r.content_scan_run) {
    lines.push('');
    lines.push('Note: content analysis was not run — this reflects the deterministic checks only.');
    lines.push('Re-run with --content-scan to include content analysis.');
  }
  return lines.join('\n');
}
