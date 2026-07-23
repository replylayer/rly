// Wire types for the ReplyLayer CLI, hand-curated; the public CLI does not depend on the private monorepo shared package.

// === Scan summary types ===

export type ScanVerdict = 'clean' | 'warning' | 'review_required' | 'blocked' | 'quarantined';

export type ScanCategory =
  | 'prompt_injection'
  | 'function_call_risk'
  | 'harmful_content'
  | 'liability_risk'
  | 'pii'
  | 'phishing_url'
  | 'image_exfil'
  | 'malware'
  | 'attachment_policy'
  | 'mime_mismatch'
  | 'attachment_type_mismatch'
  | 'spam'
  | 'language_policy'
  | 'recipient_policy'
  | 'secret_detected'
  | 'content_similarity'
  | 'delivery_warmup'
  | 'scan_incomplete';

export type ScanSubtype =
  | 'jailbreak'
  | 'instruction_injection'
  | 'toxicity'
  | 'violence'
  | 'sexual_content'
  | 'hate_speech'
  | 'harassment'
  | 'self_harm'
  | 'profanity'
  | 'secret_value'
  | 'outbound_confidentiality_leak';

export type ScanAttachmentPolicyAction =
  | 'quarantine_message'
  | 'metadata_only_after_rewrite'
  | 'derived_text_finding';

export type WebRiskThreatType =
  | 'MALWARE'
  | 'SOCIAL_ENGINEERING'
  | 'UNWANTED_SOFTWARE'
  | 'SOCIAL_ENGINEERING_EXTENDED_COVERAGE';

export interface WebRiskLearnMore {
  threat_type: WebRiskThreatType;
  url: string;
}

export interface WebRiskWarning {
  qualified_wording: string;
  attribution_text: string;
  attribution_url: string;
  learn_more: WebRiskLearnMore[];
  affected_urls: string[];
}

export interface ScanCategorySummary {
  category: ScanCategory;
  decision: PolicyDecision;
}

export interface ScanFinding {
  category: ScanCategory;
  decision: PolicyDecision;
  reason: string | null;
  warning?: WebRiskWarning;
  expires_at?: string;
  pii_type?: OutboundPiiType;
  subtype?: ScanSubtype;
  attachment_index?: number;
  /** Filename of the attachment this finding refers to; stamped at scan time
   *  so it reaches list/wait/send/draft surfaces that carry no attachments[]. */
  attachment_filename?: string;
  attachment_policy_action?: ScanAttachmentPolicyAction;
  failure_class?: 'inference_error' | 'model_judgment';
  agent_instructions?: string[];
}

export interface ScanSummary {
  verdict: ScanVerdict;
  categories: ScanCategorySummary[];
  findings: ScanFinding[];
}

// R5 — verified-sender verdict. High-confidence DOMAIN authenticity, NOT
// certainty; never relaxes the inbound-untrusted contract. Tolerant reader:
// treat an unknown value as unverified. null (the object) = not evaluated.
export type SenderAuthVerdict =
  | 'verified_aligned'
  | 'authenticated_unaligned'
  | 'failed'
  | 'none'
  | 'error';

/** Full verified-sender signal (detail). Domains nulled under pii_mode=redacted. */
export interface SenderAuthentication {
  verdict: SenderAuthVerdict;
  from_domain: string | null;
  signing_domain: string | null;
  provenance: 'managed' | 'self_hosted_imap';
}

/** Compact verified-sender signal (list/wait). */
export interface SenderAuthenticationCompact {
  verdict: SenderAuthVerdict;
}

/**
 * Trusted-instruction-sources — thin BASIS for a read-path relaxation (slice 6b).
 * Present on a read response's `agent_safety_context.instruction_trust` ONLY when
 * the server's fail-closed gate passed — gated purely by operator-side config
 * (mailbox instruction trust mode + per-key capability + a live trusted-source
 * grant) plus the message's authenticity/scan state. There is no client-side
 * opt-in; the CLI only reads and renders this basis.
 * The behavioural contract lives in `guidance`; this is programmatic metadata.
 * Declared locally (this package is shared-free).
 */
export interface InstructionTrustBasis {
  version: 'v1';
  match: 'address';
  /** PSL org-domain of the verified sender; null under pii_mode=redacted. */
  verified_domain: string | null;
  verdict: 'verified_aligned';
  provenance: 'managed';
}

