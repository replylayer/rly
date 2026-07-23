import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { formatTable, output } from '../format.js';
import { ensureConfirmed } from '../lib/confirm.js';

// G8 — customer webhook management, 1:1 with the SDK webhook resource. All
// routes are admin-only at the server (requireAdmin; agent keys 403). The
// egress-mutating verbs (create/update/delete/rotate-secret) carry a --confirm
// gate; create/rotate-secret print the signing secret ONCE (mirroring
// `api-key create`).

export function webhookCommand(): Command {
  const webhook = new Command('webhook').description('Manage customer webhook subscriptions');
  webhook.addCommand(createCommand());
  webhook.addCommand(listCommand());
  webhook.addCommand(getCommand());
  webhook.addCommand(updateCommand());
  webhook.addCommand(deleteCommand());
  webhook.addCommand(rotateSecretCommand());
  webhook.addCommand(testCommand());
  webhook.addCommand(deliveriesCommand());
  webhook.addCommand(retryCommand());
  return webhook;
}

function createCommand(): Command {
  return new Command('create')
    .description('Create a webhook subscription')
    .requiredOption('--url <url>', 'Delivery URL (https)')
    .requiredOption('--event <event...>', 'Event type(s) to subscribe to (repeatable)')
    .option('--description <text>', 'Human-readable description')
    .option('--disabled', 'Create the webhook disabled')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Create webhook → ${localOpts.url}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.createWebhook({
        url: localOpts.url as string,
        enabled_events: localOpts.event as string[],
        ...(localOpts.description ? { description: localOpts.description as string } : {}),
        ...(localOpts.disabled ? { enabled: false } : {}),
      });
      output(
        result,
        `Created webhook: ${result.url}\nWebhook ID: ${result.id}\nSigning secret (shown once): ${result.signing_secret}\nStore it now — it cannot be retrieved again.`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List webhook subscriptions')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.listWebhooks();
      const table = formatTable(
        ['ID', 'URL', 'ENABLED', 'EVENTS', 'FAILURES'],
        result.webhooks.map((w) => [w.id, w.url, w.enabled ? 'yes' : 'no', String(w.enabled_events.length), String(w.consecutive_failures)]),
      );
      output(result, table, opts.json);
    });
}

function getCommand(): Command {
  return new Command('get')
    .description('Show a webhook subscription')
    .argument('<id>', 'Webhook UUID')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.getWebhook(id);
      const table = formatTable(['FIELD', 'VALUE'], [
        ['id', result.id],
        ['url', result.url],
        ['enabled', String(result.enabled)],
        ['events', result.enabled_events.join(',')],
        ['consecutive_failures', String(result.consecutive_failures)],
        ['last_error', result.last_error ?? '(none)'],
        ['disabled_reason', result.disabled_reason ?? '(none)'],
      ]);
      output(result, table, opts.json);
    });
}

function updateCommand(): Command {
  return new Command('update')
    .description('Update a webhook subscription')
    .argument('<id>', 'Webhook UUID')
    .option('--url <url>', 'New delivery URL')
    .option('--event <event...>', 'Replace the subscribed event list')
    .option('--description <text>', 'New description')
    .option('--enabled <bool>', "Enable/disable ('true' | 'false')")
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const body: { url?: string; description?: string; enabled_events?: string[]; enabled?: boolean } = {};
      if (localOpts.url) body.url = localOpts.url as string;
      if (localOpts.event) body.enabled_events = localOpts.event as string[];
      if (localOpts.description !== undefined) body.description = localOpts.description as string;
      if (localOpts.enabled !== undefined) {
        if (localOpts.enabled !== 'true' && localOpts.enabled !== 'false') {
          throw new LocalCliError("--enabled must be 'true' or 'false'", 'INVALID_OPTION', { option: 'enabled', value: localOpts.enabled }, 2);
        }
        body.enabled = localOpts.enabled === 'true';
      }
      if (Object.keys(body).length === 0) {
        throw new LocalCliError('at least one of --url / --event / --description / --enabled is required', 'INVALID_OPTION', {}, 2);
      }
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Update webhook ${id}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.updateWebhook(id, body);
      output(result, `Updated webhook ${id}.`, opts.json);
    });
}

