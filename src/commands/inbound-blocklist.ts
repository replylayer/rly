/**
 * Migration 047 — `rly inbound-blocklist {list|add|remove}`
 *
 * Account-scoped customer-managed do-not-receive list. Symmetric counterpart
 * to `rly suppressions {list|add|remove}` for the inbound side.
 * Both `add` and `remove` accept admin AND agent keys.
 */
import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { formatTable, output } from '../format.js';
import { parseIntOption } from './_validate.js';
import { parseEmailsOption } from './mailbox.js';

export function inboundBlocklistCommand(): Command {
  const cmd = new Command('inbound-blocklist').description(
    'Manage your inbound do-not-receive list (per account; admin + agent)',
  );
  cmd.addCommand(listCommand());
  cmd.addCommand(addCommand());
  cmd.addCommand(addBulkCommand());
  cmd.addCommand(removeCommand());
  return cmd;
}

function listCommand(): Command {
  return new Command('list')
    .description('List inbound blocklist entries (default 100, --all for full list)')
    .option('--all', 'paginate through every row (no per-page cap)', false)
    .option('--limit <n>', 'page size (1..500, default 100)', '100')
    .action(async (opts: { all?: boolean; limit?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const limitNum = parseIntOption(opts.limit ?? '100', '--limit', 1, 500);

      const all: Array<{
        email: string;
        reason: string;
        source: string;
        created_at: string;
        added_by_actor_type: string | null;
        pattern_type?: 'email' | 'domain';
      }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listInboundBlocklist({ limit: limitNum, cursor });
        all.push(...page.blocklist);
        cursor = page.next_cursor ?? undefined;
        if (!opts.all) break;
      } while (cursor);

      const table = formatTable(
        ['ENTRY', 'TYPE', 'REASON', 'SOURCE', 'ADDED', 'ADDED BY'],
        all.map((s) => [
          s.email,
          s.pattern_type ?? (s.email.startsWith('@') ? 'domain' : 'email'),
          s.reason,
          s.source,
          s.created_at,
          s.added_by_actor_type ?? '—',
        ]),
      );

      if (!opts.all && cursor) {
        console.error(
          `Showing first ${all.length} rows. Use --all to list every entry.`,
        );
      }

      output({ blocklist: all, next_cursor: cursor ?? null }, table, globals.json);
    });
}

function addCommand(): Command {
  return new Command('add')
    .description('Add a sender email or @domain pattern to your inbound blocklist')
    .argument('<email-or-domain>', 'Sender email (alice@spam.com) or domain (@spam.com)')
    .action(async (email: string, _ignored, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const result = await client.addInboundBlocklist(email);
      const normalized = result.email;
      if (normalized !== email && normalized !== email.trim()) {
        console.error(`Note: stored as ${normalized} (lowercased).`);
      }

      const message = result.already_existed
        ? `${normalized} is already on your inbound blocklist.`
        : `Added ${normalized} to inbound blocklist.`;

      output(result, message, globals.json);
    });
}

// FIND-010 (WS4) — bulk-add up to 1000 inbound blocklist entries in one
// request. Accepts comma-separated addresses or an @file path (one per line).
function addBulkCommand(): Command {
  return new Command('add-bulk')
    .description('Bulk-add up to 1000 sender addresses to your inbound blocklist; --emails accepts csv or @file')
    .requiredOption('--emails <csv|@file>', 'Comma-separated emails or @/path/to/file (one per line, max 1000)')
    .action(async (opts: { emails?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      // Parse and cap-check before any network call.
      const emails = parseEmailsOption(String(opts.emails), 1000);
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });
      const result = await client.addInboundBlocklistBulk(emails);
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
    .description('Remove a sender from your inbound blocklist (admin + agent)')
    .argument('<email>', 'Sender email or @domain to remove')
    .action(async (email: string, _ignored, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const result = await client.deleteInboundBlocklist(email);
      output(result, `Removed ${result.email} from inbound blocklist.`, globals.json);
    });
}
