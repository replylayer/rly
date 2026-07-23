import type { ApiClient } from './api-client.js';
import { LocalCliError } from './errors.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a mailbox name or ID to a UUID.
 * If the input looks like a UUID, return it directly.
 * Otherwise, list mailboxes and find by name.
 */
export async function resolveMailboxId(
  client: ApiClient,
  nameOrId: string,
): Promise<string> {
  if (UUID_REGEX.test(nameOrId)) {
    return nameOrId;
  }

  const { mailboxes } = await client.listMailboxes();
  const match = mailboxes.find(
    (m) => m.name.toLowerCase() === nameOrId.toLowerCase(),
  );

  if (!match) {
    throw new LocalCliError(
      `Mailbox '${nameOrId}' not found. Run \`rly mailbox list\` to see available mailboxes.`,
      'MAILBOX_NOT_FOUND',
      { name: nameOrId },
    );
  }

  return match.id;
}

/**
 * Resolve the mailbox selector for a command: explicit flag wins, else the
 * REPLYLAYER_MAILBOX env var (emitted by the dashboard Connect-Agent snippet).
 * Returns undefined when neither is set so callers can run their own
 * required-field / thread-mode validation. The returned value is a name-or-id
 * selector — callers still pass it through resolveMailboxId; this only sources
 * the default, exactly like REPLYLAYER_API_KEY / REPLYLAYER_API_URL.
 */
export function resolveMailboxSelector(
  flagValue: string | undefined,
): string | undefined {
  return flagValue ?? process.env.REPLYLAYER_MAILBOX ?? undefined;
}

/**
 * Resolve a recipient email or ID to a UUID.
 * If the input looks like a UUID, return it directly.
 * Otherwise, list recipients and find by email.
 */
export async function resolveRecipientId(
  client: ApiClient,
  emailOrId: string,
): Promise<string> {
  if (UUID_REGEX.test(emailOrId)) {
    return emailOrId;
  }

  const { recipients } = await client.listRecipients();
  const match = recipients.find(
    (r) => r.email.toLowerCase() === emailOrId.toLowerCase(),
  );

  if (!match) {
    throw new LocalCliError(
      `Recipient '${emailOrId}' not found. Run \`rly recipients list\` to see verified recipients.`,
      'RECIPIENT_NOT_FOUND',
      { email: emailOrId },
    );
  }

  return match.id;
}
