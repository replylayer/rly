/**
 * Friendly per-code hints surfaced after the standard `Error:` + `Code:`
 * lines on CLI failures.
 *
 * Usage in index.ts:
 *   const hint = getFriendlyHint(err);
 *   if (hint) hint.forEach((line) => console.error(line));
 *
 * Add a new code by appending to the map. Empty array for codes with no hint.
 */
import type { ApiError } from './types.js';

/**
 * Local CLI error — thrown from CLI source for client-side validation,
 * mutual-exclusion conflicts, lookup failures, and interactive aborts.
 *
 * The catch block in `run()` (src/index.ts) routes these through the same
 * JSON-aware formatter as `ApiError`, so `--json` callers always get a
 * structured object instead of plain stderr.
 *
 * Codes are drawn from a closed enum (see W1 of
 * plans/cli-agent-uat-remediation.md §3 W1).
 */
export class LocalCliError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
    public exitCode: number = 1,
  ) {
    super(message);
    this.name = 'LocalCliError';
  }
}

const HINTS: Record<string, string[]> = {
  EMAIL_NOT_VERIFIED: [
    '',
    'Verify your email: rly auth verify --code <6-digit-code>',
    'Resend code:       rly auth resend --email <your-email>',
  ],
  PHONE_NOT_VERIFIED: [
    '',
    'Verify your phone: rly auth verify-phone --code <6-digit-code>',
    'Resend SMS code:   rly auth resend-phone',
  ],
  PHONE_VERIFICATION_EXPIRED: [
    '',
    'Your SMS verification code has expired.',
    'Request a new one: rly auth resend-phone',
  ],
  PHONE_VERIFICATION_ATTEMPTS_EXCEEDED: [
    '',
    'Too many incorrect attempts were made against this SMS code.',
    'Request a fresh code: rly auth resend-phone',
  ],
  // B1-2: verification code TTL expired — guide to resend.
  VERIFICATION_CODE_EXPIRED: [
    '',
    'Your verification code has expired (codes are valid for 10 minutes).',
    'Request a new one: rly auth resend --email <your-email>',
  ],
  // ONB-EC-13: email-verification lockout (5 wrong codes). An explicit resend
  // reissues a fresh code AND clears the attempt counter.
  TOO_MANY_ATTEMPTS: [
    '',
    'Too many verification attempts on this code.',
    'Request a fresh code (this resets the attempt counter): rly auth resend --email <your-email>',
  ],
  INSUFFICIENT_SCOPE: [
    '',
    'This action requires an admin API key.',
    'Use an admin key, or ask your account admin to perform it.',
  ],
  FOLDER_ALREADY_CLAIMED: [
    '',
    'Choose a different --imap-folder, or delete the conflicting mailbox first.',
  ],
  API_KEY_REQUIRED: [
    '',
    'Set your API key using one of:',
    '  rly auth login',
    '  --api-key <key>',
    '  REPLYLAYER_API_KEY environment variable',
  ],
  // Migration 085 — allowlist-mode reply friction. Point at the sanctioned
  // thread-continuation paths so an agent isn't stuck on a cold send.
  RECIPIENT_NOT_ON_ALLOWLIST: [
    '',
    'This mailbox is in allowlist mode and the recipient is not approved.',
    'To follow up in a conversation, continue the thread:',
    '  rly send --thread <thread-id> --body "..."',
    'Or reply to their last inbound message: rly reply <message-id>',
    'Thread replies must be enabled on the mailbox:',
    '  rly mailbox set-thread-replies <mailbox> on',
    'Or approve the address: rly mailbox allowlist add <mailbox> <email>',
  ],
  // R3 — agent-send containment. The account is trusted, but THIS send came
  // from an agent key and the recipient is neither approved nor a thread
  // participant. Point at the same sanctioned recovery paths as the allowlist
  // miss (continue the thread / approve the address), plus the account-admin
  // opt-out for a deliberately-open integration.
  RECIPIENT_AGENT_CONTAINED: [
    '',
    'This mailbox restricts agent sends to approved recipients (allowlist + thread participants).',
    'To follow up in a conversation, continue the thread:',
    '  rly send --thread <thread-id> --body "..."',
    'Or reply to their last inbound message: rly reply <message-id>',
    'Or approve the address: rly mailbox allowlist add <mailbox> <email>',
    'An account admin can opt this mailbox out from the dashboard if the integration is intentionally open.',
  ],
  // Suppression (do-not-contact) hit on a send/reply/draft-send. Terminal —
  // escalate, don't retry, until the suppression is removed or the recipient
  // changes.
  RECIPIENT_SUPPRESSED: [
    '',
    'This recipient is on your do-not-contact (suppression) list.',
    'Remove the suppression or send to a different recipient.',
  ],
  // Pay-as-you-go balance ran out mid-send. Terminal for the agent — topping up
  // is a human/session billing action, not an agent one.
  PAYGO_INSUFFICIENT_CREDITS: [
    '',
    'Pay-as-you-go balance is empty, so this send was declined.',
    'Agents cannot add funds — a human can top up at Settings → Billing.',
  ],
  // Migration 085 / Feature B — outbound MX validation. Widened by the
  // recipient-verification send-path PR-2 (`RecipientVerificationError`
  // covers this code too now, alongside the four below).
  RECIPIENT_UNDELIVERABLE: [
    '',
    "The recipient's domain has no mail servers (no MX or A record) — mail to it would hard-bounce.",
    'Double-check the address for typos, then try again.',
  ],
  // Send-path PR-2 (plans/outbound-recipient-verification-two-layer-2026-07-06.md
  // §7) — recipient-verification engine. Layer 1 strict syntax check (beyond
  // the schema's `format: email`).
  RECIPIENT_ADDRESS_INVALID: [
    '',
    'The recipient address is not a valid email address.',
    'Check for stray characters, spacing, or a malformed domain, then try again.',
  ],
  // Layer 1 fuzzy-match against ~25 top consumer domains (edit distance
  // exactly 1). The suggested domain rides in the error message above this hint.
  RECIPIENT_DOMAIN_TYPO_SUSPECTED: [
    '',
    'The recipient domain looks like a typo of a common provider (see the suggestion above).',
    'If the address is correct as-is, resend — this is a warning, not a hard rule.',
  ],
  // Layer 1 role-address list (or a Layer 2 vendor `role` verdict under the
  // `all_role` scope). A reply / thread continuation is exempt from this check.
  RECIPIENT_ROLE_ADDRESS: [
    '',
    'This looks like a role/distribution mailbox (e.g. noreply@, support@), not an individual inbox.',
    'Replying to an existing conversation with this sender is unaffected — only fresh sends are checked.',
  ],
  // Layer 1 disposable-domain list (or a Layer 2 vendor `disposable` verdict).
  RECIPIENT_DISPOSABLE_ADDRESS: [
    '',
    'The recipient domain is a disposable/temporary email provider.',
    'Ask for a permanent address, or double-check the domain for a typo.',
  ],
  // Continuity plan (plans/paygo-continuity-and-domain-teardown-2026-07-11.md
  // §3-A1, which also renamed the former S0.2 code). Send-path estate gate: this
  // mailbox is a continuity mailbox carried over from a trial-era domain —
  // it can reply within existing threads but not start new ones.
  ESTATE_CONTINUITY_REPLY_ONLY: [
    '',
    'This mailbox is a continuity mailbox from your trial — it can reply within existing email threads but cannot start new ones.',
    'Send new email from a mailbox on your ReplyLayer domain.',
  ],
  // S2.4 (plans/send-reputation-hardening-2026-07-06.md) — paid mailbox
  // creation while the account's sending domain is still provisioning.
  // Transient: `rly mailbox create` auto-retries for up to 60s unless
  // --no-wait was passed.
  DOMAIN_PROVISIONING_PENDING: [
    '',
    'Your sending domain is still being set up (DNS verification usually takes under a minute).',
    'Retry shortly — `rly mailbox create` waits automatically unless you passed --no-wait.',
    'Check status: rly domain list',
  ],
  // S2.4 — the sending-domain provisioning attempt failed. Not retryable
  // from the client; the operator clears the failed record.
  DOMAIN_PROVISIONING_FAILED: [
    '',
    'Setting up your sending domain failed. There is no shared fallback domain, so mailbox',
    'creation is blocked until it is fixed. Retry later; if it persists, contact support.',
  ],
  // S2.4 — platform (ReplyLayer-managed) domain rows are not explicitly
  // targetable via the API's domain_id field; the account default resolves
  // to them automatically. (The CLI never sends domain_id itself — this
  // hint covers raw-API callers surfacing the code through shared tooling.)
  PLATFORM_DOMAIN_NOT_TARGETABLE: [
    '',
    'ReplyLayer platform domains cannot be targeted by domain_id.',
    'Omit domain_id — your ReplyLayer domain is used automatically.',
  ],
  // Migration 085 — thread-mode send/draft errors.
  AMBIGUOUS_THREAD_RECIPIENT: [
    '',
    'This thread has more than one participant — specify who to send to.',
    'Pass --to <email> with one of the thread participants.',
  ],
  AMBIGUOUS_THREAD_MAILBOX: [
    '',
    'This thread key exists in more than one of your mailboxes.',
    'Pass --from <mailbox> (send) or --mailbox <mailbox> (draft) to disambiguate.',
  ],
  RECIPIENT_NOT_IN_THREAD: [
    '',
    'The recipient you passed is not a participant in this thread.',
    'You can only continue a thread to someone who already wrote into it.',
  ],
  THREAD_HAS_NO_INBOUND_RECIPIENT: [
    '',
    'This thread has no inbound participant to reply to (it is send-only).',
    'Start a new conversation: rly send --from <mailbox> --to <email> --subject ... --body ...',
  ],
  // RL-UAT-020 (S2) — --json mode cannot drive the interactive delete prompt.
  CONFIRM_REQUIRED: [
    '',
    'This action requires confirmation. In --json mode, pass --confirm:',
    '  rly account delete --confirm',
  ],
  // S7 NTH-002 — unsupported Gmail-style search operator. (has:attachment is
  // supported by the server but capability-gated — it errors on older servers
  // that do not advertise messages.has_attachment_filter on /v1/health.)
  SEARCH_OPERATOR_UNSUPPORTED: [
    '',
    'Supported search operators: from: subject: after: before: is:starred has:attachment',
    '(has:attachment needs a server that advertises it — older builds reject it.)',
    'Not supported: to:, is:read, is:unread, in:, label: (and any other operator).',
  ],
  // S7 NTH-002 — search residual under the server-enforced minimum length.
  SEARCH_TERM_TOO_SHORT: [
    '',
    'search terms must be at least 3 characters',
  ],
  // S7 NTH-004 / gate C — cross-mailbox thread-key collision on account-wide
  // read. `inbox threads read` now has a --mailbox flag, so the hint points at
  // it (the thread may exist but the same key lives in more than one mailbox).
  THREAD_NOT_FOUND: [
    '',
    'No such thread in your account — OR the thread key resolves in more than',
    'one of your mailboxes. Scope the read with --mailbox <name-or-id>:',
    '  rly inbox threads read <thread-id> --mailbox <name-or-id>',
  ],
  // G7 — inbox release/block are inbound-only; they refuse outbound rows
  // because the server /release self-dispatches an outbound quarantine via
  // Mailgun (a governance collision a direction-blind CLI would expose).
  OUTBOUND_RELEASE_REFUSED: [
    '',
    'Releasing an OUTBOUND quarantine re-sends the message — the CLI refuses it.',
    'Release it from the dashboard, or headlessly via the customer API:',
    '  POST /v1/messages/:id/release   (SDK: messages.release(id))',
  ],
  OUTBOUND_BLOCK_REFUSED: [
    '',
    'This is an outbound message — `inbox block` is inbound-only in the CLI.',
    'Manage outbound quarantines from the dashboard.',
  ],
  // Outbound attachments (plans/outbound-attachment-ux.md) — --attach surface.
  OUTBOUND_ATTACHMENTS_DISABLED: [
    '',
    'Outbound attachments are not enabled for this mailbox.',
    'Enable them from the dashboard (Settings → Mailbox → Outbound attachments).',
    'The feature requires a Pro+ plan and a session-authenticated re-auth step.',
  ],
  REAUTH_REQUIRES_SESSION: [
    '',
    'This is a loosening action (it reduces a safeguard), so it requires a dashboard',
    'session with TOTP/password re-auth — an API key cannot perform it.',
    'Policy loosenings (raise/clear the daily cap, remove a send window, enable agent',
    'sending) live at https://app.replylayer.ai/policy. Outbound attachments are under',
    'Settings → Mailbox. Tightenings (e.g. `rly policy set-mode read_only`) work with a key.',
  ],
  // PB-001 Option B — 'restricted' resolves to the native allowlist mode, so
  // restricting an OPEN mailbox with an empty allowlist trips this pre-flip
  // guard. Both acknowledgment paths carry their own --force-empty flag
  // (FR-03, final review 2026-07-16): `policy set-mode --force-empty` finishes
  // the full mode template in one step; `mailbox set-policy --force-empty`
  // flips only the recipient authority.
  ALLOWLIST_EMPTY: [
    '',
    'Add at least one approved recipient first: rly mailbox allowlist add <mailbox> <email>',
    'Or acknowledge the empty list and proceed — agent sends to NEW/off-thread recipients',
    'are blocked until you add entries (in-thread replies and human sends are unaffected):',
    '  rly policy set-mode <mode> --mailbox <mailbox> --force-empty   (applies the full mode)',
    '  rly mailbox set-policy <mailbox> allowlist --force-empty       (recipient authority only)',
  ],
  // Policy builder (plans/dashboard-policy-builder-mvp §6.1). These usually
  // arrive as denial-envelope 403s (reason_axis:'mailbox_config'), which
  // denialHint answers first; the static entries below are the fallback for a
  // server that emits the bare code.
  AGENT_SENDING_DISABLED: [
    '',
    'This mailbox does not permit agent-origin sends (it is read-only or draft-only for agents).',
    'A human account owner can re-enable sending from the dashboard (a loosening, needs re-auth):',
    '  https://app.replylayer.ai/policy',
  ],
  AGENT_DRAFTING_DISABLED: [
    '',
    'This mailbox is read-only for agents — an agent key cannot create or update drafts.',
    'A human account owner can enable draft-only or full sending from the dashboard:',
    '  https://app.replylayer.ai/policy',
  ],
  AMBIGUOUS_POLICY_MODE_APPLICATION: [
    '',
    'apply_policy_mode cannot be combined with raw identity fields (agent_authoring_mode /',
    'hitl_mode / agent_send_policy / recipient_policy_mode / agent_send_containment) in one call.',
    'Apply a mode alone (`rly policy set-mode <mode> --mailbox <id>`), or set the raw fields directly.',
  ],
  OUTBOUND_IMAGE_DISCLAIMER_REQUIRED: [
    '',
    'Image attachments require accepting the image-risk disclaimer for this mailbox.',
    'Accept it once from the dashboard (Settings → Mailbox → Outbound attachments).',
  ],
  ATTACHMENT_SCAN_PENDING: [
    '',
    'The attachment is still being scanned. Wait a moment and retry the send.',
  ],
  ATTACHMENT_SCAN_ERROR: [
    '',
    'The attachment could not be scanned, so it cannot be sent (fail-closed).',
    'Re-upload the file and try again; if it persists, the file may be unreadable.',
  ],
  FILE_READ_ERROR: [
    '',
    'The --attach path could not be read. Check the path exists and is readable.',
  ],
  // RL-UAT-013 — `inbox attachment preview` retrieval error codes. The route
  // returns these for an attachment with no safe text preview, one still being
  // generated, or a mailbox/agent-key not entitled to previews.
  // (ATTACHMENT_PREVIEW_BLOCKED is intentionally left to its bare error message
  // — "Preview was blocked by content scanning" is already self-explanatory.)
  ATTACHMENT_PREVIEW_NOT_AVAILABLE: [
    '',
    'No safe text preview exists for this attachment.',
    'It may be a metadata-only file (bytes not delivered), a non-previewable type, or preview generation failed.',
    'Check the message: rly inbox read <message-id>',
  ],
  ATTACHMENT_PREVIEW_PENDING: [
    '',
    'The preview is still being generated. Retry in a few seconds.',
  ],
  ATTACHMENT_PREVIEW_DISABLED: [
    '',
    'Attachment previews are not available here — either the mailbox is not in a preview mode,',
    'your plan does not include it, or this agent key is not permitted. See the error details.',
  ],
  // Outbound HTML sanitization (Phase 2) — --html carried active/unsafe
  // constructs the delivery sanitizer refuses to ship. The error `details.categories`
  // (printed on the standard `Details:` line) names which classes were found
  // (e.g. script, iframe, form, event_handler, javascript_url).
  OUTBOUND_HTML_ACTIVE_CONTENT_REJECTED: [
    '',
    'Your --html body contains active or unsafe content that cannot be delivered.',
    'See the categories in Details above (e.g. script, iframe, form, event_handler, javascript_url).',
    'Remove those constructs from the HTML, or send a plain-text --body only.',
  ],
  // Outbound HTML sanitization (Phase 2) — the sanitizer failed closed: the
  // --html could not be parsed, or it exceeded the 1,000,000-byte input limit.
  OUTBOUND_HTML_SANITIZE_FAILED: [
    '',
    'The --html body could not be sanitized for delivery (it failed to parse, or exceeded the 1 MB limit).',
    'Simplify or shrink the HTML, or send a plain-text --body only.',
  ],
  // B1-1 — CLI signup code errors. Human-mode instruction text is also
  // printed inline by signup.ts (before the rethrow) so the user sees the
  // guidance even when it arrives via the hints path. Both suppress under
  // --json so scripted callers get only the structured code.
  CLI_SIGNUP_CODE_REQUIRED: [
    '',
    'CLI signup needs a dashboard-issued code.',
    'New to ReplyLayer? Create your first account at https://app.replylayer.ai/signup',
    'Already have an account? Sign in at https://app.replylayer.ai, then generate a CLI signup code.',
    'Re-run with: rly signup --cli-signup-code rls_cli_…',
  ],
  CLI_SIGNUP_CODE_INVALID: [
    '',
    'That CLI signup code is expired or already used (codes last 30 minutes and are single-use).',
    'Generate a fresh one from https://app.replylayer.ai',
  ],
};

