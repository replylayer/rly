import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { formatSendResult, output } from '../format.js';
import { collectAttach, uploadAttachments } from '../attachments.js';
import { LocalCliError } from '../errors.js';
import { probeIdempotencyReplay } from '../lib/idempotency-probe.js';
import { strictExitCodeForEffect } from '../lib/strict-outcome.js';

export function replyCommand(): Command {
  return new Command('reply')
    .description('Reply to a message')
    .argument('<message-id>', 'Message UUID to reply to')
    .requiredOption('--body <body>', 'Reply body (plain text)')
    .option('--html <html>', 'Reply body (HTML)')
    .option('--instance <id>', 'Sub-address instance ID (HMAC secure-reply discriminator)')
    .option('--mode <reply_to|from|none>', 'Override mailbox default_subaddress_mode for this reply')
    .option('--attach <path>', 'Attach a file (Pro+; a human owner must enable outbound attachments in dashboard first; repeat for multiple)', collectAttach, [] as string[])
    .option('--idempotency-key <key>', 'Retry-safe identity for this reply. A network-retried same-key reply produces at most one email and one charge; use one stable key per reply intent.')
    .option('--strict', 'Exit non-zero on a non-delivered outcome (governed email-effect): blocked → 4, infrastructure hold → 5, unrecognized outcome → 6 (fail-closed). A human-releasable hold and a delivered reply stay exit 0. Default (no --strict) always exits 0.', false)
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const idempotencyKey: string | undefined = localOpts.idempotencyKey;
      const strict: boolean = localOpts.strict === true;

      // §3a probe-FIRST: when a key is set, replay-probe BEFORE the original
      // message fetch + any attachment upload. A same-key retry whose original
      // was deleted (or whose local attach file is gone) replays the prior result
      // here instead of dying on the getMessage / upload. `miss` → fall through.
      if (idempotencyKey) {
        const replay = await probeIdempotencyReplay(client, idempotencyKey);
        if (replay) {
          // F2 — the probe-replay path bypasses the server's strict status
          // remap, so apply the SAME exit mapping locally on the replayed
          // governed effect (blocked→4, infra→5, held/sent→0). Non-strict
          // callers keep the historical exit-0 behavior.
          if (strict) {
            process.exitCode = strictExitCodeForEffect(replay.email_effect?.effect_status);
          }
          output(replay, formatSendResult(replay), opts.json);
          return;
        }
      }

      // --attach uploads to a concrete mailbox (handles are single-mailbox-scoped
      // + consumed-once at dispatch). A reply's mailbox is the mailbox of the
      // message being replied to, so derive it from the message rather than
      // making the caller name it — unlike `send`, which has no message to
      // derive from and therefore requires --from.
      const attachPaths: string[] = localOpts.attach ?? [];
      let attachmentIds: string[] | undefined;
      if (attachPaths.length > 0) {
        const original = await client.getMessage(messageId);
        // Fail fast BEFORE uploading: the server rejects replies to outbound
        // messages (you reply to mail you received — messages.ts N7 guard), so
        // staging + scanning + storing local files first would be wasted work.
        if (original.direction === 'outbound') {
          // Surface the resolved thread id rather than a literal placeholder
          // (UAT-14, surface (c)) — `original` was just fetched and carries it.
          const threadId = original.thread_id ?? original.id;
          throw new LocalCliError(
            `Cannot reply to an outbound message. Use \`rly send --thread ${threadId}\` to continue this conversation.`,
            'VALIDATION_ERROR',
            { message_id: messageId, direction: original.direction, thread_id: threadId },
          );
        }
        attachmentIds = await uploadAttachments(client, attachPaths, original.mailbox_id);
      }

      const replyReq = {
        body: localOpts.body,
        html: localOpts.html,
        subaddress_instance_id: localOpts.instance,
        subaddress_mode: localOpts.mode,
        ...(attachmentIds ? { attachment_ids: attachmentIds } : {}),
      };
      // Forward both per-request opts. Under --strict a non-delivered outcome
      // returns a 422/409/503 carrying email_effect, which throws an ApiError
      // here; run()'s catch maps it to the strict exit code (blocked→4, infra→5;
      // held_for_review 409 → 0). The 200 path renders the effect inline.
      // Omit the opts arg entirely when neither key nor strict is set — keeps
      // the legacy two-argument call shape byte-identical.
      const replyOpts = {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(strict ? { strictOutcome: true } : {}),
      };
      const result =
        Object.keys(replyOpts).length > 0
          ? await client.reply(messageId, replyReq, replyOpts)
          : await client.reply(messageId, replyReq);

      output(result, formatSendResult(result), opts.json);
    });
}
