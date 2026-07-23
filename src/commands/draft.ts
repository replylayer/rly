import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError, EXIT } from '../errors.js';
import { resolveMailboxSelector } from '../resolve.js';
import { output, formatScanSummary, formatSendResult } from '../format.js';
import { ApiError } from '../types.js';
import { parseIntOption } from './_validate.js';
import { collectAttach, uploadAttachments } from '../attachments.js';
import type { DraftResponse, PolicyDecision } from '../protocol.js';

// Draft-send gate-rejects (DRAFT_REJECTED_BY_RESCAN / DRAFT_ALREADY_SENT) follow
// the canonical CLI exit-code contract: exit 1 (remote/API failure) with the
// JSON `code` field as the machine discriminator — NOT a distinct exit code
// (the old 2/3 collided with the documented 2=usage / 3=auth semantics). See
// docs/cli-machine-interface.md and the per-outcome `code` in the error JSON.

function colorDecision(d: PolicyDecision): string {
  if (!process.stdout.isTTY) return d;
  if (d === 'allow') return `\x1b[32m${d}\x1b[0m`;
  if (d === 'allow_with_warning' || d === 'quarantine' || d === 'require_human_approval') return `\x1b[33m${d}\x1b[0m`;
  return `\x1b[31m${d}\x1b[0m`;
}

function formatDraft(draft: DraftResponse): string {
  const lines: string[] = [];
  lines.push(`ID:            ${draft.id}`);
  lines.push(`State:         ${draft.state}`);
  lines.push(`From:          ${draft.sender}`);
  lines.push(`To:            ${draft.recipient}`);
  lines.push(`Subject:       ${draft.subject}`);
  lines.push(`Worst verdict: ${colorDecision(draft.worst_decision)}`);
  if (draft.in_reply_to) lines.push(`In-Reply-To:   ${draft.in_reply_to}`);
  if (draft.thread_id) lines.push(`Thread:        ${draft.thread_id}`);
  // Migration 040 — scheduled-send forensic surface. Only render when the
  // draft was (or is) scheduled; unscheduled drafts keep the compact layout.
  if (draft.send_at) {
    lines.push(`Scheduled:     ${draft.send_at}`);
  }
  if (draft.original_send_at && draft.original_send_at !== draft.send_at) {
    lines.push(`Originally:    ${draft.original_send_at}`);
  }
  if (typeof draft.send_attempts === 'number' && draft.send_attempts > 0) {
    lines.push(`Attempts:      ${draft.send_attempts}`);
  }
  if (draft.last_dispatch_error_code) {
    lines.push(`Last error:    ${draft.last_dispatch_error_code} at ${draft.last_dispatch_attempt_at ?? '?'}`);
  }
  if (draft.attachments && draft.attachments.length > 0) {
    const names = draft.attachments.map((a) => a.filename || a.upload_id || '(unnamed)').join(', ');
    lines.push(`Attachments:   ${names}`);
  }
  lines.push('');
  // Scan-summary block via shared format helper (formatScanSummary). Plan-B
  // hook: a future formatAgentSafetyContext block can be prepended above
  // without rewriting this function.
  const scanLines = formatScanSummary(draft.scan ?? null);
  lines.push(...scanLines);
  const bodyContent = draft.body?.content ?? null;
  if (bodyContent) {
    lines.push('');
    lines.push('Body:');
    lines.push(bodyContent);
    if (draft.body?.truncated) {
      lines.push(`(body truncated: ${draft.body.returned_char_count}/${draft.body.char_count} chars returned)`);
    }
  }
  return lines.join('\n');
}

