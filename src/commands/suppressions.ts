import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { formatTable, output } from '../format.js';
import { parseIntOption } from './_validate.js';
import type { SuppressionRow, SuppressionReason } from '../types.js';
import { parseEmailsOption } from './mailbox.js';

const REASON_VALUES = ['hard_bounce', 'complaint', 'manual', 'unsubscribe'] as const;

export function suppressionsCommand(): Command {
  const cmd = new Command('suppressions').description(
    'Manage your do-not-contact list (suppressions)',
  );
  cmd.addCommand(listCommand());
  cmd.addCommand(addCommand());
  cmd.addCommand(addBulkCommand());
  cmd.addCommand(removeCommand());
  return cmd;
}

function listCommand(): Command {
  return new Command('list')
    .description('List suppressed addresses (default 100, --all for full list)')
    .option('--reason <r>', `filter: ${REASON_VALUES.join('|')}`)
    .option('--all', 'paginate through every row (no per-page cap)', false)
    .option('--limit <n>', 'page size (1..500, default 100)', '100')
    .action(async (opts: { reason?: string; all?: boolean; limit?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      if (opts.reason && !REASON_VALUES.includes(opts.reason as SuppressionReason)) {
        throw new LocalCliError(
          `invalid --reason. Must be one of: ${REASON_VALUES.join(', ')}`,
          'INVALID_OPTION',
          { option: '--reason', value: opts.reason },
          2,
        );
      }

      const limitNum = parseIntOption(opts.limit ?? '100', '--limit', 1, 500);

      // Pagination loop. With --all, follow next_cursor until null.
      const all: SuppressionRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listSuppressions({
          reason: opts.reason as SuppressionReason | undefined,
          limit: limitNum,
          cursor,
        });
        all.push(...page.suppressions);
        cursor = page.next_cursor ?? undefined;
        // Without --all, stop after the first page.
        if (!opts.all) break;
      } while (cursor);

      const table = formatTable(
        // Migration 051 — LAST COMPLAINT and EVENTS surface the lock signal
        // and worker-event tally respectively. LAST COMPLAINT is the field
        // that fires the DELETE 409 lock; EVENTS is the count of distinct
        // provider complaint events received by the worker (sync
        // observations don't increment, so a sync-locked row legitimately
        // shows 0 EVENTS).
        ['ENTRY', 'TYPE', 'REASON', 'SOURCE', 'ADDED', 'ADDED BY', 'LAST COMPLAINT', 'EVENTS'],
        all.map((s) => [
          s.email,
          // Fallback to string-inspection if pre-0.5.0 server omits it.
          s.pattern_type ?? (s.email.startsWith('@') ? 'domain' : 'email'),
          s.reason,
          s.source,
          s.created_at,
          s.added_by_actor_type ?? '—',
          s.latest_complaint_at ?? '—',
          // complaint_count is 0 by default; show the number even when 0
          // so the column doesn't collapse to em-dash on every row.
          s.complaint_count !== undefined ? String(s.complaint_count) : '—',
        ]),
      );

      // Stderr footer when there are more rows than shown. We don't know
      // the total (would require an extra COUNT query) — just signal that
      // the page isn't the whole list.
      if (!opts.all && cursor) {
        console.error(
          `Showing first ${all.length} rows. Use --all to list every address.`,
        );
      }

      output({ suppressions: all, next_cursor: cursor ?? null }, table, globals.json);
    });
}

function addCommand(): Command {
  return new Command('add')
    .description('Add an email or domain pattern (@corp.com) to your do-not-contact list')
    .argument('<email-or-domain>', 'Recipient email (alice@corp.com) or domain pattern (@corp.com)')
    .action(async (email: string, _ignored, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const result = await client.addSuppression(email);

      const normalized = result.email;
      // Normalization-surprise hint: notify on CASE change only. Whitespace
      // trimming is silent (every caller strips — it'd be noise). If the
      // caller typed "Foo@Bar.com", show the lowercased form so they don't
      // look for the original casing in their list.
      if (normalized !== email && normalized !== email.trim()) {
        console.error(`Note: stored as ${normalized} (lowercased).`);
      }

      const message = result.already_existed
        ? `${normalized} is already on your do-not-contact list.`
        : `Added ${normalized} to do-not-contact list.`;

      output(result, message, globals.json);
    });
}

// FIND-009 (WS4) — bulk-add up to 1000 suppression entries in one request.
// Accepts comma-separated addresses or an @file path (one per line).
function addBulkCommand(): Command {
  return new Command('add-bulk')
    .description('Bulk-add up to 1000 addresses to your do-not-contact list; --emails accepts csv or @file')
    .requiredOption('--emails <csv|@file>', 'Comma-separated emails or @/path/to/file (one per line, max 1000)')
    .action(async (opts: { emails?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      // Parse and cap-check before any network call.
      const emails = parseEmailsOption(String(opts.emails), 1000);
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });
      const result = await client.addSuppressionsBulk(emails);
      if (globals.json) {
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
    });
}

function removeCommand(): Command {
  return new Command('remove')
    .description('Remove an address from your do-not-contact list (admin-only)')
    .argument('<email>', 'Recipient email address to unsuppress')
    .action(async (email: string, _ignored, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const result = await client.deleteSuppression(email);
      output(result, `Removed ${result.email} from do-not-contact list.`, globals.json);
    });
}
