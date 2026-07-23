// Local types for the CLI that aren't part of the private monorepo wire types.

import type { GetMessageResponse, ScanSummary, SendMessageResponse } from './protocol.js';

// === Track 1 (migration 093) — non-throwing idempotency replay-probe result ===
// GET /v1/messages/idempotency carries the key in the Idempotency-Key header and
// returns a discriminated outcome. The base ApiClient.request() THROWS on every
// non-2xx, so the probe helper catches the load-bearing 404 (the common miss)
// and the three 409 conflict codes and maps them to a value — re-throwing any
// other non-2xx (401/403/500/other-409-code) as a real ApiError.
//   200                                    -> { kind: 'replay', message }
//   404                                    -> { kind: 'miss' }
//   409 IDEMPOTENT_REQUEST_IN_FLIGHT       -> { kind: 'in_flight', retryAfter } (from BODY details.retry_after)
//   409 IDEMPOTENT_REQUEST_NOT_PROVEN_SENT -> { kind: 'not_proven_sent' }
//   409 IDEMPOTENCY_KEY_BOUND_TO_DRAFT     -> { kind: 'bound_to_draft' }
export type IdempotencyProbeResult =
  | { kind: 'miss' }
  | { kind: 'replay'; message: SendMessageResponse }
  | { kind: 'in_flight'; retryAfter: number | null }
  | { kind: 'not_proven_sent' }
  | { kind: 'bound_to_draft' };

// === Outbound attachment upload (POST /v1/attachments) ===
// The upload-response shapes are local consts on the API route (not part of the
// private monorepo wire types, and the CLI does not depend on the SDK), so they
// are declared here. `id` is the opaque handle to put in a send/reply/draft
// attachment_ids array.
export interface UploadAttachmentResponse {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  hash: string;
  scan?: ScanSummary;
  content_scan_status: 'pending' | 'clean' | 'flagged' | 'error';
}

// === Threads (S7 NTH-004) ===
// Matches the server's thread-summary schema and the star-response schemas.
// These are NOT part of the private monorepo wire types (only in the TS SDK,
// which the CLI does not depend on), so they are declared locally.

export interface ThreadSummary {
  id: string;
  subject: string;
  first_message_at: string;
  last_message_at: string;
  message_count: number;
  unread_count: number;
  starred: boolean;
  participants: string[];
}

// GET /v1/mailboxes/:id/threads
export interface ListThreadsResponse {
  threads: ThreadSummary[];
}

// GET /v1/threads/:id — reuses GetMessageResponse per message item, mirroring
// getThreadResponseSchema (the server reuses getMessageResponseSchema there).
export interface GetThreadResponse {
  id: string;
  mailbox_id: string;
  /** Owning mailbox name (mailboxes.name). */
  mailbox_name?: string | null;
  subject: string;
  message_count: number;
  messages: GetMessageResponse[];
}

// PATCH /v1/messages/:id/star — messageStarResponseSchema.
export interface MessageStarResponse {
  message_id: string;
  starred: boolean;
}

// PATCH /v1/mailboxes/:id/threads/:thread_id/star — threadStarResponseSchema.
export interface ThreadStarResponse {
  thread_id: string;
  starred: boolean;
  updated_count: number;
}

export interface AddRecipientResponse {
  id: string;
  email: string;
  status: 'pending' | 'confirmed';
  created_at: string;
}

export interface DeleteMailboxResponse {
  status: string;
}

export interface ScannerPolicy {
  language_mode?: 'english_only' | 'allow_all_languages' | 'disabled';
  disabled_scanners?: string[];
  disabled_proxy_criteria?: string[];
  outbound_pii_policy?: Partial<Record<
    'ssn' | 'credit_card' | 'phone_number',
    'allow' | 'allow_with_warning' | 'review' | 'quarantine' | 'block'
  >>;
  outbound_review_policy?: {
    approval_note?: 'optional' | 'required_for_sensitive_pii';
  };
}