export function draftCommand(): Command {
  const cmd = new Command('draft').description('Manage drafts (scan-then-review-then-send)');

  cmd
    .command('create')
    .description('Create a new draft. Scanner runs immediately; verdict attached to the draft.')
    // Fresh mode needs --mailbox/--to/--subject; --thread mode derives them
    // (--to is then an optional participant selector). Not requiredOption so
    // both modes parse; mode rules validated client-side + server-side.
    .option('--mailbox <id-or-name>', 'Mailbox name or UUID (derived in --thread mode)')
    .option('--to <email>', 'Recipient email (optional participant selector in --thread mode)')
    .option('--subject <subject>', 'Subject (derived as "Re: ..." in --thread mode unless given)')
    .requiredOption('--body <body>', 'Body (plain text)')
    .option('--html <html>', 'HTML body (optional)')
    .option('--reply-to <message-id>', 'Original message UUID to reply to (auto-derives thread + Re: subject)')
    .option('--thread <thread-id>', 'Continue an existing thread (thread ID or root message UUID)')
    .option('--instance <id>', 'Sub-address instance ID (HMAC secure-reply discriminator)')
    .option('--mode <reply_to|from|none>', 'Override mailbox default_subaddress_mode (literal "none" = no rewrite)')
    // Migration 040 — scheduled send. ISO-8601 with explicit offset or Z
    // (naive strings rejected server-side with 400 TIMEZONE_REQUIRED). When
    // present, the draft is persisted in state='draft' with send_at set and
    // the API-hosted poller dispatches it at that time through the full
    // send-time gate stack (scanner rescan, suppression, allowlist, etc.).
    .option('--send-at <iso>', 'Schedule this draft for future dispatch (ISO-8601 with offset, e.g. 2026-05-01T09:00:00Z). Dispatch failures arrive asynchronously via the message.dispatch_failed webhook, not as a synchronous CLI error.')
    // Idempotency-Key forwarded as HTTP header; only valid when --send-at
    // is also present. Replays within 24h return the prior row.
    .option('--idempotency-key <key>', 'Idempotency-Key header (scheduled send only; replays within 24h)')
    .option('--attach <path>', 'Attach a file (Pro+; a human owner must enable outbound attachments in dashboard first; repeat for multiple)', collectAttach, [] as string[])
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      const localOpts = command.opts();

      const threadId: string | undefined = localOpts.thread;
      const attachPaths: string[] = localOpts.attach ?? [];
      // Fresh mode: --mailbox may come from REPLYLAYER_MAILBOX. Thread mode:
      // --mailbox is the OPTIONAL thread disambiguator — do NOT seed it from the
      // env var (a mismatched REPLYLAYER_MAILBOX would 404 a working
      // `draft create --thread`; S6 plan §4.1/§5, mirrors send).
      const effectiveMailbox: string | undefined = threadId
        ? localOpts.mailbox
        : resolveMailboxSelector(localOpts.mailbox);
      // Validate args BEFORE requiring auth so a malformed invocation reports
      // the real problem rather than "no API key".
      if (threadId && localOpts.replyTo) {
        throw new LocalCliError(
          '--thread and --reply-to are mutually exclusive',
          'VALIDATION_ERROR',
          undefined,
          2,
        );
      }
      if (!threadId) {
        const missing = ['to', 'subject'].filter((f) => !localOpts[f]);
        if (!effectiveMailbox) missing.unshift('mailbox');
        if (missing.length > 0) {
          throw new LocalCliError(
            `A fresh draft requires --mailbox, --to, and --subject (missing: ${missing.join(', ')}). Pass --thread <id> to continue a thread instead, or set REPLYLAYER_MAILBOX to default --mailbox.`,
            'VALIDATION_ERROR',
            { missing },
            2,
          );
        }
      }
      // --attach uploads to a concrete mailbox (a handle is single-mailbox-scoped).
      // In --thread mode the mailbox is derived server-side, so an attachment
      // needs an explicit --mailbox to upload against.
      if (attachPaths.length > 0 && !effectiveMailbox) {
        throw new LocalCliError(
          '--attach requires --mailbox to identify the mailbox to upload to (the thread mailbox is derived server-side).',
          'VALIDATION_ERROR',
          { options: ['--attach', '--mailbox'] },
          2,
        );
      }
      // Scheduled drafts cannot carry attachments (the server rejects with
      // ATTACHMENTS_REQUIRE_SYNC_SEND). Reject up front — network-free — so we
      // never upload a file that the create call would then refuse.
      if (attachPaths.length > 0 && localOpts.sendAt) {
        throw new LocalCliError(
          'A scheduled draft cannot carry attachments — omit --send-at to attach files, or omit --attach to schedule.',
          'CONFLICTING_OPTIONS',
          { options: ['--attach', '--send-at'] },
          2,
        );
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const attachmentIds =
        attachPaths.length > 0
          ? await uploadAttachments(client, attachPaths, effectiveMailbox as string)
          : undefined;

      const payload = {
        mailbox_id: effectiveMailbox,
        to: localOpts.to,
        subject: localOpts.subject,
        body: localOpts.body,
        html: localOpts.html,
        in_reply_to_message_id: localOpts.replyTo,
        thread_id: threadId,
        subaddress_instance_id: localOpts.instance,
        subaddress_mode: localOpts.mode,
        ...(localOpts.sendAt ? { send_at: localOpts.sendAt } : {}),
        ...(attachmentIds ? { attachment_ids: attachmentIds } : {}),
      };
      const draft = localOpts.idempotencyKey
        ? await client.createDraft(payload, { idempotencyKey: localOpts.idempotencyKey })
        : await client.createDraft(payload);
      output(draft, formatDraft(draft), opts.json);
    });

  cmd
    .command('list')
    .description('List drafts for a mailbox')
    .requiredOption('--mailbox <id>', 'Mailbox name or UUID')
    .option('--limit <n>', 'Max results', '50')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      const localOpts = command.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // N2: validate the numeric option network-free (draft list makes no
      // pre-request mailbox resolution — mailbox passes straight through).
      const limit = parseIntOption(localOpts.limit, '--limit', 1, 200);
      const result = await client.listDrafts(localOpts.mailbox, { limit });
      const rows = result.drafts.map((d) => [
        d.id.substring(0, 8),
        d.recipient,
        d.subject.substring(0, 40),
        colorDecision(d.worst_decision),
        d.created_at,
      ]);
      const text = rows.length === 0
        ? '(no drafts)'
        : ['ID       Recipient                 Subject                            Verdict              Created', ...rows.map((r) => r.join('  '))].join('\n');
      output(result, text, opts.json);
    });

  cmd
    .command('show <draft-id>')
    .description('Show a draft (body + scan verdicts)')
    .action(async (draftId: string, _opts, command) => {
      const opts = command.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const draft = await client.getDraft(draftId);
      output(draft, formatDraft(draft), opts.json);
    });

  cmd
    .command('update <draft-id>')
    .description('Update a draft (re-runs scanner). Use --send-at none to cancel a schedule. Use --clear-instance / --clear-mode to clear those fields.')
    .option('--to <email>')
    .option('--subject <subject>')
    .option('--body <body>')
    .option('--html <html>')
    // Migration 035 — set / clear sub-address instance + mode via PATCH.
    // `--mode none` = the SubaddressMode enum value 'none' (no rewrite).
    // `--clear-instance` / `--clear-mode` = send null (mailbox default
    // applies). The two cannot be combined per field — caught up front.
    .option('--instance <id>', 'Set sub-address instance ID')
    .option('--clear-instance', 'Clear the previously-set instance ID (sends null — mailbox default applies)')
    .option('--mode <reply_to|from|none>', 'Set subaddress_mode (literal "none" = no rewrite, NOT clear)')
    .option('--clear-mode', 'Clear the previously-set mode (sends null — mailbox default applies)')
    // Migration 040 — scheduled send (un)schedule + reschedule via PATCH.
    // `--send-at none` is the explicit cancel verb (no separate unschedule
    // subcommand per plan L3). Omit the flag entirely to leave send_at
    // untouched. Any ISO string shifts the schedule and resets attempt
    // budget per plan §M6.
    .option('--send-at <iso-or-none>', 'Schedule / reschedule (ISO-8601) or "none" to cancel')
    // Outbound attachments — replace the draft's attachment set with the
    // uploaded files, or clear them entirely. Mutually exclusive (caught up
    // front). The upload mailbox is the draft's own mailbox (fetched below).
    .option('--attach <path>', 'Replace draft attachments (Pro+; human owner must enable outbound attachments in dashboard first; repeat for multiple)', collectAttach, [] as string[])
    .option('--clear-attachments', 'Remove all attachments from the draft (sends null)')
    .action(async (draftId: string, _opts, command) => {
      const opts = command.optsWithGlobals();
      const localOpts = command.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const attachPaths: string[] = localOpts.attach ?? [];

      // Reject conflicting set/clear pairs before any API call. The CLI
      // is the single source of truth for this UX rule — the server would
      // 400 either combination, but the up-front rejection means no token
      // burn + a clearer error message.
      if (localOpts.instance !== undefined && localOpts.clearInstance) {
        throw new LocalCliError(
          '--instance and --clear-instance are mutually exclusive',
          'CONFLICTING_OPTIONS',
          { options: ['--instance', '--clear-instance'] },
        );
      }
      if (localOpts.mode !== undefined && localOpts.clearMode) {
        throw new LocalCliError(
          '--mode and --clear-mode are mutually exclusive',
          'CONFLICTING_OPTIONS',
          { options: ['--mode', '--clear-mode'] },
        );
      }
      if (attachPaths.length > 0 && localOpts.clearAttachments) {
        throw new LocalCliError(
          '--attach and --clear-attachments are mutually exclusive',
          'CONFLICTING_OPTIONS',
          { options: ['--attach', '--clear-attachments'] },
        );
      }
      // Scheduled drafts cannot carry attachments (server rejects with
      // ATTACHMENTS_REQUIRE_SYNC_SEND). `--send-at none` clears the schedule, so
      // it is compatible with --attach; any other --send-at is not.
      if (attachPaths.length > 0 && localOpts.sendAt !== undefined && localOpts.sendAt !== 'none') {
        throw new LocalCliError(
          'A scheduled draft cannot carry attachments — omit --send-at to attach files, or pass --send-at none to clear the schedule first.',
          'CONFLICTING_OPTIONS',
          { options: ['--attach', '--send-at'] },
        );
      }

      // Upload new attachments (if any) to the draft's OWN mailbox — a handle is
      // single-mailbox-scoped, and the draft's mailbox is the eventual send
      // mailbox. Fetch it after the network-free conflict checks above.
      let attachmentIds: string[] | undefined;
      if (attachPaths.length > 0) {
        const existing = await client.getDraft(draftId);
        // Adding attachments to an already-scheduled draft is rejected by the
        // server — surface it here (we hold the draft anyway) so we don't waste
        // an upload. `--send-at none` in the same patch clears the schedule, so
        // it stays allowed.
        if (existing.send_at && localOpts.sendAt !== 'none') {
          throw new LocalCliError(
            'This draft is scheduled (send_at) — a scheduled draft cannot carry attachments. Clear the schedule (--send-at none) before attaching, or send it synchronously.',
            'CONFLICTING_OPTIONS',
            { options: ['--attach', '--send-at'] },
          );
        }
        attachmentIds = await uploadAttachments(client, attachPaths, existing.mailbox_id);
      }

      const patch: Record<string, string | string[] | null> = {};
      if (localOpts.to) patch.to = localOpts.to;
      if (localOpts.subject) patch.subject = localOpts.subject;
      if (localOpts.body) patch.body = localOpts.body;
      if (localOpts.html) patch.html = localOpts.html;
      if (localOpts.sendAt !== undefined) {
        // `--send-at none` → null (cancel). Any other string → forwarded
        // verbatim to the server (validate-send-at.ts is authoritative).
        patch.send_at = localOpts.sendAt === 'none' ? null : localOpts.sendAt;
      }
      // Set OR clear, never both (conflict rejected above). `--mode none`
      // here passes through verbatim as the enum value 'none'.
      if (localOpts.instance !== undefined) patch.subaddress_instance_id = localOpts.instance;
      if (localOpts.clearInstance) patch.subaddress_instance_id = null;
      if (localOpts.mode !== undefined) patch.subaddress_mode = localOpts.mode;
      if (localOpts.clearMode) patch.subaddress_mode = null;
      // attachment_ids: array replaces the set, null clears all, omitted = no change.
      if (attachmentIds) patch.attachment_ids = attachmentIds;
      if (localOpts.clearAttachments) patch.attachment_ids = null;

      const draft = await client.updateDraft(draftId, patch);
      output(draft, formatDraft(draft), opts.json);
    });

  cmd
    .command('send <draft-id>')
    .description('Send a draft (re-runs scanner authoritatively)')
    .action(async (draftId: string, _opts, command) => {
      const opts = command.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      try {
        const result = await client.sendDraft(draftId);
        // Reuse the shared formatter so an allow_with_warning send-time
        // warning surfaces on the default CLI path (parity with
        // `rly send` / `inbox reply`). The legacy bespoke string
        // dropped result.warning entirely.
        output(result, formatSendResult(result), opts.json);
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'DRAFT_REJECTED_BY_RESCAN') {
            // Surface the verdict detail.
            const details = err.details as {
              worst_decision?: PolicyDecision;
              scan?: import('../protocol.js').ScanSummary;
            } | undefined;
            const summary = details?.worst_decision
              ? `Rejected by send-time scan: ${details.worst_decision}`
              : 'Rejected by send-time scan';
            if (opts.json) {
              console.error(JSON.stringify({ error: err.message, code: err.code, details }, null, 2));
            } else {
              console.error(summary);
              if (details?.scan) {
                for (const line of formatScanSummary(details.scan)) {
                  console.error(line);
                }
              }
            }
            process.exitCode = EXIT.FAILURE;
            return;
          }
          if (err.code === 'DRAFT_ALREADY_SENT') {
            if (opts.json) {
              console.error(JSON.stringify({ error: err.message, code: err.code }, null, 2));
            } else {
              console.error('Draft has already been sent');
            }
            process.exitCode = EXIT.FAILURE;
            return;
          }
        }
        throw err;
      }
    });

  cmd
    .command('delete <draft-id>')
    .description('Soft-delete a draft')
    .action(async (draftId: string, _opts, command) => {
      const opts = command.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      await client.deleteDraft(draftId);
      output({ deleted: true }, `Deleted draft ${draftId}`, opts.json);
    });

  return cmd;
}
