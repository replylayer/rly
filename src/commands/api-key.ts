import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey, storeApiKey, getCredentialFilePath } from '../auth.js';
import { resolveMailboxId } from '../resolve.js';
import { formatTable, output } from '../format.js';
// Reuse the auth-rotate scope copy so the two rotate verbs can't drift (UAT-21).
import { ROTATE_SCOPE_NOTE } from './auth.js';

function collectMailbox(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export function apiKeyCommand(): Command {
  const apiKey = new Command('api-key').description('Manage API keys');

  apiKey.addCommand(createCommand());
  apiKey.addCommand(listCommand());
  apiKey.addCommand(updateCommand());
  apiKey.addCommand(revokeCommand());
  // WS5 / FIND-006 — discoverability alias. `auth rotate` remains as-is (stable
  // verb for existing scripts). This alias surfaces rotation under the expected
  // `api-key` noun group without adding any new capability.
  apiKey.addCommand(rotateCommand());

  return apiKey;
}

function createCommand(): Command {
  return new Command('create')
    .description('Create a new API key')
    .requiredOption('--role <role>', 'Key role: admin or agent')
    .option('--label <label>', 'Human-readable label')
    .option('--mailbox <name-or-id>', 'Mailbox binding (repeat for multiple: --mailbox a --mailbox b)', collectMailbox, [] as string[])
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const key = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey: key });

      const mailboxNames = localOpts.mailbox as string[];
      let mailboxIds: string[] | undefined;
      if (mailboxNames.length > 0) {
        mailboxIds = [];
        for (const nameOrId of mailboxNames) {
          mailboxIds.push(await resolveMailboxId(client, nameOrId));
        }
      }

      const result = await client.createApiKey({
        role: localOpts.role as 'admin' | 'agent',
        label: localOpts.label,
        mailbox_ids: mailboxIds,
      });

      output(
        result,
        `Created ${result.role} API key: ${result.api_key}\nKey ID: ${result.id}${result.label ? `\nLabel: ${result.label}` : ''}`,
        opts.json,
      );
    });
}

function updateCommand(): Command {
  return new Command('update')
    .description("Replace an agent key's mailbox bindings in place (keeps the secret)")
    .argument('<key-id>', 'API key ID (from api-key list)')
    // Required, unlike create's optional --mailbox: an update without scope is
    // always invalid (agent keys must keep >=1 mailbox), so fail locally
    // before any network call. No default value — a default (even []) would
    // satisfy requiredOption and defeat the local check — hence the
    // nullish-tolerant collector instead of the shared collectMailbox.
    .requiredOption('--mailbox <name-or-id>', 'Complete new binding set (repeat for multiple: --mailbox a --mailbox b)', (value: string, prev: string[] | undefined) => [...(prev ?? []), value])
    .action(async (keyId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const key = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey: key });

      const mailboxIds: string[] = [];
      for (const nameOrId of localOpts.mailbox as string[]) {
        mailboxIds.push(await resolveMailboxId(client, nameOrId));
      }

      const result = await client.updateApiKey(keyId, { mailbox_ids: mailboxIds });

      output(
        result,
        `Updated mailbox access for ${result.label ?? result.id}\nBound mailboxes: ${result.mailbox_ids.join(', ')}`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List API keys (active-only by default)')
    .option('--include-revoked', 'Include revoked keys with revocation metadata')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const key = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey: key });

      const result = await client.listApiKeys({ include_revoked: opts.includeRevoked === true });

      const table = formatTable(
        ['ID', 'PREFIX', 'ROLE', 'LABEL', 'STATUS', 'CREATED', 'REVOKED'],
        result.keys.map((k) => [
          // Full UUID, never truncated: `api-key update` and `api-key revoke`
          // take this ID, and the API requires the full value — a truncated
          // display would make the advertised list→update/revoke path unusable.
          k.id,
          k.prefix,
          k.role ?? 'admin',
          k.label ?? '-',
          k.status,
          k.created_at.split('T')[0],
          k.revoked_at ? k.revoked_at.split('T')[0] : '-',
        ]),
      );

      output(result, table, opts.json);
    });
}

function revokeCommand(): Command {
  return new Command('revoke')
    .description('Revoke an API key')
    .argument('<key-id>', 'API key UUID to revoke')
    .action(async (keyId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const key = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey: key });

      const result = await client.revokeApiKey(keyId);

      output(
        result,
        `Revoked API key: ${keyId}${result.revoked_at ? ` (at ${result.revoked_at})` : ''}`,
        opts.json,
      );
    });
}

// WS5 / FIND-006 — `api-key rotate` alias for discoverability.
// Identical behaviour to `auth rotate` (same client.rotateKey() call, same
// store-and-print flow). `auth rotate` is kept as-is for backward compatibility.
function rotateCommand(): Command {
  return new Command('rotate')
    .description(
      'Rotate your API key — revokes ONLY the calling key and issues a new one. ' +
        'The new key is stored in the credential file. Alias for `auth rotate`.',
    )
    // UAT-21: mirror `auth rotate` exactly — scope note + non-destructive
    // --dry-run preview. The alias is documented as "identical behaviour", so
    // the guard must stay identical too.
    .option('--dry-run', 'Show what rotate would do without revoking or issuing a key')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const key = requireApiKey(opts.apiKey);

      if (localOpts.dryRun) {
        output(
          { dry_run: true, would_rotate: true },
          `Dry run: rotate would revoke ONLY the calling API key and issue a replacement, ` +
            `then store it in ${getCredentialFilePath()}.\n${ROTATE_SCOPE_NOTE}`,
          opts.json,
        );
        return;
      }

      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey: key });

      const result = await client.rotateKey();
      storeApiKey(result.api_key);

      output(
        result,
        `New API key: ${result.api_key} (stored in ${getCredentialFilePath()})\n${ROTATE_SCOPE_NOTE}`,
        opts.json,
      );
    });
}
