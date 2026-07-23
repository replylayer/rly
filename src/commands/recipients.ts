import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { resolveRecipientId } from '../resolve.js';
import { formatTable, output } from '../format.js';

export function recipientsCommand(): Command {
  const recipients = new Command('recipients').description(
    'Manage verified recipients (sandbox tier)',
  );

  recipients.addCommand(addCommand());
  recipients.addCommand(listCommand());
  recipients.addCommand(removeCommand());
  recipients.addCommand(resendCommand());

  return recipients;
}

function addCommand(): Command {
  return new Command('add')
    .description('Add a recipient (sends confirmation email)')
    .argument('<email>', 'Recipient email address')
    .action(async (email: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.addRecipient(email);

      output(
        result,
        `Confirmation email sent to ${result.email}. Recipient must click the link before you can send.`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List verified recipients')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.listRecipients();

      const table = formatTable(
        ['EMAIL', 'STATUS', 'ADDED'],
        result.recipients.map((r: { email: string; status?: string; created_at: string }) => [
          r.email,
          (r.status ?? 'confirmed').toUpperCase(),
          r.created_at,
        ]),
      );

      output(result, table, opts.json);
    });
}

function removeCommand(): Command {
  return new Command('remove')
    .description('Remove a verified recipient')
    .argument('<email-or-id>', 'Recipient email or UUID')
    .action(async (emailOrId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const id = await resolveRecipientId(client, emailOrId);

      await client.deleteRecipient(id);

      output(
        { removed: true, id },
        `Removed: ${emailOrId}`,
        opts.json,
      );
    });
}

// S5b — re-send the confirmation email to a pending recipient (admin-only).
function resendCommand(): Command {
  return new Command('resend')
    .description('Re-send the confirmation email to a pending verified recipient')
    .argument('<email-or-id>', 'Recipient email or UUID')
    .action(async (emailOrId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const id = await resolveRecipientId(client, emailOrId);
      const result = await client.resendRecipient(id);

      output(
        result,
        result.status === 'already_confirmed'
          ? 'Recipient is already confirmed — no email sent.'
          : `Confirmation email re-sent to ${emailOrId}.`,
        opts.json,
      );
    });
}