export interface UpdateMailboxResponse {
  id: string;
  name: string;
  address: string;
  scanner_policy: ScannerPolicy | null;
  // Recipient-visible From display name (nullable — falls back to `name`) and
  // the server-computed "what recipients see" string (display_name ?? name plus
  // the sandbox-only " via ReplyLayer" suffix). Optional to tolerate older
  // servers; carried by GET /v1/mailboxes/:id and the PATCH response.
  display_name?: string | null;
  effective_from_display?: string;
  // Per-mailbox policy fields surfaced by GET /v1/mailboxes/:id and the PATCH
  // response. Optional — not every PATCH response echoes every field.
  hitl_mode?: 'disabled' | 'all_outbound';
  pii_mode?: 'passthrough' | 'redacted';
  default_subaddress_mode?: 'reply_to' | 'from' | 'none';
  pii_redaction_config?: Record<string, unknown> | null;
  recipient_policy_mode?: 'blocklist' | 'allowlist';
  sender_policy_mode?: 'blocklist' | 'allowlist';
  allow_thread_replies?: boolean;
  agent_send_containment?: boolean;
  // Single "agent sends" control — derived view over the two fields above.
  agent_send_policy?: 'restricted' | 'open';
  restricted_by?: 'mailbox_allowlist' | 'agent_containment' | null;
  attachment_exposure_mode?: string | null;
  attachment_allowed_file_families?: string[];
  attachment_reauth_at?: string | null;
  attachment_policy_version?: string | null;
  current_disclaimer_version?: string;
  legacy_wildcard_active?: boolean;
}

// POST /v1/mailboxes/:id/attachment-access response (G5 / S1-SAFE).
export interface AttachmentAccessResponse {
  mailbox_id: string;
  mode: string;
  allowed_file_families: string[];
  current_disclaimer_version?: string;
  legacy_wildcard_active?: boolean;
  [k: string]: unknown;
}

// GET /v1/messages/:id/attachments/:idx — presigned download URL (FIND-011).
// Mirrors the SDK's AttachmentDownloadResponse. `url` is a short-lived signed
// R2 URL (typically 5 min). Session-only re-auth gate applies on the server;
// the CLI surfaces it as a plain ApiError with REAUTH_REQUIRES_SESSION.
export interface AttachmentDownloadUrlResponse {
  url: string;
  expires_at: string;
  content_type: string;
  filename: string;
  size: number;
  av_verdict?: string | null;
}

// Bulk-add partial-success shape — shared across all four bulk endpoints
// (outbound allowlist, inbound allowlist, suppressions, inbound blocklist).
// Mirrors BulkAddAllowlistResponse / BulkAddSuppressionsResponse in the SDK.
// The full shape MUST be preserved (audit F6): `invalid` entries carry a
// per-email `reason`; `counts` carries the four-field summary.
export interface BulkAddResponse {
  added: Array<{ email: string; created_at: string; pattern_type?: 'email' | 'domain' }>;
  already_existed: string[];
  invalid: Array<{ email: string; reason: string }>;
  counts: {
    added: number;
    already_existed: number;
    invalid: number;
    total: number;
  };
}

// GET /v1/messages/:id/attachments/:idx/preview response (RL-UAT-013).
// Mirrors the server route's 200 shape and the SDK's AttachmentPreviewResponse.
// `kind` is the literal 'text' the route emits today — extracted text only,
// never raw bytes.
export interface AttachmentPreviewResponse {
  attachment: {
    filename: string;
    content_type: string;
    size: number;
    hash: string;
  };
  preview: {
    kind: 'text';
    content: string;
    truncated: boolean;
    char_count: number | null;
    page_count: number | null;
    extractor: string;
    generated_at: string;
  };
}

export interface CreateApiKeyResponse {
  id: string;
  api_key: string;
  role: 'admin' | 'agent';
  label: string | null;
  mailbox_ids: string[];
}

export interface UpdateApiKeyResponse {
  id: string;
  role: 'agent';
  label: string | null;
  mailbox_ids: string[];
}

export interface ListApiKeysResponse {
  keys: Array<{
    id: string;
    prefix: string;
    status: string;
    role: string | null;
    label: string | null;
    mailbox_ids: string[];
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
  }>;
}

export interface RevokeApiKeyResponse {
  status: string;
  /** RL-UAT-019 — revocation metadata echoed by current servers. */
  revoked_at?: string;
  revoked_by?: string;
}

