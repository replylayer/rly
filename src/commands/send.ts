import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { formatSendResult, output } from '../format.js';
import { LocalCliError } from '../errors.js';
import { resolveMailboxSelector } from '../resolve.js';
import { collectAttach, uploadAttachments } from '../attachments.js';
import { probeIdempotencyReplay } from '../lib/idempotency-probe.js';
import { strictExitCodeForEffect } from '../lib/strict-outcome.js';

export function sendCommand(): Command {
  return new Command('send')
    .description('Send an email (fresh send, or continue a thread with --thread)')
    // Fresh mode needs --from/--to/--subject; thread mode derives --from/--subject
    // and makes --to an optional participant selector — so none are `requiredOption`.
    // Mode rules are validated client-side below + authoritatively server-side.
    .option('--from <mailbox>', 'Mailbox name or ID to send from (derived in --thread mode)')
    .option('--to <email>', 'Recipient email address (optional participant selector in --thread mode)')
    .option('--subject <subject>', 'Email subject (derived as "Re: ..." in --thread mode unless given)')
    .requiredOption('--body <body>', 'Email body (plain text)')
    .option('--html <html>', 'Email body (HTML)')
    .option('--thread <thread-id>', 'Continue an existing thread (thread ID or root message UUID)')
    .option('--instance <id>', 'Sub-address instance ID (HMAC secure-reply discriminator)')
    .option('--mode <reply_to|from|none>', 'Override mailbox default_subaddress_mode for this send')
    .option('--attach <path>', 'Attach a file (Pro+; a human owner must enable outbound attachments in dashboard first; repeat for multiple)', collectAttach, [] as string[])
    .option('--idempotency-key <key>', 'Retry-safe identity for this send. A network-retried same-key send produces at most one email and one charge; use one stable key per send intent.')
    .option('--strict', 'Exit non-zero on a non-delivered outcome (governed email-effect): blocked → 4, infrastructure hold → 5, unrecognized outcome → 6 (fail-closed). A human-releasable hold and a delivered send stay exit 0. Default (no --strict) always exits 0.', false)
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();

      const threadId: string | undefined = localOpts.thread;
      const attachPaths: string[] = localOpts.attach ?? [];
      // Fresh mode: --from may come from REPLYLAYER_MAILBOX. Thread mode: --from
      // is the OPTIONAL thread disambiguator — do NOT seed it from the env var
      // (a single provisioned REPLYLAYER_MAILBOX would scope the thread to the
      // wrong mailbox and 404 a working `send --thread`; S6 plan §4.1/§5).
      const effectiveFrom: string | undefined = threadId
        ? localOpts.from
        : resolveMailboxSelector(localOpts.from);
      if (!threadId) {
        // Fresh mode — mirror the server's required-field rule for a clear,
        // network-free error. Validate args BEFORE requiring auth so a
        // malformed invocation reports the missing flags, not "no API key".
        const missing = ['to', 'subject'].filter((f) => !localOpts[f]);
        if (!effectiveFrom) missing.unshift('from');
        if (missing.length > 0) {
          throw new LocalCliError(
            `Fresh send requires --from, --to, and --subject (missing: ${missing.join(', ')}). Pass --thread <id> to continue a thread instead, or set REPLYLAYER_MAILBOX to default --from.`,
            'VALIDATION_ERROR',
            { missing },
            2,
          );
        }
      }
      // --attach uploads to a concrete mailbox (a handle is single-mailbox-scoped
      // and must match the send mailbox). In --thread mode the mailbox is derived
      // server-side, so an attachment needs an explicit --from to upload against.
      if (attachPaths.length > 0 && !effectiveFrom) {
        throw new LocalCliError(
          '--attach requires --from to identify the mailbox to upload to (the thread mailbox is derived server-side).',
          'VALIDATION_ERROR',
          { options: ['--attach', '--from'] },
          2,
        );
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const idempotencyKey: string | undefined = localOpts.idempotencyKey;
      const strict: boolean = localOpts.strict === true;

      // §3a probe-FIRST: when a key is set, replay-probe BEFORE uploading any
      // attachment. A same-key retry whose local file is gone (or whose prior
      // send is still in flight / not-proven-sent / bound to a draft) is resolved
      // here without wasting an upload. `miss` → fall through to the keyed send.
      if (idempotencyKey) {
        const replay = await probeIdempotencyReplay(client, idempotencyKey);
        if (replay) {
          // F2 — the probe-replay path (200 with the prior outcome in the body)
          // bypasses the server's strict status remap, so apply the SAME exit
          // mapping locally on the replayed governed effect. blocked→4, infra→5,
          // held/sent→0. Non-strict callers keep the historical exit-0 behavior.
          if (strict) {
            process.exitCode = strictExitCodeForEffect(replay.email_effect?.effect_status);
          }
          output(replay, formatSendResult(replay), opts.json);
          return;
        }
      }

      const attachmentIds =
        attachPaths.length > 0
          ? await uploadAttachments(client, attachPaths, effectiveFrom as string)
          : undefined;

      const sendReq = {
        // In thread mode from_mailbox/subject are derived; pass through when
        // given (from_mailbox doubles as a disambiguator). Fresh mode defaults
        // from_mailbox from REPLYLAYER_MAILBOX via effectiveFrom.
        from_mailbox: effectiveFrom,
        to: localOpts.to,
        subject: localOpts.subject,
        body: localOpts.body,
        html: localOpts.html,
        thread_id: threadId,
        subaddress_instance_id: localOpts.instance,
        subaddress_mode: localOpts.mode,
        ...(attachmentIds ? { attachment_ids: attachmentIds } : {}),
      };
      // Forward both per-request opts. Under --strict the server may answer a
      // non-delivered outcome with a 422/409/503 carrying email_effect — that
      // throws an ApiError here, and run()'s catch maps it to the strict exit
      // code (blocked→4, infra→5; held_for_review 409 → 0). The 200 success
      // path renders email_effect.effect_status inline via formatSendResult.
      // Omit the opts arg entirely when neither key nor strict is set — keeps
      // the legacy no-key call shape byte-identical (single argument).
      const sendOpts = {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(strict ? { strictOutcome: true } : {}),
      };
      const result =
        Object.keys(sendOpts).length > 0
          ? await client.send(sendReq, sendOpts)
          : await client.send(sendReq);

      output(result, formatSendResult(result), opts.json);
    });
}