/**
 * Standing behavioural-safety contract for an inbound message. Present on every
 * inbound read (even clean), null for outbound. `guidance` is the baseline
 * "treat as untrusted data" text, REPLACED by a trusted-instruction guidance when
 * `instruction_trust` is attached.
 */
export interface AgentSafetyContext {
  untrusted_content: boolean;
  guidance: string;
  instruction_trust?: InstructionTrustBasis | null;
}

// === Core enums ===

export type PolicyDecision =
  | 'allow'
  | 'allow_with_warning'
  | 'quarantine'
  | 'require_human_approval'
  | 'block';

export type MailboxStatus = 'active' | 'paused' | 'deleted';

export type PiiMode = 'passthrough' | 'redacted';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageState =
  | 'draft'
  | 'received'
  | 'scanning'
  | 'available'
  | 'quarantined'
  | 'pending_review'
  | 'blocked'
  | 'delivered'
  | 'bounced'
  | 'deleted'
  | 'firewall_blocked'
  | 'dispatching';

export type AttachmentPolicyAction = 'deliver' | 'metadata_only' | 'quarantine' | 'block';
export type AvVerdict = 'clean' | 'infected' | 'error' | 'skipped';
export type AttachmentExposureMode = 'metadata_only' | 'derived_content' | 'raw_download_selected_types';
export type AttachmentAllowedFileFamily = 'pdf' | 'text' | 'csv' | 'image' | '*';
export type AttachmentDerivativeStatus = 'pending' | 'ready' | 'blocked' | 'failed';
export type AttachmentPreviewKind = 'text';
export type AttachmentRawRetentionStatus =
  | 'not_retained'
  | 'temporary_processing'
  | 'retained_for_raw_download';

export type TransportMode = 'mailgun' | 'ses' | 'self_hosted';

export type SelfHostedSecurity = 'starttls' | 'tls';
export type SelfHostedNetworkMode = 'public' | 'tailnet';

export type SubaddressMode = 'reply_to' | 'from' | 'none';

export type RecipientPolicyMode = 'blocklist' | 'allowlist';
export type SenderPolicyMode = 'blocklist' | 'allowlist';

// Single "agent sends" control — a derived view over the recipient-policy mode
// and the agent-send-containment flag (no separate stored field).
export type AgentSendPolicy = 'restricted' | 'open';
export type AgentSendRestrictedBy = 'mailbox_allowlist' | 'agent_containment' | null;

export type RecipientStatus = 'pending' | 'confirmed' | 'expired';

export type OutboundPiiType = 'ssn' | 'credit_card' | 'phone_number';
export type OutboundPiiAction = 'allow' | 'allow_with_warning' | 'review' | 'quarantine' | 'block';
export type OutboundPiiPolicy = Partial<Record<OutboundPiiType, OutboundPiiAction>>;
export type OutboundReviewApprovalNotePolicy = 'optional' | 'required_for_sensitive_pii';

// === Self-hosted transport config ===

export interface SelfHostedEndpointConfig {
  host: string;
  port: number;
  security: SelfHostedSecurity;
  username: string;
  password: string;
}

export interface SelfHostedConfig {
  smtp: SelfHostedEndpointConfig;
  imap: SelfHostedEndpointConfig;
  network_mode: SelfHostedNetworkMode;
}

// === Firewall ===

export interface FirewallBlock {
  envelope_sender: string | null;
  from_address: string | null;
  matched_field: 'envelope' | 'from' | null;
  matched_pattern: string | null;
  reason_code: 'SENDER_BLOCKED' | 'SENDER_NOT_ON_ALLOWLIST';
  matched_list: 'account_blocklist' | 'mailbox_allowlist' | null;
  mode: SenderPolicyMode;
}

// === Scanner policy ===

export interface OutboundReviewPolicy {
  approval_note?: OutboundReviewApprovalNotePolicy;
}

export interface ScannerPolicy {
  language_mode?: 'english_only' | 'allow_all_languages' | 'disabled';
  disabled_scanners?: string[];
  disabled_proxy_criteria?: string[];
  outbound_pii_policy?: OutboundPiiPolicy;
  outbound_review_policy?: OutboundReviewPolicy;
}

// === Message body & attachments ===