/**
 * Cause-aware denial hint: when the error carries a denial envelope
 * (`details.reason_axis`), render the hint for THAT axis — so a tier denial says
 * "upgrade", a mailbox-config denial says "enable the mode", a key_role denial says
 * "use a session". Replaces the old surface-keyed hints that misdirected (e.g. told
 * a sandbox agent to "enable a preview tier on the mailbox" when the fix was to
 * upgrade). Falls through (returns null) for any unknown/future axis so
 * getFriendlyHint can fall back to the static code map.
 */
function denialHint(err: LocalCliError | ApiError): string[] | null {
  const d = (err as ApiError).details as
    | {
        reason_axis?: string;
        required_tier?: string;
        required_mailbox_mode?: string;
        cheapest_next_step?: string;
        upgrade_url?: string;
      }
    | undefined;
  if (!d || !d.reason_axis) return null;
  const link = d.upgrade_url ? `\n  ${d.upgrade_url}` : '';
  switch (d.reason_axis) {
    case 'tier':
      return ['', `This requires the ${d.required_tier ?? 'Pro'} plan. Agents can't change billing — open the link below or ask your account owner:${link}`];
    case 'trust_capacity':
      return ['', d.cheapest_next_step === 'paygo'
        ? `Send capacity reached. Add $5 in pay-as-you-go credits to keep sending:${link}`
        : `Send capacity reached. Add credits or wait for your daily limit to reset:${link}`];
    case 'account_state':
      return ['', `Your sandbox trial ended. Add $5 in pay-as-you-go credits, or upgrade:${link}`];
    case 'mailbox_config':
      return ['', `Enable ${d.required_mailbox_mode ?? 'the required'} mode on this mailbox (account admin, from the dashboard).`];
    case 'key_role':
      return ['', 'This action needs a dashboard session (a human), not an API key.'];
    case 'account_policy':
      return ['', "This action is disabled for API keys on your account. An account admin can enable it from a dashboard session (Settings), then your key can use it."];
    case 'recipient_containment':
      // R3 — agent-send containment. Same recovery framing as the
      // RECIPIENT_AGENT_CONTAINED code-keyed hint, surfaced cause-aware off the
      // denial envelope. No billing link (non-monetary axis).
      return [
        '',
        'This mailbox restricts agent sends to approved recipients (allowlist + thread participants).',
        'Continue the thread (rly send --thread / rly reply), approve the address (rly mailbox allowlist add),',
        'or have an account admin opt the mailbox out from the dashboard.',
      ];
    default:
      return null;
  }
}