function deleteCommand(): Command {
  return new Command('delete')
    .description('Delete a webhook subscription')
    .argument('<id>', 'Webhook UUID')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Delete webhook ${id}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.deleteWebhook(id);
      output(result, `Deleted webhook ${id}.`, opts.json);
    });
}

function rotateSecretCommand(): Command {
  return new Command('rotate-secret')
    .description('Rotate a webhook signing secret (invalidates the previous secret)')
    .argument('<id>', 'Webhook UUID')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Rotate signing secret for ${id}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.rotateWebhookSecret(id);
      output(
        result,
        `Rotated signing secret for ${id}.\nNew signing secret (shown once): ${result.signing_secret}\nUpdate your verifier now — the previous secret is invalid.`,
        opts.json,
      );
    });
}

const TESTABLE_WEBHOOK_EVENTS = [
  'webhook.test',
  'message.delivered',
  'message.bounced',
  'recipient_blocklist.added',
] as const;
type TestableWebhookEvent = (typeof TESTABLE_WEBHOOK_EVENTS)[number];

function testCommand(): Command {
  return new Command('test')
    .description('Enqueue a test delivery (default webhook.test, or a real-shaped event payload)')
    .argument('<id>', 'Webhook UUID')
    .option(
      '--event <event>',
      `Event type to test (one of ${TESTABLE_WEBHOOK_EVENTS.join(', ')}); default webhook.test`,
    )
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const event = localOpts.event as string | undefined;
      if (event !== undefined && !(TESTABLE_WEBHOOK_EVENTS as readonly string[]).includes(event)) {
        throw new LocalCliError(
          `--event must be one of ${TESTABLE_WEBHOOK_EVENTS.join(', ')}`,
          'INVALID_OPTION',
          { option: 'event', value: event },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.testWebhook(
        id,
        event && event !== 'webhook.test'
          ? { event: event as Exclude<TestableWebhookEvent, 'webhook.test'> }
          : undefined,
      );
      output(result, `Test delivery enqueued: ${result.delivery_id}`, opts.json);
    });
}

function deliveriesCommand(): Command {
  return new Command('deliveries')
    .description('List recent delivery attempts for a webhook')
    .argument('<id>', 'Webhook UUID')
    .option('--limit <n>', 'Page size (1..100)', '50')
    .option('--before-at <iso>', 'Pagination cursor: created_at of the last row from the previous page (use with --before-id)')
    .option('--before-id <id>', 'Pagination cursor: id of the last row from the previous page (use with --before-at)')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const limit = Number(localOpts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new LocalCliError('--limit must be an integer between 1 and 100', 'INVALID_OPTION', { option: 'limit', value: localOpts.limit }, 2);
      }
      // The server requires before_at + before_id together (400s otherwise) —
      // enforce the pair CLI-side.
      const hasBeforeAt = localOpts.beforeAt !== undefined;
      const hasBeforeId = localOpts.beforeId !== undefined;
      if (hasBeforeAt !== hasBeforeId) {
        throw new LocalCliError('--before-at and --before-id must be used together', 'INVALID_OPTION', {}, 2);
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.listWebhookDeliveries(id, {
        limit,
        ...(hasBeforeAt ? { before_at: localOpts.beforeAt as string, before_id: localOpts.beforeId as string } : {}),
      });
      let human = formatTable(
        ['DELIVERY ID', 'EVENT', 'STATUS', 'HTTP', 'ATTEMPTS', 'CREATED'],
        result.deliveries.map((d) => [d.id, d.event_type, d.status, d.http_status === null ? '-' : String(d.http_status), String(d.attempt_count), d.created_at]),
      );
      if (result.has_more && result.next_before_at && result.next_before_id) {
        human += `\n\nMore deliveries available — next page:\n  rly webhook deliveries ${id} --before-at ${result.next_before_at} --before-id ${result.next_before_id}`;
      }
      output(result, human, opts.json);
    });
}

function retryCommand(): Command {
  return new Command('retry')
    .description('Re-queue a failed delivery')
    .argument('<id>', 'Webhook UUID')
    .argument('<delivery-id>', 'Delivery UUID')
    .action(async (id: string, deliveryId: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.retryWebhookDelivery(id, deliveryId);
      output(result, `Re-queued delivery ${deliveryId} (status: ${result.status}).`, opts.json);
    });
}
