/**
 * Migration 047 — `rly firewall-release <message-id>`
 *
 * Release a `firewall_blocked` message back into scanner processing.
 * Returns 202 immediately; the actual scanner verdict (available /
 * quarantined / blocked) is observed by polling the message detail
 * endpoint or via the matching webhook event.
 *
 * Auth: admin + agent. Mailbox-bound agent keys can release only
 * messages whose mailbox they're bound to.
 */
import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { output } from '../format.js';

export function firewallReleaseCommand(): Command {
  return new Command('firewall-release')
    .description('Release a firewall_blocked message back into scanner processing')
    .argument('<message-id>', 'Message UUID')
    .action(async (messageId: string, _ignored, cmd) => {
      const globals = cmd.optsWithGlobals();
      const apiKey = requireApiKey(globals.apiKey);
      const client = new ApiClient({ baseUrl: globals.apiUrl, apiKey });

      const result = await client.firewallRelease(messageId);
      output(
        result,
        `Released message ${result.message_id}; scanner running (state=${result.state}). Poll /v1/messages/${result.message_id} for the verdict.`,
        globals.json,
      );
    });
}
