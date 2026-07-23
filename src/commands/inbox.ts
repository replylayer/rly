import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { ApiError } from '../types.js';
import type { AttachmentPreviewResponse, AttachmentDownloadUrlResponse } from '../types.js';
import { requireApiKey } from '../auth.js';
import { resolveMailboxId, resolveMailboxSelector } from '../resolve.js';
import { LocalCliError } from '../errors.js';
import {
  formatTable,
  formatMessage,
  formatMessageRow,
  formatThreadList,
  formatThread,
  output,
} from '../format.js';
import { resolveSearchOperators } from '../lib/search-operators.js';
import { parseIntOption } from './_validate.js';

// S7 NTH-001 — hard cap on the batch-read fan-out. GET /v1/messages/:id is
// per-key rate-limited; 20 stays well under the per-window budget and bounds
// connection concurrency. Not configurable in v1.
const MAX_BATCH_READ_IDS = 20;

// N1 — per-poll cap. Stay below the Railway edge/proxy ~10-15s non-JSON-error
// cut threshold AND the server's own timeoutSec floor, so a healthy empty poll
// RESOLVES {message:null} (server return ~9s) before the 14s client abort
// (waitForMessage's AbortSignal.timeout = (pollTimeout+5)*1000). The reconnect
// loop covers the user's total --timeout.
const MAX_POLL_SECONDS = 9;

// RL-UAT-021 / N1 — fail-closed allowlist of known-transient codes. ApiError.code
// is typed string but may hold a numeric at runtime (handleError passes
// errorBody.code verbatim — the U2 wart owned by S2). Match BOTH the string forms
// produced today AND the numeric form so this predicate keeps working after S2's
// coercion lands. Anything not transient is fatal (propagates to exit 1).
const TRANSIENT_WAIT_CODES = new Set([
  'PARSE_ERROR', // non-JSON 200/5xx body (heartbeat bytes)
  'NETWORK_ERROR', // fetch failed mid-long-poll (incl. a fired AbortSignal.timeout)
  'HTTP_502', 'HTTP_503', 'HTTP_504',
  '502', '503', '504', // string-coerced after S2
]);

export function isTransientWaitError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const code = String(err.code); // numeric-safe (U2 wart)
  if (TRANSIENT_WAIT_CODES.has(code)) return true;
  // Belt-and-braces: any 5xx statusCode is transient for a long-poll.
  return err.statusCode >= 500 && err.statusCode <= 599;
}

export function inboxCommand(): Command {
  const inbox = new Command('inbox').description('Read and manage messages');

  inbox.addCommand(listCommand());
  inbox.addCommand(readCommand());
  inbox.addCommand(waitCommand());
  inbox.addCommand(markReadCommand());
  inbox.addCommand(markThreadReadCommand());
  inbox.addCommand(approveReviewCommand());
  inbox.addCommand(denyReviewCommand());
  inbox.addCommand(releaseCommand());
  inbox.addCommand(blockCommand());
  inbox.addCommand(reportCommand());
  inbox.addCommand(deleteCommand());
  // S7 — thread-oriented browsing + star surface.
  inbox.addCommand(threadsCommand());
  inbox.addCommand(starCommand());
  inbox.addCommand(unstarCommand());
  // RL-UAT-013 — agent-facing attachment safe-text-preview retrieval.
  inbox.addCommand(attachmentCommand());

  return inbox;
}

function approveReviewCommand(): Command {
  return new Command('approve')
    .description(
      'Approve a state=pending_review message and dispatch it (human-in-the-loop review). ' +
        'Wire status reports the dispatch outcome (sent/blocked). Audit + ' +
        'webhook fire regardless. Auth: admin keys + session only — agent ' +
        'keys 403.',
    )
    .argument('<message-id>', 'Message UUID')
    .option('--reason <text>', 'Optional reason text (max 500 chars) — persisted to audit + webhook')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.approveReview(messageId, {
        reason: localOpts.reason,
      });

      const text = result.status === 'sent'
        ? `Approved + sent: ${result.message_id}`
        : `Approved but dispatch blocked by provider: ${result.message_id}`;
      output(result, text, opts.json);
    });
}

