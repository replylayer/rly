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

/** Repeatable `--header` collector, matching the `--attach` / `--mailbox` idiom. */
function collectHeader(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/**
 * Parse `--header "Name: value"` occurrences into the wire map.
 *
 * Split on the FIRST colon only: a value legitimately contains colons
 * (`Authorization: Bearer x`, a URL, a `key:secret` pair), and splitting on
 * every colon would silently truncate one.
 *
 * Only the two failures the CLI can be certain about are rejected locally — a
 * missing colon and an empty name — because those mean the operator's shell
 * quoting was wrong and a round trip would return a confusing server error.
 * Everything else (the name grammar, the reserved list, value characters, the
 * 8-header cap) is left to the server, which is the single validator and
 * re-validates again on the delivery path. A local copy of those rules would be
 * one more thing to drift.
 *
 * A duplicate name is rejected here too, but only because the map literal would
 * otherwise silently drop the earlier one before the server ever saw the
 * conflict it is supposed to report.
 *
 * NO ERROR HERE ECHOES THE RAW ARGUMENT. A `--header` argument carries a
 * credential, and the malformed cases are exactly the ones where the operator's
 * quoting went wrong — so the "offending text" is as likely to be the secret as
 * the name. Errors name the 1-based occurrence, and the header NAME only once
 * one has been parsed out (names are not secret; they are stored in plaintext
 * server-side).
 */
function parseHeaderOptions(raw: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const position = `--header #${index + 1}`;
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw new LocalCliError(
        `${position} must be in "Name: value" form — no ':' found. (The value is not echoed; it may be a credential.)`,
        'INVALID_OPTION',
        { option: 'header', position: index + 1 },
        2,
      );
    }
    const name = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (name === '') {
      throw new LocalCliError(
        `${position} has an empty header name before the ':'.`,
        'INVALID_OPTION',
        { option: 'header', position: index + 1 },
        2,
      );
    }
    // The server compares names case-insensitively; mirror that here so
    // `--header "A: 1" --header "a: 2"` is caught rather than silently losing
    // the first entry to object-key collapse.
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new LocalCliError(
        `--header "${name}" is given more than once (header names are compared case-insensitively)`,
        'INVALID_OPTION',
        { option: 'header', name: lower },
        2,
      );
    }
    seen.add(lower);
    headers[name] = value;
  }
  return headers;
}

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
    .option('--header <name:value>', 'Static request header added to every delivery, e.g. "Authorization: Bearer tok" (max 8; repeat for multiple). Values are write-only — no read ever returns one.', collectHeader, [] as string[])
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      // Parse BEFORE the confirmation prompt — a malformed --header should fail
      // immediately rather than after the operator has typed "yes".
      const rawHeaders = (localOpts.header ?? []) as string[];
      const requestHeaders = rawHeaders.length > 0 ? parseHeaderOptions(rawHeaders) : undefined;
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Create webhook → ${localOpts.url}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.createWebhook({
        url: localOpts.url as string,
        enabled_events: localOpts.event as string[],
        ...(localOpts.description ? { description: localOpts.description as string } : {}),
        ...(localOpts.disabled ? { enabled: false } : {}),
        ...(requestHeaders ? { request_headers: requestHeaders } : {}),
      });
      const headerNames = result.request_header_names ?? [];
      output(
        result,
        `Created webhook: ${result.url}\nWebhook ID: ${result.id}\nSigning secret (shown once): ${result.signing_secret}\nStore it now — it cannot be retrieved again.` +
          (headerNames.length > 0 ? `\nCustom request headers: ${headerNames.join(', ')} (values are write-only and are never shown again).` : ''),
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
        ['ID', 'URL', 'ENABLED', 'EVENTS', 'HEADERS', 'FAILURES'],
        result.webhooks.map((w) => [
          w.id,
          w.url,
          w.enabled ? 'yes' : 'no',
          String(w.enabled_events.length),
          // Names only — the values are write-only and never returned.
          (w.request_header_names ?? []).join(',') || '-',
          String(w.consecutive_failures),
        ]),
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
        // Names only. There is no `--show-headers`: the server returns no value
        // on any read path, so the CLI has nothing to reveal.
        ['request_header_names', (result.request_header_names ?? []).join(',') || '(none)'],
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
    .option('--header <name:value>', 'REPLACE the whole custom request-header map, e.g. "Authorization: Bearer tok" (max 8; repeat for multiple). There is no per-header edit — the stored values cannot be read back.', collectHeader, [] as string[])
    .option('--clear-headers', 'Remove every custom request header (mutually exclusive with --header)')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const body: { url?: string; description?: string; enabled_events?: string[]; enabled?: boolean; request_headers?: Record<string, string> | null } = {};
      if (localOpts.url) body.url = localOpts.url as string;
      if (localOpts.event) body.enabled_events = localOpts.event as string[];
      if (localOpts.description !== undefined) body.description = localOpts.description as string;
      if (localOpts.enabled !== undefined) {
        if (localOpts.enabled !== 'true' && localOpts.enabled !== 'false') {
          throw new LocalCliError("--enabled must be 'true' or 'false'", 'INVALID_OPTION', { option: 'enabled', value: localOpts.enabled }, 2);
        }
        body.enabled = localOpts.enabled === 'true';
      }
      // `request_headers` is three-way server-side: an object REPLACES the map,
      // `null` CLEARS it, absent leaves it alone. The two flags are the two
      // writing forms, so asking for both at once has no defined meaning.
      const rawHeaders = (localOpts.header ?? []) as string[];
      if (rawHeaders.length > 0 && localOpts.clearHeaders) {
        throw new LocalCliError('--header and --clear-headers cannot be used together', 'INVALID_OPTION', { options: ['--header', '--clear-headers'] }, 2);
      }
      if (rawHeaders.length > 0) body.request_headers = parseHeaderOptions(rawHeaders);
      else if (localOpts.clearHeaders) body.request_headers = null;
      if (Object.keys(body).length === 0) {
        throw new LocalCliError('at least one of --url / --event / --description / --enabled / --header / --clear-headers is required', 'INVALID_OPTION', {}, 2);
      }
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Update webhook ${id}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.updateWebhook(id, body);
      const headerNames = result.request_header_names ?? [];
      output(
        result,
        `Updated webhook ${id}.` +
          (body.request_headers !== undefined
            ? `\nCustom request headers: ${headerNames.length > 0 ? headerNames.join(', ') : '(none)'}`
            : ''),
        opts.json,
      );
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
