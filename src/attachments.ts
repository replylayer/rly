import type { ApiClient } from './api-client.js';
import { LocalCliError } from './errors.js';
import type { UploadAttachmentResponse } from './types.js';

// Bounded post-upload poll. The content scan runs asynchronously in the
// derive-worker, so a freshly-uploaded handle is `pending` for a short window.
// Referencing it on a send before it goes terminal → 409 ATTACHMENT_SCAN_PENDING,
// so we wait it out (cap below) rather than racing the send into a spurious 409.
const ATTACHMENT_SCAN_POLL_INTERVAL_MS = 750;
const ATTACHMENT_SCAN_POLL_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Repeatable `--attach <path>` collector (mirrors collectMailbox in api-key.ts). */
export function collectAttach(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/**
 * Upload each local file to `mailboxId`, wait (bounded) for its async content
 * scan to leave `pending`, and return the handle ids for an `attachment_ids`
 * reference. A `flagged` attachment IS returned (its findings flow to the
 * message verdict at send, like a body finding); `error` fails closed; a scan
 * still pending past the timeout fails with a retry hint rather than racing the
 * send into a 409. Uploads are sequential — the backend takes one file part per
 * POST /v1/attachments.
 */
export async function uploadAttachments(
  client: ApiClient,
  paths: string[],
  mailboxId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    const handle = await client.uploadAttachment(path, mailboxId);
    let status: UploadAttachmentResponse['content_scan_status'] = handle.content_scan_status;
    let waited = 0;
    while (status === 'pending' && waited < ATTACHMENT_SCAN_POLL_TIMEOUT_MS) {
      await sleep(ATTACHMENT_SCAN_POLL_INTERVAL_MS);
      waited += ATTACHMENT_SCAN_POLL_INTERVAL_MS;
      const polled = await client.getAttachmentUpload(handle.id);
      if ('status' in polled) {
        // Consumed already (unexpected for a just-staged handle) — treat as
        // terminal; the send will surface a 409 if the handle is unusable.
        status = 'clean';
        break;
      }
      status = polled.content_scan_status;
    }
    if (status === 'error') {
      throw new LocalCliError(
        `Attachment '${path}' could not be scanned and cannot be sent.`,
        'ATTACHMENT_SCAN_ERROR',
        { attachment: path },
      );
    }
    if (status === 'pending') {
      throw new LocalCliError(
        `Attachment '${path}' is still being scanned after ${Math.round(
          ATTACHMENT_SCAN_POLL_TIMEOUT_MS / 1000,
        )}s — retry shortly.`,
        'ATTACHMENT_SCAN_PENDING',
        { attachment: path },
      );
    }
    ids.push(handle.id);
  }
  return ids;
}