function denyReviewCommand(): Command {
  return new Command('deny')
    .description(
      'Deny a state=pending_review message; transitions to terminal blocked ' +
        '(no dispatch). Auth: admin keys + session only — agent keys 403.',
    )
    .argument('<message-id>', 'Message UUID')
    .option('--reason <text>', 'Optional reason text (max 500 chars) — persisted to audit + webhook')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.denyReview(messageId, {
        reason: localOpts.reason,
      });

      output(result, `Denied: ${result.message_id}`, opts.json);
    });
}

function releaseCommand(): Command {
  return new Command('release')
    .description(
      'Release a state=quarantined INBOUND message back into the inbox ' +
        '(→ available). INBOUND-ONLY: refuses an outbound row, because ' +
        'releasing an outbound quarantine re-sends it via the provider. ' +
        'Auth: admin OR mailbox-bound agent keys.',
    )
    .argument('<message-id>', 'Message UUID')
    .option('--reason <text>', 'Optional reason text (max 500 chars) — persisted to the audit log')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // Inbound-only guard (the server /release self-dispatches an outbound
      // quarantine via Mailgun). Pre-fetch direction; fail loud on outbound.
      const message = await client.getMessage(messageId);
      if (message.direction === 'outbound') {
        throw new LocalCliError(
          'Cannot release an outbound message from the CLI — releasing an ' +
            'outbound quarantine re-sends it. Release it from the dashboard, ' +
            'or via the API: POST /v1/messages/:id/release (SDK messages.release(id)).',
          'OUTBOUND_RELEASE_REFUSED',
          { message_id: messageId, direction: 'outbound' },
          2,
        );
      }

      const result = await client.release(messageId, { reason: localOpts.reason });
      output(result, `Released message ${result.message_id} (now available).`, opts.json);
    });
}

function blockCommand(): Command {
  return new Command('block')
    .description(
      'Block a state=quarantined INBOUND message (→ terminal blocked, no ' +
        'delivery). INBOUND-ONLY: refuses an outbound row for symmetry with ' +
        'release. Auth: admin OR mailbox-bound agent keys.',
    )
    .argument('<message-id>', 'Message UUID')
    .option('--reason <text>', 'Optional reason text (max 500 chars) — persisted to the audit log')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const message = await client.getMessage(messageId);
      if (message.direction === 'outbound') {
        throw new LocalCliError(
          'Cannot block an outbound message from the CLI — `inbox block` is ' +
            'inbound-only. Manage outbound quarantines from the dashboard.',
          'OUTBOUND_BLOCK_REFUSED',
          { message_id: messageId, direction: 'outbound' },
          2,
        );
      }

      const result = await client.block(messageId, { reason: localOpts.reason });
      output(result, `Blocked message ${result.message_id}.`, opts.json);
    });
}

function reportCommand(): Command {
  return new Command('report')
    .description(
      'Report & block an INBOUND message: blocks a held message and adds the ' +
        'sender to your account-wide inbound blocklist (idempotent). INBOUND-ONLY: ' +
        'refuses an outbound row (an outbound message has no inbound sender to ' +
        'block). Auth: admin OR mailbox-bound agent keys.',
    )
    .argument('<message-id>', 'Message UUID')
    .option('--reason <text>', 'Optional reason text (max 500 chars) — persisted to the audit log')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const message = await client.getMessage(messageId);
      if (message.direction === 'outbound') {
        throw new LocalCliError(
          'Cannot report an outbound message — `inbox report` is inbound-only ' +
            '(an outbound message has no inbound sender to block).',
          'OUTBOUND_REPORT_REFUSED',
          { message_id: messageId, direction: 'outbound' },
          2,
        );
      }

      const result = await client.report(messageId, { reason: localOpts.reason });
      const blockedNote = result.blocked ? ' (message blocked)' : '';
      const senderNote = result.sender_blocklisted
        ? `sender ${result.sender_blocklisted} added to blocklist`
        : 'sender could not be resolved (not blocklisted)';
      output(result, `Reported message ${result.message_id} — ${senderNote}${blockedNote}.`, opts.json);
    });
}