// RATE_LIMITED is overloaded server-side: the daily send-budget 429 is the ONLY
// one carrying details.daily_limit (+ sends_remaining / reset_at); every other
// rate limit (domain verify, recipient add, generic/auth limiters) is a
// short-window retry with details.retry_after or no details. Gate the send-quota
// copy on the daily_limit signature — PRESENCE, not truthiness, since the generic
// limiters DO return a details object (retry_after) — so a non-send throttle is
// not told to check "rly account quota". Retry copy stays honest about timing:
// the CLI drops the Retry-After header, and some 429s show no body window.
const RATE_LIMITED_SEND_BUDGET: string[] = [
  '',
  "You've hit today's send limit. The budget resets at midnight UTC.",
  'Check your current quota and reset time: rly account quota',
];
const RATE_LIMITED_RETRY: string[] = [
  '',
  'This is a temporary rate limit, not your daily send quota.',
  'If a retry time is shown above, wait that long; otherwise wait a bit and try again.',
];

export function getFriendlyHint(err: LocalCliError | ApiError): string[] | null {
  // Denial-envelope hints (cause-aware: tier / capacity / mailbox-mode) win over
  // every code-keyed hint, including the RATE_LIMITED branch below.
  const denial = denialHint(err);
  if (denial) return denial;
  if (err.code === 'RATE_LIMITED') {
    const details = (err as ApiError).details as { daily_limit?: unknown } | undefined;
    return details?.daily_limit !== undefined ? RATE_LIMITED_SEND_BUDGET : RATE_LIMITED_RETRY;
  }
  // Policy builder §4.1 item 2 — a mailbox send window closed to agent sends.
  // Surface next_open_at (present unless the window is unreachable) so the agent
  // knows when to retry rather than treating a temporal block as terminal.
  if (err.code === 'SEND_WINDOW_CLOSED') {
    const details = (err as ApiError).details as { next_open_at?: unknown } | undefined;
    const when = typeof details?.next_open_at === 'string' ? details.next_open_at : null;
    return [
      '',
      "This mailbox's send window is closed to agent sends right now (your own dashboard/admin sends are exempt).",
      when ? `The window reopens at ${when}; schedule the send for then, or send it yourself.` : 'Try again during the allowed hours, or send it yourself.',
    ];
  }
  if (!err.code) return null;
  return HINTS[err.code] ?? null;
}