// === Webhooks (G8) — mirrors the SDK webhook resource. enabled_events kept
// as string[] (the server validates the closed event enum). ===
export interface CreateWebhookResponse {
  id: string;
  url: string;
  description: string | null;
  enabled: boolean;
  enabled_events: string[];
  signing_secret: string;
  created_at: string;
}
export interface WebhookSummary {
  id: string;
  url: string;
  description: string | null;
  enabled: boolean;
  enabled_events: string[];
  created_at: string;
  updated_at: string;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
}
export interface ListWebhooksResponse {
  webhooks: WebhookSummary[];
}
export interface RotateWebhookSecretResponse {
  signing_secret: string;
}
export interface WebhookDeliverySummary {
  id: string;
  event_type: string;
  status: string;
  http_status: number | null;
  attempt_count: number;
  created_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  next_retry_at: string | null;
  response_preview: string | null;
}
export interface ListWebhookDeliveriesResponse {
  deliveries: WebhookDeliverySummary[];
  has_more: boolean;
  next_before_at?: string;
  next_before_id?: string;
}

export type StorageUsageState = 'normal' | 'warning' | 'near_full' | 'over_limit';

export interface StorageUsage {
  used_bytes: number;
  limit_bytes: number | null;
  percent_used: number | null;
  state: StorageUsageState;
  breakdown: {
    raw_mime_bytes: number;
    derivative_bytes: number;
  };
}

// Minimal identity for the authenticated caller (GET /v1/accounts).
export interface AccountInfo {
  account_id: string;
  email: string;
  status: string;
  tier: string;
}

export interface UsageResponse {
  today: { count: number; limit: number; day: string };
  history: Array<{ day: string; count: number }>;
  mailbox_count: number;
  mailbox_limit: number;
  pending_review_count: number;
  storage: StorageUsage;
  /** RL-UAT-030 — account tier (always sent by current servers). */
  tier: string;
  rates?: Record<string, number>;
  health?: Record<string, unknown>;
  trust?: Record<string, unknown>;
}

// Agent-accessible send-budget preflight (GET /v1/accounts/quota, RL-UAT-015/D6).
// `today.limit` is the EFFECTIVE (trust-derived) daily cap, not the raw tier cap.
// `scope` disambiguates the two []-mailbox cases: 'admin' with [] ⇒ ALL mailboxes;
// 'agent' with [] ⇒ a zero-bound agent key with NO send capability.
export interface AgentQuotaResponse {
  today: { count: number; limit: number; day: string };
  sends_remaining: number;
  reset_at: string;
  scope: 'admin' | 'agent';
  bound_mailbox_ids: string[];
  // Present ONLY while a new paid account is inside its shared-domain warm-up
  // window; absent for every other account/state. Verify your own sending
  // domain (BYOD) to lift the warm-up immediately.
  warmup?: AgentQuotaWarmup;
}

export interface AgentQuotaWarmup {
  until: string;
  shared_domain_daily_limit: number;
  velocity_gate_mode: 'log_only' | 'enforced';
  reason: string;
}

// === Malicious link scanning (URL reputation) ===
export interface LinkScanningStatus {
  active: boolean;
  accepted_version: string | null;
  current_version: string;
  privacy_ok: boolean;
}
export interface EnableLinkScanningResponse {
  url_reputation: LinkScanningStatus;
  disclosure: { notice: string; advisory_url: string };
}

// === Suppressions (do-not-contact list) ===

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual' | 'unsubscribe';

export interface SuppressionRow {
  email: string;
  reason: string;
  source: string;
  created_at: string;
  added_by_actor_type: string | null;
  added_by_actor_id: string | null;
  /** Sprint 039 — `email` or `@domain.com`. Optional for older servers. */
  pattern_type?: 'email' | 'domain';
  /**
   * Migration 051 — most recent complaint signal observed for this
   * recipient (worker provider event OR Mailgun-sync observation).
   * Null when no complaint signal has been recorded.
   * Optional for pre-051 servers.
   */
  latest_complaint_at?: string | null;
  /**
   * Migration 051 — count of distinct provider complaint events received
   * by the worker. Sync observations don't increment; a sync-only locked
   * row legitimately has count=0 while latest_complaint_at is set.
   * Optional for pre-051 servers.
   */
  complaint_count?: number;
}

export interface ListSuppressionsResponse {
  suppressions: SuppressionRow[];
  next_cursor: string | null;
}

export interface AddSuppressionResponse {
  email: string;
  reason: 'manual';
  source: 'customer';
  created_at: string | null;
  already_existed: boolean;
  added_by_actor_type: string | null;
  added_by_actor_id: string | null;
}

export interface DeleteSuppressionResponse {
  status: string;
  email: string;
  reason: string;
  source: string;
  created_at: string;
}