function deleteCommand(): Command {
  return new Command('delete')
    .description(
      'Delete a message and purge its raw MIME from object storage. Works on ' +
        'any direction (inbound or outbound) in a deletable state; idempotent ' +
        '(re-delete returns success). Auth: admin + session always; agent keys ' +
        'only when agent message-deletion is enabled on the account (else 403). ' +
        'Active legal hold or a non-deletable state → 409.',
    )
    .argument('<message-id>', 'Message UUID')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // Direction-agnostic: the server route purges bytes for inbound and
      // outbound alike, so there is no inbound-only pre-fetch/refusal (unlike
      // release/block, which re-dispatch an outbound quarantine).
      const result = await client.deleteMessage(messageId);
      output(
        result,
        `Deleted message ${result.message_id} ` +
          `(raw MIME ${result.raw_mime_deleted ? 'purged' : 'retained'}; ` +
          `${result.derivatives_tombstoned} derivative(s) tombstoned).`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List messages in a mailbox')
    .option('--mailbox <name-or-id>', 'Mailbox name or UUID (env: REPLYLAYER_MAILBOX)')
    .option('--unread', 'Show unread messages only (inbound by default; pass --direction to override)')
    .option('--limit <n>', 'Maximum number of messages', '50')
    .option('--sender <email>', 'Filter by sender email (partial match)')
    .option('--since <iso-date>', 'Show messages created after this date (ISO 8601)')
    .option('--until <iso-date>', 'Show messages created before this date (ISO 8601)')
    .option('--search <term>', 'Search subject and body text (supports operators: from: subject: after: before: is:starred has:attachment)')
    .option('--status <state>', 'Filter by message state (e.g. available, quarantined)')
    .option('--direction <dir>', 'Filter by direction (inbound or outbound)')
    .option('--starred', 'Show starred messages only')
    .option('--ids-only', 'Output only message ids (+ thread_id in --json); pipe-friendly')
    .option('--verbose', 'Include clean-allow scanner findings in scan output (default: non-allow only)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();

      // Validate the mailbox selector BEFORE requiring auth so a bare invocation
      // reports the missing mailbox, not "no API key". REPLYLAYER_MAILBOX (from
      // the dashboard snippet) is the default; an explicit --mailbox wins.
      const selector = resolveMailboxSelector(localOpts.mailbox);
      if (!selector) {
        throw new LocalCliError(
          'A mailbox is required: pass --mailbox <name-or-id> or set REPLYLAYER_MAILBOX.',
          'VALIDATION_ERROR',
          undefined,
          2,
        );
      }

      // S7 NTH-002 — resolve Gmail-style operators out of --search BEFORE auth
      // (network-free). Operators route to structured opts; the residual stays
      // as search=. Conflicts / unsupported operators / short residuals throw
      // LocalCliError (exit 2) here, before any network call.
      // Parse whenever --search is PROVIDED (even `--search ""`) — a truthy
      // check would let an empty value bypass the parser and silently list the
      // whole mailbox. Absent (undefined) → no search, normal list.
      const resolution = localOpts.search !== undefined
        ? resolveSearchOperators(localOpts.search, {
            sender: localOpts.sender,
            since: localOpts.since,
            until: localOpts.until,
            starred: localOpts.starred || undefined,
            // --unread/--status/--direction also constrain the list, so a
            // short/empty search alongside them is omitted-with-warning, not a
            // hard error (and the zero-filter guard does not fire).
            otherListFilter: Boolean(localOpts.unread || localOpts.status || localOpts.direction),
          })
        : { resolved: {}, warnings: [] };
      const parsed = resolution.resolved;
      // JSON-STDERR-001 (c): non-fatal search warnings (e.g. a dropped short
      // residual) are STRUCTURED in --json output and rendered to stderr in
      // human mode (preserving the prior UX).
      const searchWarnings = resolution.warnings;
      if (!opts.json) {
        for (const w of searchWarnings) console.error(w);
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // N2: validate the numeric option network-free, BEFORE resolveMailboxId.
      const limit = parseIntOption(localOpts.limit, '--limit', 1, 200);

      // S7 gate A — capability negotiation for has:attachment. Parsing happens
      // pre-auth (above); the capability gate is post-auth where the client
      // exists. Probe /v1/health (unauth) and reject loud if the server does
      // NOT advertise 'messages.has_attachment_filter' — this closes the
      // old/stale/self-hosted silent-no-op trap (a pre-gate-A server omits
      // `capabilities`, so the CLI never sends has_attachment to it). A list
      // call probes health at most once, so no caching is needed.
      if (parsed.has_attachment) {
        const health = await client.health();
        if (!health.capabilities?.includes('messages.has_attachment_filter')) {
          throw new LocalCliError(
            'has:attachment requires a newer server build.',
            'SEARCH_OPERATOR_UNSUPPORTED',
            { operator: 'has:attachment' },
            2,
          );
        }
      }

      const mailboxId = await resolveMailboxId(client, selector);

      const result = await client.listMessages(mailboxId, {
        unread: localOpts.unread || false,
        limit,
        sender: parsed.sender ?? localOpts.sender,
        since: parsed.since ?? localOpts.since,
        until: parsed.until ?? localOpts.until,
        search: parsed.search,
        status: localOpts.status,
        // N3: --unread with no explicit --direction monitors INBOUND only.
        // Outbound rows have read_at IS NULL (read state is inbound-only), so an
        // uncoupled --unread leaks the agent's own sent mail as "unread". An
        // explicit --direction always wins.
        direction: localOpts.direction || (localOpts.unread ? 'inbound' : undefined),
        view: localOpts.verbose ? 'verbose' : undefined,
        // --starred flag OR is:starred operator (the parser already rejects a
        // conflict between the two, so at most one is set here).
        starred: localOpts.starred ? true : parsed.starred,
        // S7 gate A — has:attachment operator (capability-gated above).
        has_attachment: parsed.has_attachment,
      });

      // JSON-STDERR-001 (c): in --json mode, fold non-fatal search warnings
      // into the structured output (omitted entirely when empty).
      const warningsField =
        opts.json && searchWarnings.length > 0 ? { warnings: searchWarnings } : {};

      // S7 NTH-006 — id-only projection (pure presentation transform).
      if (localOpts.idsOnly) {
        const projected = result.messages.map((mm) => ({ id: mm.id, thread_id: mm.thread_id }));
        const text = projected.map((p) => p.id).join('\n');
        output({ messages: projected, ...warningsField }, text, opts.json);
        return;
      }

      const table = formatTable(
        ['ID', 'FROM', 'SUBJECT', 'DATE', 'STATUS', 'SCAN'],
        result.messages.map(formatMessageRow),
      );

      output({ ...result, ...warningsField }, table, opts.json);
    });
}

function readCommand(): Command {
  return new Command('read')
    .description(
      'Read a message (or several with --ids a,b,c). Non-mutating: reading ' +
        'does NOT mark the message read (reading never auto-advances read state, so agents ' +
        'inspecting a message do not silently advance read state). Use ' +
        '`inbox mark-read <id>` or `inbox mark-thread-read` to advance read ' +
        'state explicitly.',
    )
    .argument('[message-id]', 'Message UUID (omit when using --ids)')
    .option('--ids <csv>', `Comma-separated message ids to read in one call (max ${MAX_BATCH_READ_IDS})`)
    .option('--verbose', 'Include clean-allow scanner findings in scan output (default: non-allow only)')
    .action(async (messageId: string | undefined, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const view: 'verbose' | undefined = localOpts.verbose ? 'verbose' : undefined;

      // S7 NTH-001 — validate mutual-exclusion + --ids parse BEFORE requireApiKey
      // (network-free first), so a malformed invocation reports the validation
      // error, not API_KEY_REQUIRED.
      const hasPositional = messageId !== undefined;
      const hasIds = localOpts.ids !== undefined;
      if (hasPositional && hasIds) {
        throw new LocalCliError(
          'Pass either a single <message-id> OR --ids <csv>, not both.',
          'VALIDATION_ERROR',
          undefined,
          2,
        );
      }
      if (!hasPositional && !hasIds) {
        throw new LocalCliError(
          'A message id is required: pass <message-id> or --ids <csv>.',
          'VALIDATION_ERROR',
          undefined,
          2,
        );
      }

      const client = () =>
        new ApiClient({ baseUrl: opts.apiUrl, apiKey: requireApiKey(opts.apiKey) });

      // Single-id path (back-compat).
      if (hasPositional) {
        const c = client();
        const result = await c.getMessage(messageId!, { view });
        output(result, formatMessage(result), opts.json);
        return;
      }

      // Batch path: parse, dedupe (first-seen), drop empties, cap.
      const raw = localOpts.ids as string;
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const unique = [...new Set(ids)];
      if (unique.length === 0) {
        throw new LocalCliError(
          '--ids must contain at least one message id',
          'VALIDATION_ERROR',
          { ids: raw },
          2,
        );
      }
      if (unique.length > MAX_BATCH_READ_IDS) {
        throw new LocalCliError(
          `--ids accepts at most ${MAX_BATCH_READ_IDS} ids per call (got ${unique.length}). Split into multiple calls.`,
          'VALIDATION_ERROR',
          { count: unique.length, max: MAX_BATCH_READ_IDS },
          2,
        );
      }

      const c = client();
      // Promise.allSettled so one 404/403 doesn't sink the whole batch.
      const settled = await Promise.allSettled(unique.map((id) => c.getMessage(id, { view })));

      const results = settled.map((s, i) => {
        const id = unique[i]!;
        if (s.status === 'fulfilled') {
          return { id, ok: true as const, message: s.value };
        }
        const err = s.reason;
        const code = err instanceof ApiError ? err.code : err instanceof LocalCliError ? err.code : 'UNKNOWN_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        return { id, ok: false as const, error: { code, message } };
      });

      const failures = results.filter((r) => !r.ok);
      const okCount = results.length - failures.length;

      if (opts.json) {
        console.log(JSON.stringify({ results }, null, 2));
      } else {
        const blocks: string[] = [];
        for (const r of results) {
          if (r.ok) blocks.push(formatMessage(r.message));
        }
        const rendered = blocks.join('\n---\n');
        if (rendered) console.log(rendered);
        console.log(`\n${okCount} read, ${failures.length} failed`);
        for (const f of failures) {
          if (!f.ok) console.error(`  ${f.id}: ${f.error.code} — ${f.error.message}`);
        }
      }

      // Exit 0 iff all ok; exit 1 if any failed (so && chains / CI catch it).
      if (failures.length > 0) {
        process.exitCode = 1;
      }
    });
}

function markReadCommand(): Command {
  return new Command('mark-read')
    .description(
      'Mark a single message as read. Inbound + visible rows only; ' +
        'outbound / deleted / firewall_blocked are 200 no-op. Idempotent.',
    )
    .argument('<message-id>', 'Message UUID')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.markMessageRead(messageId);

      const text = result.read_at
        ? `Marked ${result.message_id} as read (read_at=${result.read_at})`
        : `No-op: ${result.message_id} is not eligible for read marker (outbound or hidden)`;
      output(result, text, opts.json);
    });
}

