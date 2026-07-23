/**
 * PR 3 — `rly legal-hold {apply|release|list|get}`
 *
 * Customer-facing legal-hold surface. apply + list are tier-gated by
 * `customer_legal_hold` (Pro+); release + get are NOT gated. Agent-role
 * keys 403 server-side.
 */
import { Command } from 'commander';
import { ApiClient, type LegalHold } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { formatTable, output } from '../format.js';
import { parseIntOption } from './_validate.js';

export function legalHoldCommand(): Command {
  const cmd = new Command('legal-hold').description(
    'Manage compliance legal holds (Pro+; admin keys + session)',
  );
  cmd.addCommand(applyCommand());
  cmd.addCommand(releaseCommand());
  cmd.addCommand(listCommand());
  cmd.addCommand(getCommand());
  return cmd;
}

function applyCommand(): Command {
  return new Command('apply')
    .description('Apply a legal hold (account or mailbox scope) — Pro+')
    .requiredOption('--scope <scope>', 'account | mailbox', 'account')
    .requiredOption('--reason <text>', 'free-text reason (required, ≤2000 chars)')
    .option('--mailbox <uuid>', 'mailbox UUID (required when --scope=mailbox)')
    .option('--case <text>', 'case reference (e.g. ticket id)')
    .action(async (opts: { scope: string; reason: string; mailbox?: string; case?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      if (opts.scope !== 'account' && opts.scope !== 'mailbox') {
        throw new LocalCliError(
          '--scope must be "account" or "mailbox"',
          'INVALID_OPTION',
          { option: '--scope', value: opts.scope },
          2,
        );
      }
      if (opts.scope === 'mailbox' && !opts.mailbox) {
        throw new LocalCliError(
          '--mailbox is required when --scope=mailbox',
          'INVALID_OPTION',
          { option: '--mailbox' },
          2,
        );
      }

      const result = await client.applyLegalHold({
        scope: opts.scope as 'account' | 'mailbox',
        reason: opts.reason,
        mailbox_id: opts.mailbox,
        case_reference: opts.case,
      });
      output(result, formatHold(result), globals.json);
    });
}

function releaseCommand(): Command {
  return new Command('release')
    .description('Release an active legal hold (not tier-gated — works after downgrade)')
    .argument('<hold-id>', 'legal hold UUID')
    .requiredOption('--reason <text>', 'release reason (required, ≤2000 chars)')
    .action(async (holdId: string, opts: { reason: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });
      const result = await client.releaseLegalHold(holdId, opts.reason);
      output(result, formatHold(result), globals.json);
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List active legal holds (Pro+; --include-released to see history)')
    .option('--include-released', 'include already-released holds', false)
    .option('--limit <n>', 'page size (1..200, default 50)', '50')
    .action(async (opts: { includeReleased?: boolean; limit?: string }, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const limitNum = parseIntOption(opts.limit ?? '50', '--limit', 1, 200);

      const result = await client.listLegalHolds({
        include_released: opts.includeReleased,
        limit: limitNum,
      });

      const table = formatTable(
        ['ID', 'SCOPE', 'MAILBOX', 'CASE', 'APPLIED', 'BY', 'RELEASED'],
        result.legal_holds.map((h) => [
          h.id,
          h.scope,
          h.mailbox_id ?? '—',
          h.case_reference || '—',
          h.applied_at,
          h.applied_by_type,
          h.released_at ?? '—',
        ]),
      );
      output(result, table, globals.json);
    });
}

function getCommand(): Command {
  return new Command('get')
    .description('Read a single legal hold by id (not tier-gated)')
    .argument('<hold-id>', 'legal hold UUID')
    .action(async (holdId: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });
      const result = await client.getLegalHold(holdId);
      output(result, formatHold(result), globals.json);
    });
}

function formatHold(h: LegalHold): string {
  const lines = [
    `Legal hold: ${h.id}`,
    `  Scope: ${h.scope}${h.mailbox_id ? ` (mailbox ${h.mailbox_id})` : ''}`,
    `  Case ref: ${h.case_reference || '—'}`,
    `  Reason: ${h.reason}`,
    `  Applied: ${h.applied_at} by ${h.applied_by_type}`,
  ];
  if (h.released_at) {
    lines.push(`  Released: ${h.released_at} by ${h.released_by_type ?? '—'}`);
    if (h.release_reason) lines.push(`  Release reason: ${h.release_reason}`);
  }
  return lines.join('\n');
}