export interface MessageBody {
  format: 'text' | 'html';
  content: string | null;
  char_count: number;
  returned_char_count: number;
  truncated: boolean;
}

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
  hash: string;
  policy_action: AttachmentPolicyAction;
  sniffed_mime_type?: string;
  declared_mime_type?: string;
  mime_mismatch?: boolean;
  av_verdict?: AvVerdict;
  av_signature?: string;
  av_scanned_at?: string;
  r2_key?: string;
  stored?: boolean;
  content_id?: string;
  content_disposition?: 'inline' | 'attachment' | string;
  inline?: boolean;
  raw_retention?: AttachmentRawRetentionStatus;
  raw_deleted_at?: string;
  raw_retention_reason?: string;
  content_scan_cleared_at?: string;
  upload_id?: string;
}

export interface AttachmentPreviewSummary {
  preview_status: AttachmentDerivativeStatus | null;
  preview_kind: AttachmentPreviewKind | null;
  preview_reason_code: string | null;
  preview_char_count: number | null;
  preview_page_count: number | null;
  preview_truncated: boolean | null;
  preview_generated_at: string | null;
}

export interface MessageAttachment extends AttachmentMeta, AttachmentPreviewSummary {}

// === Mailbox list ===

export interface MailboxListEntry {
  id: string;
  name: string;
  address: string;
  status: MailboxStatus;
  scanner_policy: ScannerPolicy | null;
  pii_mode: PiiMode;
  // Recipient-visible From display name (nullable — falls back to `name`). Set
  // via `mailbox create --display-name` / `mailbox update --display-name`.
  // Optional here to tolerate older servers that predate the field.
  display_name?: string | null;
  // Server-computed "what recipients see" (display_name ?? name, plus the
  // sandbox-only " via ReplyLayer" suffix). Read-only.
  effective_from_display?: string;
  // Attachment / outbound-attachment CONSENT bookkeeping is session-only: the
  // API strips it from Bearer/API-key responses (projectMailboxForCaller), so
  // an agent-key `rly mailbox list --json` never carries it. Optional to match
  // the shared wire type. An agent reads `attachment_exposure_mode` instead.
  attachment_access_enabled?: boolean;
  attachment_access_accepted_at?: string | null;
  attachment_access_accepted_version?: string | null;
  attachment_exposure_mode: AttachmentExposureMode;
  attachment_allowed_file_families: AttachmentAllowedFileFamily[];
  attachment_reauth_at?: string | null;
  attachment_policy_version?: string | null;
  image_raw_download_confirmed?: boolean;
  current_image_risk_version?: string;
  attachment_image_access_accepted_at?: string | null;
  attachment_image_access_accepted_version?: string | null;
  current_disclaimer_version?: string;
  legacy_wildcard_active?: boolean;
  default_subaddress_mode: SubaddressMode;
  recipient_policy_mode: RecipientPolicyMode;
  sender_policy_mode: SenderPolicyMode;
  hitl_mode: 'disabled' | 'all_outbound';
  allow_thread_replies?: boolean;
  // Single "agent sends" control — derived from the two fields above.
  agent_send_policy?: AgentSendPolicy;
  restricted_by?: AgentSendRestrictedBy;
  created_at: string;
}

// === Provider health ===

export interface ProviderHealth {
  healthy: boolean;
  configured?: boolean;
  events_configured?: boolean;
}

// === Message summaries ===

export interface MessageSummary {
  id: string;
  direction: MessageDirection;
  state: MessageState;
  sender: string;
  recipient: string;
  subject: string;
  /** Owning mailbox name (mailboxes.name), so an agent isn't staring at a bare UUID. */
  mailbox_name?: string | null;
  scan: ScanSummary | null;
  /** R5 — compact verified-sender signal; null = not evaluated. */
  sender_authentication?: SenderAuthenticationCompact | null;
  /** Slice 6b — standing untrusted-content contract + any trusted-instruction
   *  relaxation; present on inbound, null for outbound. Surfaced verbatim via
   *  --json (the human list/wait path stays compact). */
  agent_safety_context?: AgentSafetyContext | null;
  subaddress_instance_id: string | null;
  firewall_block: FirewallBlock | null;
  thread_id: string | null;
  created_at: string;
  read_at: string | null;
  body_preview: string | null;
  starred: boolean;
  /** INB-03 — true iff the message has ≥1 attachment (list + wait surfaces). */
  has_attachment: boolean;
  dashboard_url: string | null;
}