function markThreadReadCommand(): Command {
  return new Command('mark-thread-read')
    .description(
      'Bulk-mark every visible inbound unread message in a thread as read. ' +
        'Returns marked_count.',
    )
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .requiredOption('--thread <thread-id>', 'Thread key (Message-Id or message UUID)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.markThreadRead(localOpts.mailbox, localOpts.thread);

      const text = `Marked ${result.marked_count} message${result.marked_count === 1 ? '' : 's'} in thread ${result.thread_id}`;
      output(result, text, opts.json);
    });
}

function waitCommand(): Command {
  return new Command('wait')
    .description('Wait for a new message (long-poll)')
    .option('--mailbox <name-or-id>', 'Mailbox name or UUID (env: REPLYLAYER_MAILBOX)')
    .option('--timeout <seconds>', 'Max seconds to wait', '30')
    .option(
      '--since <iso-datetime>',
      'Only return messages created after this time (ISO 8601). Pass ' +
        '$(date -u +%Y-%m-%dT%H:%M:%SZ) to skip the existing backlog and ' +
        'wait for the next arrival.',
    )
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();

      // Validate the mailbox selector BEFORE requiring auth so a bare invocation
      // reports the missing mailbox, not "no API key". REPLYLAYER_MAILBOX (from
      // the dashboard snippet) is the default; an explicit --mailbox wins.
      const selector = resolveMailboxSelector(localOpts.mailbox);
      if (!selector) {
        throw new LocalCliError(
          'A mailbox is required: pass --mailbox <name-or-id> or set REPLYLAYER_MAILBOX.',
          'VALIDATION_ERROR',
          undefined,
          2,
        );
      }

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // N2: validate the numeric option network-free, BEFORE resolveMailboxId.
      // A bad --timeout used to yield NaN → maxEndTime NaN → the loop never ran
      // and the command emitted a false "timed out" and exited 0.
      const totalTimeout = parseIntOption(localOpts.timeout, '--timeout', 1, 300);

      const mailboxId = await resolveMailboxId(client, selector);

      const startTime = Date.now();
      const maxEndTime = startTime + totalTimeout * 1000;

      // F9 — distinguish "polled cleanly, mailbox empty" (exit 0 {message:null})
      // from "the endpoint was unreachable / never honored the long-poll for the
      // whole budget" (nonzero exit). sawCleanPoll is set ONLY when a poll
      // RESOLVES a real HTTP wait response ({message} OR {message:null}); any
      // poll that throws/aborts is a transient that does NOT set it.
      let sawCleanPoll = false;
      let lastTransientError: ApiError | undefined;

      // Long-poll reconnect loop. Each poll is capped at MAX_POLL_SECONDS so a
      // healthy empty wait resolves before the proxy cut / the client abort; the
      // loop spans the user's total --timeout.
      while (Date.now() < maxEndTime) {
        const remainingMs = maxEndTime - Date.now();
        const pollTimeout = Math.min(
          MAX_POLL_SECONDS,
          Math.ceil(remainingMs / 1000),
        );

        if (pollTimeout <= 0) break;

        try {
          // A RESOLVED waitForMessage is an actual HTTP wait response —
          // {message} OR {message:null}. Under the <=9s cap the server returns
          // {message:null} at ~9s (its own timeoutSec), well before the 14s
          // client abort budget, so a healthy empty poll RESOLVES here.
          const result = await client.waitForMessage(mailboxId, pollTimeout, localOpts.since);
          sawCleanPoll = true; // this poll RESOLVED a real HTTP wait response
          lastTransientError = undefined; // a resolved poll clears the pending transient

          if (result.message) {
            const row = formatMessageRow(result.message);
            const table = formatTable(
              ['ID', 'FROM', 'SUBJECT', 'DATE', 'STATUS', 'SCAN'],
              [row],
            );
            output(result, table, opts.json);
            return;
          }

          // null → reconnect immediately (unless we've exceeded total timeout)
        } catch (err) {
          if (isTransientWaitError(err) && Date.now() < maxEndTime) {
            // A thrown poll is a transient — reconnect within maxEndTime. This
            // INCLUDES a FIRED CLIENT ABORT (rewrapped to NETWORK_ERROR): under
            // the <=9s cap a healthy server resolves {message:null} at ~9s, so
            // AbortSignal.timeout firing at 14s means the server did NOT honor
            // the long-poll contract — an anomaly, treated as a transient. It
            // sets lastTransientError and does NOT set sawCleanPoll.
            lastTransientError = err as ApiError; // remember in case EVERY poll fails (F9)
            await new Promise((r) => setTimeout(r, 500)); // short backoff
            continue; // reconnect
          }
          throw err; // fatal (404/401/403/validation) → global catch → exit 1
        }
      }

      // F9 — every poll failed transiently for the whole --timeout budget (zero
      // resolved polls): this is a persistent outage (bad URL / DNS / sustained
      // 5xx / a server that only ever aborts), NOT an empty mailbox. Re-throw
      // the last transient so the global catch surfaces a nonzero exit with the
      // real code instead of a misleading {message:null}/exit 0.
      if (!sawCleanPoll && lastTransientError) {
        throw lastTransientError;
      }

      // Timed out (at least one poll resolved cleanly, no mail → exit 0)
      if (opts.json) {
        console.log(JSON.stringify({ message: null }, null, 2));
      } else {
        console.log(
          `No new messages (timed out after ${totalTimeout}s)`,
        );
      }
    });
}