/**
 * CLI exit-code contract (plan M2.7, docs/cli-machine-interface.md).
 *
 *   0  success
 *   1  remote / API / runtime failure  (the historical catch-all)
 *   2  local usage / configuration error
 *   3  authentication required / invalid — OPT-IN ONLY
 *   4  governed email-effect: blocked (terminal) — `--strict` send/reply ONLY
 *   5  governed email-effect: held_infrastructure (retryable) — `--strict` ONLY
 *
 * Codes `4`/`5` (Track 2 — Governed Email-Effect Contract v1) are emitted ONLY
 * when the caller passed `rly send --strict` / `rly reply --strict` and the
 * server returned a non-delivered outcome. A human-releasable hold
 * (`held_for_review`) and a delivered send stay `0`. Without `--strict` the
 * send/reply always exits `0` (the legacy default is unchanged). The mapping
 * lives in `lib/strict-outcome.ts`.
 *
 * Codes `124` (timeout) and `130` (interrupt) are deliberately NOT emitted by
 * the binary: the PyPI `rly` launcher owns them (it emits its own `124` on
 * subprocess TimeoutExpired and `130` on KeyboardInterrupt, and `127` when the
 * bundled binary is missing). If the binary also emitted them, a caller going
 * through `rly` could not tell a launcher timeout from a CLI-internal one.
 *
 * Exit code `3` is opt-in for one release so existing scripts that branch on
 * `$? -eq 1` for re-login keep working. Set `REPLYLAYER_AUTH_EXIT_CODE=1` to
 * map auth failures (missing/invalid API key) to `3`.
 */
export const EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  AUTH: 3,
} as const;

/** True when the caller opted into the distinct auth exit code (`3`). */
export function authExitCodeOptIn(): boolean {
  return process.env.REPLYLAYER_AUTH_EXIT_CODE === '1';
}

/** Local error codes that represent an authentication problem. */
const AUTH_LOCAL_CODES = new Set(['API_KEY_REQUIRED']);

/**
 * Resolve the process exit code for a thrown error, honoring the opt-in auth
 * code. `fallback` is the code that would otherwise apply (e.g. the historical
 * `1`, or a `LocalCliError.exitCode`). When the opt-in is OFF this returns
 * `fallback` unchanged, so default behavior is byte-identical to before.
 */
export function resolveAuthExitCode(
  err: { code?: string; statusCode?: number },
  fallback: number,
): number {
  if (!authExitCodeOptIn()) return fallback;
  const isAuthError =
    (err.code != null && AUTH_LOCAL_CODES.has(err.code)) ||
    err.statusCode === 401;
  return isAuthError ? EXIT.AUTH : fallback;
}