export interface DraftSummary {
  id: string;
  mailbox_id: string;
  /** Owning mailbox name (mailboxes.name). */
  mailbox_name?: string | null;
  state: 'draft';
  sender: string;
  recipient: string;
  subject: string;
  worst_decision: PolicyDecision;
  subaddress_instance_id: string | null;
  send_at?: string | null;
  original_send_at?: string | null;
  send_attempts?: number;
  last_dispatch_error_code?: string | null;
  last_dispatch_attempt_at?: string | null;
  created_at: string;
  updated_at: string;
}

// === API request/response types ===

export interface SignupResponse {
  account_id: string;
  api_key: string;
  verification_required?: boolean;
  email_verification_required?: boolean;
  phone_verification_required?: boolean;
  sms_delivery_status?: 'sent' | 'pending' | 'not_required';
  phone_number_masked?: string | null;
  message?: string;
}

export interface RotateKeyResponse {
  api_key: string;
}

export interface CreateDomainRequest {
  domain: string;
  transport_mode?: TransportMode;
  self_hosted_config?: SelfHostedConfig;
}

export interface CreateMailboxRequest {
  name: string;
  self_hosted_imap_folder?: string;
  // Optional recipient-visible From display name. Omitted → the From line falls
  // back to `name`. The server validates it (422 DISPLAY_NAME_INVALID).
  display_name?: string;
}

export interface CreateMailboxResponse {
  id: string;
  name: string;
  address: string;
  recipient_policy_mode?: RecipientPolicyMode;
  sender_policy_mode?: SenderPolicyMode;
  allow_thread_replies?: boolean;
  // Single "agent sends" control — derived from the two fields above.
  agent_send_policy?: AgentSendPolicy;
  restricted_by?: AgentSendRestrictedBy;
  // Recipient-visible From display name (nullable) + the server-computed
  // "what recipients see" string. Optional to tolerate older servers.
  display_name?: string | null;
  effective_from_display?: string;
}

export interface ListMailboxesResponse {
  mailboxes: MailboxListEntry[];
}

export interface SendMessageRequest {
  from_mailbox?: string;
  to?: string;
  subject?: string;
  body: string;
  html?: string;
  thread_id?: string;
  subaddress_instance_id?: string;
  subaddress_mode?: SubaddressMode;
  attachment_ids?: string[];
}

export type ReviewQueueTriggerSource = 'mailbox_policy' | 'scanner' | 'both';

export interface HoldContext {
  trigger_source: ReviewQueueTriggerSource;
  summary_reasons: string[];
}

/**
 * Governed Email-Effect Contract v1 (Track 2) — the four top-level outcome
 * discriminators. OPEN enum (additive per the contract). Mirrors the shared
 * effect constant; kept here because the CLI tree is shared-free.
 */
export type EffectStatus =
  | 'sent'
  | 'held_for_review'
  | 'held_infrastructure'
  | 'blocked';

/**
 * The OUTBOUND-only governed effect view. Composed server-side from the message
 * row's status + scan + dispatch context; OMITTED entirely when there is no
 * determinate send-effect yet (a plain draft or a pre-dispatch transient), so
 * it is optional here.
 */
export interface EmailEffect {
  effect_status: EffectStatus;
  /** true iff a human can release it (quarantine / pending_review). */
  releasable: boolean;
  /** true iff no further state change is expected (blocked / delivered / bounced). */
  terminal: boolean;
  /** true iff an infrastructure hold OR an idempotency-safe indeterminate dispatch. */
  retryable: boolean;
}

export interface SendMessageResponse {
  message_id: string;
  status: 'sent' | 'quarantined' | 'blocked' | 'pending_review';
  warning?: string | null;
  scan: ScanSummary | null;
  hold_context: HoldContext | null;
  daily_limit: number;
  sends_remaining: number;
  // Governed Email-Effect Contract v1 (Track 2) — additive + optional. Present
  // on send/reply 200s (and on the idempotent replay serve path); also carried
  // in the strict 4xx/5xx error `details`. Omitted on rows with no determinate
  // send-effect.
  email_effect?: EmailEffect | null;
  // Outbound HTML sanitization (Phase 2, D3). Additive + optional: the
  // POST /v1/messages/send and /reply 200s carry these; the draft-send 200
  // omits them. html_sanitized = the outbound HTML was run through the
  // delivery sanitizer; removed_categories = coarse passive-construct classes
  // (remote_image, external_link, filtered_styles, unsupported_elements)
  // stripped from the wire copy.
  html_sanitized?: boolean;
  removed_categories?: string[];
}