// === S7 NTH-004 — thread-oriented browsing ===

function threadsCommand(): Command {
  const threads = new Command('threads').description('Browse and manage threads');
  threads.addCommand(threadsListCommand());
  threads.addCommand(threadsReadCommand());
  threads.addCommand(threadsStarCommand('star', true));
  threads.addCommand(threadsStarCommand('unstar', false));
  return threads;
}

function threadsListCommand(): Command {
  return new Command('list')
    .description('List threads in a mailbox')
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .option('--limit <n>', 'Maximum number of threads', '50')
    .option('--starred', 'Show starred threads only')
    .option('--has-inbound', 'Show only threads with at least one inbound message (Inbox-style)')
    .option('--ids-only', 'Output only thread keys (pipe-friendly)')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // Validate the numeric option network-free, BEFORE resolveMailboxId.
      const limit = parseIntOption(localOpts.limit, '--limit', 1, 200);

      const mailboxId = await resolveMailboxId(client, localOpts.mailbox);

      const result = await client.listThreads(mailboxId, {
        limit,
        starred: localOpts.starred ? true : undefined,
        has_inbound: localOpts.hasInbound ? true : undefined,
      });

      // S7 NTH-006 — id-only projection for threads.
      if (localOpts.idsOnly) {
        const projected = result.threads.map((t) => ({ id: t.id }));
        const text = projected.map((p) => p.id).join('\n');
        output({ threads: projected }, text, opts.json);
        return;
      }

      output(result, formatThreadList(result.threads), opts.json);
    });
}