export interface ConflictingMailbox {
  id: string;
  name: string;
  full_address: string;
}

// === First-party simulator (plans/replylayer-simulator-mvp.md) ===
export interface InjectSimulatorInboundRequest {
  mailbox_id: string;
  scenario: 'clean' | 'prompt_injection_quarantined';
  label?: string;
}
export interface InjectSimulatorInboundResponse {
  status: 'available' | 'quarantined' | 'pending';
  message_id?: string;
}

// === Dashboard policy builder (plans/dashboard-policy-builder-mvp-2026-07-07.md §6.1) ===
// Local mirror types — this package carries no private-monorepo dependency at
// runtime (the cli-public-surface-check CI gate forbids the shared-package
// import token anywhere, including comments), so these shapes are hand-mirrored
// from the API wire contract rather than imported from the shared package.

export type PolicyMode = 'read_only' | 'draft_only' | 'supervised' | 'trusted' | 'custom';
export type DefaultPolicyMode = 'read_only' | 'draft_only' | 'supervised' | 'trusted';
export type AgentAuthoringMode = 'send_and_draft' | 'draft_only' | 'read_only';
export type MailboxHitlMode = 'disabled' | 'all_outbound' | 'risky_only';
export type ApprovalExpiry = '24h' | '72h' | '7d' | 'never';
export type PolicyAuthoringVerb = 'send' | 'reply' | 'draft_create' | 'draft_update' | 'draft_send';

export interface PolicySendWindow {
  timezone: string;
  days: string[];
  start: string;
  end: string;
  outside_action: 'require_approval' | 'block';
}

// Global rollout-lever state (env-driven, account-agnostic) for the two
// gates that can be stored but not yet live: `risky_only` (the Supervised
// human-review hold) and `send_window` (the send-window hold). `off` /
// `shadow` mean the stored posture is saved-but-inactive — a first-contact
// agent send is declined rather than held (risky_only), and an
// out-of-window agent send still goes out (send_window). Only `enforce`
// means the corresponding hold actually binds.
export interface PolicyEnforcement {
  risky_only: 'off' | 'shadow' | 'enforce';
  send_window: 'off' | 'shadow' | 'enforce';
}

export interface MailboxPolicyResponse {
  mailbox_id: string;
  policy_mode: PolicyMode;
  // Live lever state — see PolicyEnforcement. Account-agnostic (env-global)
  // but projected per-mailbox.
  enforcement: PolicyEnforcement;
  last_applied_policy_mode: string | null;
  agent_authoring_mode: AgentAuthoringMode;
  agent_send_policy: 'restricted' | 'open';
  restricted_by: 'mailbox_allowlist' | 'agent_containment' | null;
  hitl_mode: MailboxHitlMode;
  approval_expiry: ApprovalExpiry;
  send_window: PolicySendWindow | null;
  allow_thread_replies: boolean;
  recipient_policy_mode: 'blocklist' | 'allowlist';
  latest_revision_id: string | null;
  binding: {
    scope: 'admin' | 'agent';
    permitted_verbs: PolicyAuthoringVerb[];
  };
}

export interface AccountPolicyResponse {
  custom_daily_send_limit: number | null;
  default_policy_mode: DefaultPolicyMode | null;
  resolved_default_policy_mode: DefaultPolicyMode;
}

export interface PolicyPreviewResponse {
  mailbox_id: string;
  result: 'passes_all_checks_run' | 'would_hold' | 'would_block';
  result_summary: string;
  content_scan_run: boolean;
  email_effect: {
    effect_status: 'sent' | 'held_for_review' | 'held_infrastructure' | 'blocked';
    releasable: boolean;
    terminal: boolean;
    retryable: boolean;
  };
  trace: {
    gate: 'authoring' | 'recipient_authority' | 'send_window' | 'content_scan' | 'human_review' | 'send_budget';
    outcome: 'pass' | 'would_hold' | 'would_block' | 'not_run' | 'skipped';
    reason: string;
    details: Record<string, unknown>;
  }[];
  budget: { limit: number; remaining: number; warmup_applied: boolean };
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly conflictingMailbox?: ConflictingMailbox;
  public readonly conflicting_mailbox?: ConflictingMailbox;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    conflictingMailbox?: ConflictingMailbox,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.conflictingMailbox = conflictingMailbox;
    this.conflicting_mailbox = conflictingMailbox;
  }
}
