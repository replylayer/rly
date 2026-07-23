/**
 * Track 1 (§3a) — probe-first wiring shared by `rly send` and `rly reply`.
 *
 * When `--idempotency-key` is set, the commands call the NON-THROWING replay
 * probe (`ApiClient.getIdempotencyReplay`) BEFORE any attachment upload /
 * original-message fetch, so a same-key retry whose local file is gone (or whose
 * reply original was deleted) replays the prior result end-to-end instead of
 * dying in the local preflight. This helper turns the discriminated probe result
 * into one of three command-shaped outcomes:
 *
 *   - miss            -> returns `undefined` (the caller proceeds: upload + keyed POST)
 *   - replay          -> returns the prior SendMessageResponse (the caller prints it)
 *   - in_flight       -> throws LocalCliError (no upload)
 *   - not_proven_sent -> throws LocalCliError (no upload)
 *   - bound_to_draft  -> throws LocalCliError (no upload)
 *
 * The 401/403/500/other-409-code cases are re-thrown by `getIdempotencyReplay`
 * itself as a real ApiError before reaching here.
 */
import type { ApiClient } from '../api-client.js';
import type { SendMessageResponse } from './../protocol.js';
import { LocalCliError } from '../errors.js';

/**
 * Run the §3a probe and map it to a command outcome.
 *
 * @returns the prior message to print on a `replay`, or `undefined` on a `miss`
 *   (proceed with the fresh keyed send/reply).
 * @throws LocalCliError on `in_flight` / `not_proven_sent` / `bound_to_draft`,
 *   carrying the wire-equivalent code so scripted (`--json`) callers can branch.
 */
export async function probeIdempotencyReplay(
  client: ApiClient,
  idempotencyKey: string,
): Promise<SendMessageResponse | undefined> {
  const probe = await client.getIdempotencyReplay(idempotencyKey);
  switch (probe.kind) {
    case 'miss':
      return undefined;
    case 'replay':
      return probe.message;
    case 'in_flight': {
      const wait = probe.retryAfter != null ? ` Retry in ~${probe.retryAfter}s.` : '';
      throw new LocalCliError(
        `A same-key send/reply is still in flight (idempotency key in use).${wait}`,
        'IDEMPOTENT_REQUEST_IN_FLIGHT',
        probe.retryAfter != null ? { retry_after: probe.retryAfter } : undefined,
      );
    }
    case 'not_proven_sent':
      throw new LocalCliError(
        'A same-key send/reply could not be proven sent (dispatch outcome indeterminate). Inspect the message before retrying with a new key.',
        'IDEMPOTENT_REQUEST_NOT_PROVEN_SENT',
      );
    case 'bound_to_draft':
      throw new LocalCliError(
        'This idempotency key is already bound to a draft on this account and cannot be reused for an immediate send/reply. Use a distinct key.',
        'IDEMPOTENCY_KEY_BOUND_TO_DRAFT',
      );
  }
}