function threadsReadCommand(): Command {
  return new Command('read')
    .description(
      'Read a full thread as a conversation. Account-wide by default; pass ' +
        '--mailbox to scope the read to one mailbox when a thread key collides ' +
        'across two of your mailboxes.',
    )
    .argument('<thread-id>', 'Thread key (Message-Id or message UUID)')
    .option('--mailbox <name-or-id>', 'Scope the read to one mailbox (disambiguates a cross-mailbox thread-key collision)')
    .option('--verbose', 'Include clean-allow scanner findings in scan output (default: non-allow only)')
    .action(async (threadId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      // Gate C — resolve --mailbox (name or UUID) to a UUID before the read so
      // the server can scope the account-wide thread lookup. Omitted → the
      // account-wide path (unchanged). resolveMailboxId throws MAILBOX_NOT_FOUND
      // for an unknown name, surfaced through the same JSON-aware formatter.
      const mailboxId = localOpts.mailbox
        ? await resolveMailboxId(client, localOpts.mailbox)
        : undefined;

      let result;
      try {
        result = await client.getThread(threadId, {
          view: localOpts.verbose ? 'verbose' : undefined,
          mailboxId,
        });
      } catch (err) {
        // The server returns 404 NOT_FOUND for a genuinely-absent thread AND,
        // on the account-wide path (no --mailbox), for the cross-mailbox key
        // collision (the mailboxIds.size > 1 guard). Re-map to THREAD_NOT_FOUND
        // so the friendly hint fires with the actionable "pass --mailbox"
        // guidance — the bare NOT_FOUND has no registered hint.
        if (err instanceof ApiError && err.statusCode === 404) {
          throw new LocalCliError(
            `Thread '${threadId}' not found.`,
            'THREAD_NOT_FOUND',
            { thread_id: threadId },
            1,
          );
        }
        throw err;
      }

      output(result, formatThread(result), opts.json);
    });
}