export interface ListMessagesResponse {
  messages: MessageSummary[];
}

export interface GetMessageResponse {
  id: string;
  mailbox_id: string;
  /** Owning mailbox name (mailboxes.name). */
  mailbox_name?: string | null;
  direction: MessageDirection;
  state: MessageState;
  sender: string;
  recipient: string;
  subject: string;
  body: MessageBody;
  attachments: MessageAttachment[];
  scan: ScanSummary | null;
  /** R5 — full verified-sender signal; domains nulled under pii_mode=redacted; null = not evaluated. */
  sender_authentication?: SenderAuthentication | null;
  /** Slice 6b — standing untrusted-content contract + any trusted-instruction
   *  relaxation; present on inbound reads, null for outbound. */
  agent_safety_context?: AgentSafetyContext | null;
  thread_id: string | null;
  in_reply_to: string | null;
  subaddress_instance_id: string | null;
  firewall_block: FirewallBlock | null;
  read_at: string | null;
  starred: boolean;
  dashboard_url: string | null;
  /**
   * PR 7 (migration 061) — which surface routed this row into pending_review.
   * NULL on non-pending_review / legacy rows. Already on the wire.
   */
  review_trigger_source?: ReviewQueueTriggerSource | null;
  /**
   * SEC-05 — policy/HITL hold reason, mirrored from the send response for read
   * parity. Non-null on held rows (typed policy causes, policy-changed
   * decisions, and genuine scan-explained holds alike — carries
   * agent_instructions); null on sent/terminal rows and normally on
   * infrastructure holds.
   */
  hold_context?: HoldContext | null;
  created_at: string;
}

export interface ReplyRequest {
  body: string;
  html?: string;
  subaddress_instance_id?: string;
  subaddress_mode?: SubaddressMode;
  attachment_ids?: string[];
}

export interface WaitResponse {
  message: MessageSummary | null;
}

export interface AddRecipientRequest {
  email: string;
}

export interface ListRecipientsResponse {
  recipients: Array<{
    id: string;
    email: string;
    status: RecipientStatus;
    created_at: string;
    confirmed_at: string | null;
  }>;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  database: boolean;
  providers: {
    primary: ProviderHealth;
    failover: ProviderHealth;
  };
  scanner: boolean;
  spam_filter: boolean;
  queue_depth: number;
  timestamp: string;
  capabilities?: string[];
}

// === Drafts API ===

export interface CreateDraftRequest {
  mailbox_id?: string;
  to?: string;
  subject?: string;
  body: string;
  html?: string;
  thread_id?: string;
  subaddress_instance_id?: string;
  subaddress_mode?: SubaddressMode;
  in_reply_to_message_id?: string;
  send_at?: string;
  attachment_ids?: string[];
}

export interface UpdateDraftRequest {
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  subaddress_instance_id?: string | null;
  subaddress_mode?: SubaddressMode | null;
  send_at?: string | null;
  attachment_ids?: string[] | null;
}

/** ATO-15 — curated read-only view of a draft's referenced outbound attachments. */
export interface DraftAttachment {
  filename: string;
  content_type: string;
  size: number;
  upload_id?: string | null;
  policy_action?: string;
}

export interface DraftResponse {
  id: string;
  mailbox_id: string;
  /** Owning mailbox name (mailboxes.name). */
  mailbox_name?: string | null;
  state: 'draft' | 'available' | 'deleted';
  sender: string;
  recipient: string;
  subject: string;
  body: MessageBody;
  scan: ScanSummary;
  worst_decision: PolicyDecision;
  thread_id: string | null;
  in_reply_to: string | null;
  subaddress_instance_id: string | null;
  subaddress_mode: SubaddressMode | null;
  send_at?: string | null;
  original_send_at?: string | null;
  send_attempts?: number;
  last_dispatch_error_code?: string | null;
  last_dispatch_attempt_at?: string | null;
  attachments?: DraftAttachment[];
  created_at: string;
  updated_at: string;
}

export interface ListDraftsResponse {
  drafts: DraftSummary[];
}