function threadsStarCommand(name: 'star' | 'unstar', starred: boolean): Command {
  return new Command(name)
    .description(
      `${starred ? 'Star' : 'Unstar'} every visible message in a thread. ` +
        'Idempotent; reports updated_count.',
    )
    .argument('<thread-id>', 'Thread key (Message-Id or message UUID)')
    .requiredOption('--mailbox <name-or-id>', 'Mailbox name or UUID')
    .action(async (threadId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const mailboxId = await resolveMailboxId(client, localOpts.mailbox);
      const result = await client.setThreadStarred(mailboxId, threadId, starred);

      const verb = starred ? 'Starred' : 'Unstarred';
      const text = `${verb} thread ${result.thread_id} (${result.updated_count} message${result.updated_count === 1 ? '' : 's'} updated)`;
      output(result, text, opts.json);
    });
}

// === S7 NTH-005 — star/unstar a single message ===

function starCommand(): Command {
  return messageStarCommand('star', true);
}

function unstarCommand(): Command {
  return messageStarCommand('unstar', false);
}

function messageStarCommand(name: 'star' | 'unstar', starred: boolean): Command {
  return new Command(name)
    .description(`${starred ? 'Star' : 'Unstar'} a single message. Idempotent.`)
    .argument('<message-id>', 'Message UUID')
    .action(async (messageId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.setMessageStarred(messageId, starred);

      const verb = starred ? 'Starred' : 'Unstarred';
      const text = `${verb} ${result.message_id}`;
      output(result, text, opts.json);
    });
}

// === RL-UAT-013 — attachment safe-text-preview retrieval ===

function attachmentCommand(): Command {
  const att = new Command('attachment').description('Retrieve attachment previews and download URLs');
  att.addCommand(attachmentPreviewCommand());
  // FIND-011 / WS4 — presigned download URL (phase-1: CLI surfaces the URL only,
  // not the staging-handle poll/delete which has no corresponding CLI workflow).
  att.addCommand(attachmentUrlCommand());
  return att;
}

function attachmentPreviewCommand(): Command {
  return new Command('preview')
    .description(
      'Fetch the safe text preview for an attachment on a message. Returns the ' +
        'extracted text only — never the raw bytes. Requires a preview tier ' +
        '(derived_content) enabled on the mailbox; otherwise the server returns ' +
        '404/403 with an actionable hint.',
    )
    .argument('<message-id>', 'Message UUID')
    .argument('<index>', 'Attachment index (0-based, as shown in `inbox read`)')
    .action(async (messageId: string, indexArg: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      // Validate the index network-free: non-negative integer only. The API
      // param schema is `^[0-9]+$` with NO max, and the route bounds the index
      // by the real per-message attachment count (404 on an in-range-but-
      // nonexistent index), so the CLI must reject only non-digit/negative
      // input — never impose a fixed cap the API would otherwise accept.
      const index = parseIntOption(indexArg, '<index>', 0, Number.MAX_SAFE_INTEGER);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.getAttachmentPreview(messageId, index);
      output(result, formatAttachmentPreview(result), opts.json);
    });
}

// FIND-011 / WS4 — `inbox attachment url <message-id> <index>` — emits the
// presigned download URL (and expiry + metadata in human mode) for an
// attachment. This is the CLI surface of GET /v1/messages/:id/attachments/:idx.
// Note: session-only re-auth applies on the server for raw-download tiers;
// the CLI will propagate the REAUTH_REQUIRES_SESSION ApiError through the
// global catch as a regular error (no special handling needed here).
function attachmentUrlCommand(): Command {
  return new Command('url')
    .description(
      'Get the presigned download URL for an attachment. The URL is short-lived ' +
        '(typically 5 minutes). Session-only re-auth applies for raw-download ' +
        'tier mailboxes; agent keys receive REAUTH_REQUIRES_SESSION in that case.',
    )
    .argument('<message-id>', 'Message UUID')
    .argument('<index>', 'Attachment index (0-based, as shown in `inbox read`)')
    .action(async (messageId: string, indexArg: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      // Validate the index network-free: same rule as the preview command —
      // non-negative integer only; the API bounds the index by attachment count.
      const index = parseIntOption(indexArg, '<index>', 0, Number.MAX_SAFE_INTEGER);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.getAttachmentDownloadUrl(messageId, index);
      output(result, formatAttachmentUrl(result), opts.json);
    });
}

// Local size formatter (mirrors format.ts's private formatSize; kept local to
// stay within SP-4's file-touch boundary — format.ts is not an SP-4 file).
function formatPreviewSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAttachmentPreview(result: AttachmentPreviewResponse): string {
  const { attachment, preview } = result;
  const lines: string[] = [];
  lines.push(
    `Attachment: ${attachment.filename} (${attachment.content_type}, ${formatPreviewSize(attachment.size)})`,
  );
  const charNote =
    typeof preview.char_count === 'number' ? `, ${preview.char_count} chars` : '';
  lines.push(`Preview (${preview.kind}${charNote}):`);
  lines.push('');
  lines.push(preview.content);
  if (preview.truncated) {
    lines.push('');
    lines.push('[truncated — full content not shown]');
  }
  return lines.join('\n');
}

// Human-readable formatter for `inbox attachment url`.
function formatAttachmentUrl(result: AttachmentDownloadUrlResponse): string {
  const lines: string[] = [];
  lines.push(result.url);
  lines.push('');
  lines.push(`File:    ${result.filename}`);
  lines.push(`Type:    ${result.content_type}`);
  lines.push(`Size:    ${formatPreviewSize(result.size)}`);
  lines.push(`Expires: ${result.expires_at}`);
  if (result.av_verdict) {
    lines.push(`AV:      ${result.av_verdict}`);
  }
  return lines.join('\n');
}
