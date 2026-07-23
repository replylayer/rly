import type {
  SignupResponse,
  RotateKeyResponse,
  CreateDomainRequest,
  CreateMailboxRequest,
  CreateMailboxResponse,
  ListMailboxesResponse,
  SendMessageRequest,
  SendMessageResponse,
  ListMessagesResponse,
  GetMessageResponse,
  ReplyRequest,
  WaitResponse,
  AddRecipientRequest,
  ListRecipientsResponse,
  HealthResponse,
  CreateDraftRequest,
  UpdateDraftRequest,
  DraftResponse,
  ListDraftsResponse,
} from './protocol.js';

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { ApiError, type ConflictingMailbox, type IdempotencyProbeResult } from './types.js';
import type { AccountInfo, AddRecipientResponse, DeleteMailboxResponse, UpdateMailboxResponse, AttachmentAccessResponse, AttachmentPreviewResponse, AttachmentDownloadUrlResponse, BulkAddResponse, ScannerPolicy, CreateApiKeyResponse, ListApiKeysResponse, UpdateApiKeyResponse, RevokeApiKeyResponse, UsageResponse, AgentQuotaResponse, ListSuppressionsResponse, AddSuppressionResponse, DeleteSuppressionResponse, ListThreadsResponse, GetThreadResponse, MessageStarResponse, ThreadStarResponse, CreateWebhookResponse, WebhookSummary, ListWebhooksResponse, RotateWebhookSecretResponse, ListWebhookDeliveriesResponse, UploadAttachmentResponse, LinkScanningStatus, EnableLinkScanningResponse, InjectSimulatorInboundRequest, InjectSimulatorInboundResponse, MailboxPolicyResponse, AccountPolicyResponse, PolicyPreviewResponse } from './types.js';

interface DomainRecord {
  id: string;
  domain_name: string;
  domain_type: string;
  transport_mode: string;
  is_default: boolean;
  verification_status: string;
  dns_records_json?: Array<Record<string, unknown>> | null;
  admin_review_status?: string | null;
  created_at?: string;
  verified_at?: string | null;
  [key: string]: unknown;
}

interface CreateDomainResponse extends DomainRecord {
  domain_id?: string;
  claim_token?: string | null;
  message: string;
}

function isConflictingMailbox(value: unknown): value is ConflictingMailbox {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { name?: unknown }).name === 'string'
    && typeof (value as { full_address?: unknown }).full_address === 'string';
}

interface ListDomainsResponse {
  domains: DomainRecord[];
}

interface VerifyDomainResponse {
  verification_status: string;
  dns_records_json?: Array<Record<string, unknown>> | null;
  probe_results?: Array<Record<string, unknown>>;
  failed_gate?: string | null;
  failure_reason?: string | null;
  message: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Build the per-request header bundle shared by `send` + `reply`:
 *   - `Idempotency-Key` (Track 1, migration 093) when an idempotency key is set
 *   - `Prefer: outcome=strict` (Track 2, RFC 7240) when strictOutcome is set
 * Returns `undefined` when neither applies, keeping the no-opts call shape
 * byte-identical (no empty headers object threaded through).
 */
function buildSendHeaders(opts?: {
  idempotencyKey?: string;
  strictOutcome?: boolean;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts?.strictOutcome) headers['Prefer'] = 'outcome=strict';
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

export class ApiClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(options: ApiClientOptions) {
    // Remove trailing slash(es) without a regex (avoids polynomial ReDoS).
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.apiKey = options.apiKey;
  }

  private headers(auth: boolean = true, hasBody: boolean = true): Record<string, string> {
    const h: Record<string, string> = {};
    // Only advertise a JSON content-type when we're actually shipping one.
    // Fastify's JSON body parser rejects requests with Content-Type:
    // application/json + empty body via FST_ERR_CTP_EMPTY_JSON_BODY, which
    // bit body-less DELETEs (suppressions remove, mailbox delete, etc.).
    if (hasBody) {
      h['Content-Type'] = 'application/json';
    }
    if (auth && this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      auth?: boolean;
      query?: Record<string, string>;
      signal?: AbortSignal;
      /**
       * Migration 040 — per-request headers (Idempotency-Key is the only
       * caller today). Merged AFTER the default Content-Type / Authorization
       * headers so those cannot be overridden from this channel.
       */
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const { body, auth = true, query, signal, headers: extraHeaders } = options;

    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') {
          params.set(k, v);
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const mergedHeaders = this.headers(auth, body !== undefined);
    if (extraHeaders) {
      const PROTECTED = new Set(['authorization', 'content-type']);
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (PROTECTED.has(k.toLowerCase())) continue;
        mergedHeaders[k] = v;
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: mergedHeaders,
      signal,
    };
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    // First attempt
    let response = await this.doFetch(url, fetchOptions);

    // One retry on 5xx — but ONLY for non-mutating methods. Retrying a mutating
    // POST/PATCH/PUT/DELETE after a 5xx risks a DOUBLE-SEND (notably the Track 2
    // strict `held_infrastructure` → 503 path, and any keyless send/reply) or a
    // lost-mutation that retries into a confusing 404. Mirrors the TS SDK policy
    // (its http client never auto-retries a mutating 5xx for exactly this reason).
    const isMutating =
      method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    if (response.status >= 500 && !isMutating) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      response = await this.doFetch(url, fetchOptions);
    }

    if (!response.ok) {
      await this.handleError(response);
    }

    // For 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        response.status,
        'PARSE_ERROR',
        `Failed to parse response: ${text.substring(0, 200)}`,
      );
    }
  }

  private async doFetch(url: string, options: RequestInit): Promise<Response> {
    try {
      return await fetch(url, options);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', `Network error: ${message}`);
    }
  }

  private async handleError(response: Response): Promise<never> {
    let errorBody: {
      error?: string;
      code?: string;
      details?: Record<string, unknown>;
      conflicting_mailbox?: unknown;
    } = {};
    try {
      const text = await response.text();
      if (text) {
        errorBody = JSON.parse(text);
      }
    } catch {
      // Non-JSON error response
    }

    throw new ApiError(
      response.status,
      // U2 (S2): coerce `code` to a string before storing it. `errorBody.code`
      // is declared `string` but JSON.parse assigns whatever the wire carried;
      // an edge gateway (e.g. Railway's proxy on a long-poll 502) can put a
      // NUMERIC `code` on the body, which then surfaced as a number at runtime
      // despite the `code: string` declaration — surprising any agent that does
      // `typeof err.code === 'string'`. `!= null` preserves a legitimate `0`
      // (→ `'0'`) instead of swallowing it into the HTTP fallback.
      (errorBody.code != null ? String(errorBody.code) : null) || `HTTP_${response.status}`,
      errorBody.error || `Request failed with status ${response.status}`,
      errorBody.details,
      isConflictingMailbox(errorBody.conflicting_mailbox)
        ? errorBody.conflicting_mailbox
        : undefined,
    );
  }

  // === Account endpoints ===

  async signup(
    email: string,
    phoneNumber: string,
    inviteCode?: string,
    acceptWebRiskVersion?: string,
    cliSignupCode?: string,
  ): Promise<SignupResponse> {
    const body: Record<string, unknown> = {
      email,
      phone_number: phoneNumber,
      accept_terms: true,
    };
    if (inviteCode) body.invite_code = inviteCode;
    if (cliSignupCode) body.cli_signup_code = cliSignupCode;
    // Per-signup URL-reputation acknowledgement. Supplied only when the
    // user passed --accept-web-risk on the `signup` command (an explicit
    // acknowledgement of that exact disclaimer version). Absent → the
    // server enables URL reputation by default under the signup
    // disclosure (Privacy §7a) and records the provenance accordingly.
    if (acceptWebRiskVersion) {
      body.accept_web_risk_version = acceptWebRiskVersion;
    }
    return this.request<SignupResponse>('POST', '/v1/accounts/signup', {
      body,
      auth: false,
    });
  }

  async getAccount(): Promise<AccountInfo> {
    return this.request<AccountInfo>('GET', '/v1/accounts');
  }

  async deleteAccount(confirmEmail: string): Promise<{ status: string; message: string }> {
    // `DELETE /v1/accounts` requires `confirm_email` (this account's own
    // email) as an intent gate on EVERY auth path, Bearer included — a
    // stray API-key-only delete no longer succeeds; the request has to name
    // the account. The CLI fetches the email via GET /v1/accounts and echoes
    // it here (it isn't persisted in the local credential file). The route
    // still short-circuits the session step-up factor for Bearer callers.
    // The non-empty body also keeps the Fastify body-schema gate satisfied.
    // See docs/briefings/cli-account-delete-confirm-bug-2026-05-26.md.
    return this.request<{ status: string; message: string }>('DELETE', '/v1/accounts', {
      body: { confirm_email: confirmEmail },
    });
  }

  async getUsage(): Promise<UsageResponse> {
    return this.request<UsageResponse>('GET', '/v1/accounts/usage');
  }

  /** G9 — GDPR Art. 20 portability export. Returns the full account-data object. */
  async exportAccount(): Promise<Record<string, unknown>> {
    return this.request('GET', '/v1/accounts/export');
  }

  async getQuota(): Promise<AgentQuotaResponse> {
    return this.request<AgentQuotaResponse>('GET', '/v1/accounts/quota');
  }

  async getLinkScanningStatus(): Promise<LinkScanningStatus> {
    const me = await this.request<{ url_reputation?: LinkScanningStatus }>('GET', '/v1/auth/me');
    if (!me.url_reputation) {
      throw new ApiError(0, 'LINK_SCANNING_UNSUPPORTED', 'Server did not return link-scanning status; the API may be outdated.');
    }
    return me.url_reputation;
  }

  async enableLinkScanning(acceptVersion: string): Promise<EnableLinkScanningResponse> {
    return this.request<EnableLinkScanningResponse>('POST', '/v1/accounts/url-reputation', {
      body: { accept_web_risk_version: acceptVersion },
    });
  }

  async rotateKey(): Promise<RotateKeyResponse> {
    return this.request<RotateKeyResponse>(
      'POST',
      '/v1/accounts/api-keys/rotate',
    );
  }

  // === Mailbox endpoints ===

  async createMailbox(
    name: string,
    selfHostedImapFolder?: string,
    displayName?: string,
  ): Promise<CreateMailboxResponse> {
    const body: CreateMailboxRequest = { name };
    if (selfHostedImapFolder) {
      body.self_hosted_imap_folder = selfHostedImapFolder;
    }
    // Only send display_name when the caller supplied it — an omitted field
    // leaves the From line falling back to `name`.
    if (displayName !== undefined) {
      body.display_name = displayName;
    }
    return this.request<CreateMailboxResponse>('POST', '/v1/mailboxes', {
      body,
    });
  }

  async listMailboxes(): Promise<ListMailboxesResponse> {
    return this.request<ListMailboxesResponse>('GET', '/v1/mailboxes');
  }

  async getMailbox(id: string): Promise<UpdateMailboxResponse> {
    return this.request<UpdateMailboxResponse>('GET', `/v1/mailboxes/${id}`);
  }

  async deleteMailbox(id: string): Promise<DeleteMailboxResponse> {
    return this.request<DeleteMailboxResponse>('DELETE', `/v1/mailboxes/${id}`);
  }

  async updateMailbox(
    id: string,
    body: {
      // A literal `null` is the "reset to platform defaults" signal (UAT-02);
      // the server (PR-C) treats `scanner_policy: null` as a full reset that
      // nulls the column past its COALESCE guard. An object patch merges; an
      // omitted field leaves the policy unchanged.
      scanner_policy?: ScannerPolicy | null;
      // Recipient-visible From display name. Presence-aware on the server: an
      // omitted key is a no-op, an explicit `null` clears it (From falls back to
      // `name`), a string sets it (server-validated, 422 DISPLAY_NAME_INVALID).
      display_name?: string | null;
      // Migration 036.
      recipient_policy_mode?: 'blocklist' | 'allowlist';
      force_empty?: boolean;
      // Migration 085 — thread-scoped reply bypass toggle.
      allow_thread_replies?: boolean;
      // Single "agent sends" convenience control. Mutually exclusive with raw
      // recipient_policy_mode/agent_send_containment in the same PATCH (400).
      agent_send_policy?: 'restricted' | 'open';
      confirm_open_human_sends?: boolean;
      // G1/G2/G4/G3 — per-mailbox policy fields. No server change: PATCH
      // /v1/mailboxes/:id already accepts them under requireAdmin.
      hitl_mode?: 'disabled' | 'all_outbound' | 'risky_only';
      pii_mode?: 'passthrough' | 'redacted';
      default_subaddress_mode?: 'reply_to' | 'from' | 'none';
      pii_redaction_config?: Record<string, unknown> | null;
      // Policy builder (migration 119). apply_policy_mode expands into the three
      // identity fields server-side; agent_authoring_mode / send_window /
      // approval_expiry are direct fields. All direction-gated (§3.5) — a
      // loosening PATCH from a bearer key returns 403 REAUTH_REQUIRES_SESSION.
      apply_policy_mode?: 'read_only' | 'draft_only' | 'supervised' | 'trusted';
      agent_authoring_mode?: 'send_and_draft' | 'draft_only' | 'read_only';
      send_window?: {
        timezone: string;
        days: string[];
        start: string;
        end: string;
        outside_action: 'require_approval' | 'block';
      } | null;
      approval_expiry?: '24h' | '72h' | '7d' | 'never';
    },
  ): Promise<UpdateMailboxResponse> {
    return this.request<UpdateMailboxResponse>('PATCH', `/v1/mailboxes/${id}`, { body });
  }

  // === Policy builder (plans/dashboard-policy-builder-mvp §6.1) ===

  /** GET /v1/mailboxes/:id/policy — the read model + what binds THIS key. Agent keys allowed. */
  async getMailboxPolicy(id: string): Promise<MailboxPolicyResponse> {
    return this.request<MailboxPolicyResponse>('GET', `/v1/mailboxes/${id}/policy`);
  }

  /** GET /v1/account/policy — account daily cap + default mode (admin/session). */
  async getAccountPolicy(): Promise<AccountPolicyResponse> {
    return this.request<AccountPolicyResponse>('GET', '/v1/account/policy');
  }

  /**
   * PATCH /v1/account/policy — set/clear the account daily cap or default mode.
   * Loosening (raise/clear the cap, looser default) → 403 REAUTH_REQUIRES_SESSION
   * on a bearer key (dashboard-only).
   */
  async updateAccountPolicy(body: {
    custom_daily_send_limit?: number | null;
    default_policy_mode?: 'read_only' | 'draft_only' | 'supervised' | 'trusted' | null;
  }): Promise<AccountPolicyResponse> {
    return this.request<AccountPolicyResponse>('PATCH', '/v1/account/policy', { body });
  }

  /** POST /v1/mailboxes/:id/policy/preview — side-effect-free dry-run (session/admin only). */
  async previewMailboxPolicy(
    id: string,
    body: { to: string; subject?: string; body?: string; at_time?: string; run_content_scan?: boolean },
  ): Promise<PolicyPreviewResponse> {
    return this.request<PolicyPreviewResponse>('POST', `/v1/mailboxes/${id}/policy/preview`, { body });
  }

  /**
   * G5 / S1-SAFE — set the per-mailbox attachment exposure policy.
   * POST /v1/mailboxes/:id/attachment-access (requireAdmin). The CLI never
   * sends `raw_download_selected_types` for ENABLE/WIDEN (REAUTH_REQUIRES_SESSION,
   * dashboard-only); `narrow` passes it only for a family-subset write, which
   * the server admits for Bearer keys.
   */
  async setAttachmentAccess(
    id: string,
    body: {
      mode?: 'metadata_only' | 'derived_content' | 'raw_download_selected_types';
      allowed_file_families?: string[];
      accept_disclaimer_version?: string;
      enable?: boolean;
    },
  ): Promise<AttachmentAccessResponse> {
    return this.request<AttachmentAccessResponse>('POST', `/v1/mailboxes/${id}/attachment-access`, { body });
  }

  // === Domain endpoints ===

  async createDomain(body: CreateDomainRequest): Promise<CreateDomainResponse> {
    return this.request<CreateDomainResponse>('POST', '/v1/domains', { body });
  }

  async listDomains(): Promise<ListDomainsResponse> {
    return this.request<ListDomainsResponse>('GET', '/v1/domains');
  }

  async getDomain(id: string): Promise<DomainRecord> {
    return this.request<DomainRecord>('GET', `/v1/domains/${id}`);
  }

  async verifyDomain(id: string): Promise<VerifyDomainResponse> {
    return this.request<VerifyDomainResponse>('POST', `/v1/domains/${id}/verify`);
  }

  // G10 — domain lifecycle mutations (self-hosted config + default + recheck + delete).
  async setSelfHostedConfig(
    id: string,
    body: { smtp?: Record<string, unknown>; imap?: Record<string, unknown>; network_mode?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/domains/${id}/self-hosted-config`, { body });
  }

  async setDefaultDomain(id: string): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/domains/${id}/set-default`, { body: {} });
  }

  async recheckDomain(id: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/domains/${id}/self-hosted-recheck`, { body: {} });
  }

  async deleteDomain(id: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/v1/domains/${id}`);
  }

  // === Migration 036 — per-mailbox recipient allowlist ===

  async listAllowlist(
    mailboxId: string,
    options?: { limit?: number; cursor?: string; all?: boolean },
  ): Promise<{
    allowlist: Array<{
      email: string;
      mailbox_id: string;
      created_at: string;
      added_by_actor_type: string | null;
      added_by_actor_id: string | null;
    }>;
    next_cursor: string | null;
  }> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    return this.request('GET', `/v1/mailboxes/${mailboxId}/allowlist`, { query });
  }

  async addAllowlist(
    mailboxId: string,
    email: string,
  ): Promise<{
    email: string;
    mailbox_id: string;
    created_at: string | null;
    already_existed: boolean;
    added_by_actor_type: string | null;
    added_by_actor_id: string | null;
  }> {
    return this.request('POST', `/v1/mailboxes/${mailboxId}/allowlist`, { body: { email } });
  }

  /**
   * Add up to 1000 outbound-allowlist entries in one request. Returns
   * partial-success buckets (added / already_existed / invalid + counts).
   * POST /v1/mailboxes/:id/allowlist/bulk (FIND-007, WS4).
   */
  async addAllowlistBulk(mailboxId: string, emails: string[]): Promise<BulkAddResponse> {
    return this.request<BulkAddResponse>(
      'POST',
      `/v1/mailboxes/${mailboxId}/allowlist/bulk`,
      { body: { emails } },
    );
  }

  async deleteAllowlist(
    mailboxId: string,
    email: string,
    options?: { forceEmpty?: boolean },
  ): Promise<{ status: string; email: string; mailbox_id: string; created_at?: string }> {
    const query: Record<string, string> = {};
    if (options?.forceEmpty) query.force_empty = 'true';
    return this.request(
      'DELETE',
      `/v1/mailboxes/${mailboxId}/allowlist/${encodeURIComponent(email)}`,
      { query },
    );
  }

  // Migration 038 — blocked-attempts log.
  async listBlockedAttempts(
    mailboxId: string,
    options?: {
      limit?: number;
      cursor?: string;
      all?: boolean;
      aggregate?: boolean;
      withinDays?: number;
    },
  ): Promise<{
    attempts: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    if (options?.aggregate === false) query.aggregate = 'false';
    if (options?.withinDays !== undefined) query.within_days = String(options.withinDays);
    return this.request(
      'GET',
      `/v1/mailboxes/${mailboxId}/allowlist/blocked-attempts`,
      { query },
    );
  }

  // === Message endpoints ===

  async send(
    req: SendMessageRequest,
    opts?: { idempotencyKey?: string; strictOutcome?: boolean },
  ): Promise<SendMessageResponse> {
    // Track 1 (migration 093) — Idempotency-Key forwarded as an HTTP header so a
    // network-retried same-key send produces at most one message + one charge.
    // The key is an arbitrary client string (may contain '/', '?', '#', space)
    // → header, never path-interpolated.
    // Track 2 — `strictOutcome` forwards `Prefer: outcome=strict` (RFC 7240) so
    // the server maps a non-delivered terminal/held outcome to a non-2xx
    // carrying email_effect in the error details (default: 200 even on a block).
    const headers = buildSendHeaders(opts);
    return this.request<SendMessageResponse>('POST', '/v1/messages/send', {
      body: req,
      ...(headers ? { headers } : {}),
    });
  }

  async listMessages(
    mailboxId: string,
    opts?: {
      unread?: boolean; limit?: number; before?: string;
      sender?: string; since?: string; until?: string; search?: string;
      status?: string; direction?: string; view?: 'summary' | 'verbose';
      // S7 — NTH-005 `--starred` + NTH-002 `is:starred`. The API already
      // honors `starred=` (messages.ts); listMessages just wasn't forwarding it.
      starred?: boolean;
      // S7 gate A — has:attachment filter. Forwarded only when set; the inbox
      // command capability-gates this against /v1/health before forwarding.
      has_attachment?: boolean;
    },
  ): Promise<ListMessagesResponse> {
    const query: Record<string, string> = {};
    if (opts?.unread) query['unread'] = 'true';
    if (opts?.limit) query['limit'] = String(opts.limit);
    if (opts?.before) query['before'] = opts.before;
    if (opts?.sender) query['sender'] = opts.sender;
    if (opts?.since) query['since'] = opts.since;
    if (opts?.until) query['until'] = opts.until;
    if (opts?.search) query['search'] = opts.search;
    if (opts?.status) query['status'] = opts.status;
    if (opts?.direction) query['direction'] = opts.direction;
    if (opts?.view) query['view'] = opts.view;
    if (opts?.starred !== undefined) query['starred'] = String(opts.starred);
    if (opts?.has_attachment !== undefined) query['has_attachment'] = String(opts.has_attachment);

    return this.request<ListMessagesResponse>(
      'GET',
      `/v1/mailboxes/${mailboxId}/messages`,
      { query },
    );
  }

  async getMessage(id: string, opts?: { view?: 'summary' | 'verbose' }): Promise<GetMessageResponse> {
    const query: Record<string, string> | undefined = opts?.view ? { view: opts.view } : undefined;
    return this.request<GetMessageResponse>('GET', `/v1/messages/${id}`, query ? { query } : undefined);
  }

  /**
   * RL-UAT-013 — retrieve the safe TEXT preview for an inbound attachment.
   * GET /v1/messages/:id/attachments/:idx/preview. Returns extracted text
   * only — never the raw bytes (raw-byte download is a separate session-only
   * re-auth route, deliberately not surfaced here). Agent-accessible when the
   * mailbox has a preview tier enabled (derived_content /
   * raw_download_selected_types); a bound agent on a metadata_only mailbox
   * gets 403 ATTACHMENT_PREVIEW_DISABLED. Mirrors the SDK's
   * Attachments.getPreview(messageId, index) path byte-for-byte.
   */
  async getAttachmentPreview(messageId: string, index: number): Promise<AttachmentPreviewResponse> {
    return this.request<AttachmentPreviewResponse>(
      'GET',
      `/v1/messages/${messageId}/attachments/${index}/preview`,
    );
  }

  /**
   * Get the presigned download URL for an inbound attachment (FIND-011, WS4).
   * GET /v1/messages/:id/attachments/:idx — returns a short-lived signed R2
   * URL plus metadata. Mirrors SDK's Attachments.getDownloadUrl(). Session-
   * only re-auth applies on the server for approved raw-download tiers; the
   * CLI surfaces REAUTH_REQUIRES_SESSION as a plain ApiError.
   */
  async getAttachmentDownloadUrl(
    messageId: string,
    index: number,
  ): Promise<AttachmentDownloadUrlResponse> {
    return this.request<AttachmentDownloadUrlResponse>(
      'GET',
      `/v1/messages/${messageId}/attachments/${index}`,
    );
  }

  async reply(
    messageId: string,
    req: ReplyRequest,
    opts?: { idempotencyKey?: string; strictOutcome?: boolean },
  ): Promise<SendMessageResponse> {
    // Track 1 (migration 093) — Idempotency-Key header parity with send.
    // Track 2 — `strictOutcome` forwards `Prefer: outcome=strict` (parity).
    const headers = buildSendHeaders(opts);
    return this.request<SendMessageResponse>(
      'POST',
      `/v1/messages/${messageId}/reply`,
      { body: req, ...(headers ? { headers } : {}) },
    );
  }

  /**
   * Track 1 (§3a) — NON-THROWING idempotency replay probe. GET
   * /v1/messages/idempotency with the key in the Idempotency-Key HEADER (the key
   * is an arbitrary client string — may contain '/', '?', '#', space — so it is
   * NEVER path-interpolated, matching how it travels on the send/reply POST).
   *
   * The base request() THROWS an ApiError on every non-2xx, so a naive call
   * would throw on the load-bearing 404 *miss* (the common case) and on the 409
   * conflict codes. This helper try/catches and returns a discriminated value
   * for those, re-throwing every OTHER non-2xx (401/403/500/other-409-code) as
   * the original ApiError. It matches on the structured `statusCode` + wire
   * `code`, NOT a string-in-message match.
   *
   * The MCP/CLI attachment wrappers call this FIRST when a key is present —
   * before any upload / original-message fetch — so a same-key retry whose local
   * file is gone replays end-to-end instead of dying in the local preflight.
   */
  async getIdempotencyReplay(key: string): Promise<IdempotencyProbeResult> {
    try {
      const message = await this.request<SendMessageResponse>(
        'GET',
        '/v1/messages/idempotency',
        { headers: { 'Idempotency-Key': key } },
      );
      return { kind: 'replay', message };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // 404 — no prior keyed send/reply on this account: proceed (upload + POST).
      if (err.statusCode === 404) return { kind: 'miss' };
      if (err.statusCode === 409) {
        switch (err.code) {
          case 'IDEMPOTENT_REQUEST_IN_FLIGHT': {
            // retryAfter from the response BODY details.retry_after — NOT the
            // Retry-After header (the base client only parses that header for
            // 429→RateLimit; a 409 surfaces `details` but no headers).
            const ra = err.details?.['retry_after'];
            return {
              kind: 'in_flight',
              retryAfter: typeof ra === 'number' ? ra : null,
            };
          }
          case 'IDEMPOTENT_REQUEST_NOT_PROVEN_SENT':
            return { kind: 'not_proven_sent' };
          case 'IDEMPOTENCY_KEY_BOUND_TO_DRAFT':
            return { kind: 'bound_to_draft' };
        }
      }
      // Any other non-2xx (401/403/500/blank-key 400/other-409-code) is a real
      // error — re-throw the original so the CLI's central handler surfaces it.
      throw err;
    }
  }

  async waitForMessage(
    mailboxId: string,
    timeout: number = 30,
    since?: string,
  ): Promise<WaitResponse> {
    // Use a request timeout of poll timeout + 5s buffer for network overhead.
    // Without this, a hung API would block the CLI indefinitely.
    // RL-UAT-018 — `since` is the monitoring cursor anchor; sent verbatim only
    // when set so the legacy (no-since) query shape is unchanged.
    const query: Record<string, string> = { timeout: String(timeout) };
    if (since) query.since = since;
    return this.request<WaitResponse>(
      'GET',
      `/v1/mailboxes/${mailboxId}/messages/wait`,
      {
        query,
        signal: AbortSignal.timeout((timeout + 5) * 1000),
      },
    );
  }

  // === Draft endpoints ===

  async createDraft(
    req: CreateDraftRequest,
    opts?: { idempotencyKey?: string },
  ): Promise<DraftResponse> {
    // Idempotency-Key forwarded as an HTTP header. The server honors it on
    // both scheduled and immediate draft creates and owns the contract (durable,
    // draft-scoped replay); we don't guard here — the API-layer validation
    // surfaces any conflict via the usual error path.
    const headers = opts?.idempotencyKey
      ? { 'Idempotency-Key': opts.idempotencyKey }
      : undefined;
    return this.request<DraftResponse>('POST', '/v1/drafts', { body: req, ...(headers ? { headers } : {}) });
  }

  async getDraft(id: string): Promise<DraftResponse> {
    return this.request<DraftResponse>('GET', `/v1/drafts/${id}`);
  }

  async listDrafts(
    mailboxId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<ListDraftsResponse> {
    const query: Record<string, string> = {};
    if (opts?.limit) query['limit'] = String(opts.limit);
    if (opts?.before) query['before'] = opts.before;
    return this.request<ListDraftsResponse>('GET', `/v1/mailboxes/${mailboxId}/drafts`, { query });
  }

  async updateDraft(id: string, req: UpdateDraftRequest): Promise<DraftResponse> {
    return this.request<DraftResponse>('PATCH', `/v1/drafts/${id}`, { body: req });
  }

  async sendDraft(id: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>('POST', `/v1/drafts/${id}/send`, { body: {} });
  }

  async deleteDraft(id: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/drafts/${id}`);
  }

  // === Outbound attachment endpoints ===

  /**
   * Stage an outbound attachment (POST /v1/attachments, phase 1). Reads the
   * file from disk and uploads it as multipart/form-data; returns the opaque
   * handle whose `.id` is referenced in a send/reply/draft `attachment_ids`.
   *
   * This bypasses request() deliberately: that helper JSON.stringifies the body
   * and sets Content-Type: application/json. A multipart body must let fetch
   * derive the `multipart/form-data` boundary itself — so we hand-roll the
   * fetch, reusing only the Bearer header + the shared error/handle parsing.
   * Like request()'s mutating path, we do NOT retry on 5xx (never re-send a
   * partially-uploaded file).
   */
  async uploadAttachment(filePath: string, mailboxId: string): Promise<UploadAttachmentResponse> {
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new ApiError(0, 'FILE_READ_ERROR', `Cannot read attachment '${filePath}': ${message}`);
    }

    const form = new FormData();
    form.append('mailbox_id', mailboxId);
    // basename() strips any directory component so the multipart filename is a
    // bare name — the server validates it syntactically (ASCII, ≤255, no path
    // separators) and is authoritative.
    form.append('file', new Blob([bytes]), basename(filePath));

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    // Intentionally NO Content-Type — fetch sets multipart/form-data + boundary.

    const response = await this.doFetch(`${this.baseUrl}/v1/attachments`, {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as UploadAttachmentResponse;
    } catch {
      throw new ApiError(
        response.status,
        'PARSE_ERROR',
        `Failed to parse upload response: ${text.substring(0, 200)}`,
      );
    }
  }

  /**
   * Poll a staged-attachment handle (GET /v1/attachments/:id). Returns either
   * the active-handle shape (carrying content_scan_status) or, once consumed,
   * a `{ status: 'consumed', ... }` shape — discriminate on `status`.
   */
  async getAttachmentUpload(
    id: string,
  ): Promise<
    | UploadAttachmentResponse
    | { id: string; status: 'consumed'; consumed_at: string; consumed_message_id: string | null }
  > {
    return this.request('GET', `/v1/attachments/${id}`);
  }

  // === Recipient endpoints ===

  async addRecipient(email: string): Promise<AddRecipientResponse> {
    return this.request<AddRecipientResponse>('POST', '/v1/recipients', {
      body: { email } satisfies AddRecipientRequest,
    });
  }

  async listRecipients(): Promise<ListRecipientsResponse> {
    return this.request<ListRecipientsResponse>('GET', '/v1/recipients');
  }

  async deleteRecipient(id: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/recipients/${id}`);
  }

  /**
   * S5b — re-send the confirmation email to a pending verified recipient.
   * POST /v1/recipients/:id/resend (requireAdmin). Returns the action status;
   * 'already_confirmed' when the recipient is already confirmed (no email sent).
   */
  async resendRecipient(id: string): Promise<{ status: 'sent' | 'already_confirmed' }> {
    return this.request('POST', `/v1/recipients/${id}/resend`, { body: {} });
  }

  // === Webhooks (G8) — 1:1 with the SDK webhook resource ===

  async createWebhook(body: { url: string; description?: string; enabled_events: string[]; enabled?: boolean }): Promise<CreateWebhookResponse> {
    return this.request<CreateWebhookResponse>('POST', '/v1/webhooks', { body });
  }

  async listWebhooks(): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>('GET', '/v1/webhooks');
  }

  async getWebhook(id: string): Promise<WebhookSummary> {
    return this.request<WebhookSummary>('GET', `/v1/webhooks/${id}`);
  }

  async updateWebhook(id: string, body: { url?: string; description?: string | null; enabled_events?: string[]; enabled?: boolean }): Promise<WebhookSummary> {
    return this.request<WebhookSummary>('PATCH', `/v1/webhooks/${id}`, { body });
  }

  async deleteWebhook(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('DELETE', `/v1/webhooks/${id}`);
  }

  async rotateWebhookSecret(id: string): Promise<RotateWebhookSecretResponse> {
    return this.request<RotateWebhookSecretResponse>('POST', `/v1/webhooks/${id}/rotate-secret`, { body: {} });
  }

  async testWebhook(
    id: string,
    body?: { event: 'message.delivered' | 'message.bounced' | 'recipient_blocklist.added' },
  ): Promise<{ delivery_id: string }> {
    return this.request<{ delivery_id: string }>('POST', `/v1/webhooks/${id}/test`, { body: body ?? {} });
  }

  async listWebhookDeliveries(id: string, opts: { limit?: number; before_at?: string; before_id?: string } = {}): Promise<ListWebhookDeliveriesResponse> {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    // The server requires before_at + before_id together (400s otherwise).
    if (opts.before_at && opts.before_id) {
      qs.set('before_at', opts.before_at);
      qs.set('before_id', opts.before_id);
    }
    const tail = qs.toString();
    return this.request<ListWebhookDeliveriesResponse>('GET', `/v1/webhooks/${id}/deliveries${tail ? `?${tail}` : ''}`);
  }

  async retryWebhookDelivery(id: string, deliveryId: string): Promise<{ delivery_id: string; status: string }> {
    return this.request<{ delivery_id: string; status: string }>('POST', `/v1/webhooks/${id}/deliveries/${deliveryId}/retry`, { body: {} });
  }

  // === First-party simulator (plans/replylayer-simulator-mvp.md) ===

  async injectSimulatorInbound(
    body: InjectSimulatorInboundRequest,
  ): Promise<InjectSimulatorInboundResponse> {
    return this.request<InjectSimulatorInboundResponse>('POST', '/v1/simulator/inbound', { body });
  }

  // === Suppressions (do-not-contact list) ===
  // GET is unauth-restricted (any account-scoped key); POST is agent+admin;
  // DELETE is admin-only (agent keys get 403 INSUFFICIENT_SCOPE).

  async listSuppressions(options?: {
    reason?: 'hard_bounce' | 'complaint' | 'manual' | 'unsubscribe';
    limit?: number;
    cursor?: string;
    all?: boolean;
  }): Promise<ListSuppressionsResponse> {
    const query: Record<string, string> = {};
    if (options?.reason) query.reason = options.reason;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    return this.request<ListSuppressionsResponse>('GET', '/v1/suppressions', { query });
  }

  async addSuppression(email: string): Promise<AddSuppressionResponse> {
    return this.request<AddSuppressionResponse>('POST', '/v1/suppressions', {
      body: { email },
    });
  }

  /**
   * Add up to 1000 suppression entries in one request. Returns
   * partial-success buckets (added / already_existed / invalid + counts).
   * POST /v1/suppressions/bulk (FIND-009, WS4).
   */
  async addSuppressionsBulk(emails: string[]): Promise<BulkAddResponse> {
    return this.request<BulkAddResponse>('POST', '/v1/suppressions/bulk', {
      body: { emails },
    });
  }

  async deleteSuppression(email: string): Promise<DeleteSuppressionResponse> {
    return this.request<DeleteSuppressionResponse>(
      'DELETE',
      `/v1/suppressions/${encodeURIComponent(email)}`,
    );
  }

  // === Migration 047 — inbound firewall ===

  async listInboundBlocklist(options?: {
    limit?: number;
    cursor?: string;
    all?: boolean;
  }): Promise<{
    blocklist: Array<{
      email: string;
      reason: string;
      source: string;
      created_at: string;
      added_by_actor_type: string | null;
      added_by_actor_id: string | null;
      pattern_type?: 'email' | 'domain';
    }>;
    next_cursor: string | null;
  }> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    return this.request('GET', '/v1/inbound-blocklist', { query });
  }

  async addInboundBlocklist(email: string): Promise<{
    email: string;
    reason: 'manual';
    source: 'customer';
    created_at: string | null;
    already_existed: boolean;
    pattern_type?: 'email' | 'domain';
  }> {
    return this.request('POST', '/v1/inbound-blocklist', { body: { email } });
  }

  /**
   * Add up to 1000 inbound-blocklist entries in one request. Returns
   * partial-success buckets (added / already_existed / invalid + counts).
   * POST /v1/inbound-blocklist/bulk (FIND-010, WS4).
   * BulkAddInboundBlocklistResponse extends BulkAddSuppressionsResponse in
   * the SDK — same shape, reuse BulkAddResponse.
   */
  async addInboundBlocklistBulk(emails: string[]): Promise<BulkAddResponse> {
    return this.request<BulkAddResponse>('POST', '/v1/inbound-blocklist/bulk', {
      body: { emails },
    });
  }

  async deleteInboundBlocklist(email: string): Promise<{
    status: string;
    email: string;
    reason: string;
    source: string;
    created_at: string;
    pattern_type?: 'email' | 'domain';
  }> {
    return this.request('DELETE', `/v1/inbound-blocklist/${encodeURIComponent(email)}`);
  }

  async listInboundAllowlist(
    mailboxId: string,
    options?: { limit?: number; cursor?: string; all?: boolean },
  ): Promise<{
    allowlist: Array<{
      email: string;
      mailbox_id: string;
      created_at: string;
      added_by_actor_type: string | null;
      added_by_actor_id: string | null;
      pattern_type?: 'email' | 'domain';
    }>;
    next_cursor: string | null;
  }> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    return this.request('GET', `/v1/mailboxes/${mailboxId}/inbound-allowlist`, { query });
  }

  async addInboundAllowlist(
    mailboxId: string,
    email: string,
  ): Promise<{
    email: string;
    mailbox_id: string;
    created_at: string | null;
    already_existed: boolean;
    pattern_type?: 'email' | 'domain';
  }> {
    return this.request('POST', `/v1/mailboxes/${mailboxId}/inbound-allowlist`, {
      body: { email },
    });
  }

  /**
   * Add up to 1000 inbound-allowlist entries in one request. Returns
   * partial-success buckets (added / already_existed / invalid + counts).
   * POST /v1/mailboxes/:id/inbound-allowlist/bulk (FIND-008, WS4).
   */
  async addInboundAllowlistBulk(mailboxId: string, emails: string[]): Promise<BulkAddResponse> {
    return this.request<BulkAddResponse>(
      'POST',
      `/v1/mailboxes/${mailboxId}/inbound-allowlist/bulk`,
      { body: { emails } },
    );
  }

  async deleteInboundAllowlist(
    mailboxId: string,
    email: string,
    options?: { forceEmpty?: boolean },
  ): Promise<{ status: string; email: string; mailbox_id: string; created_at?: string }> {
    const query: Record<string, string> = {};
    if (options?.forceEmpty) query.force_empty = 'true';
    return this.request(
      'DELETE',
      `/v1/mailboxes/${mailboxId}/inbound-allowlist/${encodeURIComponent(email)}`,
      { query },
    );
  }

  async listInboundFirewallBlockedAttempts(
    mailboxId: string,
    options?: {
      limit?: number;
      cursor?: string;
      all?: boolean;
      aggregate?: boolean;
      withinDays?: number;
    },
  ): Promise<{
    attempts: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.all) query.all = 'true';
    if (options?.aggregate === false) query.aggregate = 'false';
    if (options?.withinDays !== undefined) query.within_days = String(options.withinDays);
    return this.request(
      'GET',
      `/v1/mailboxes/${mailboxId}/inbound-allowlist/blocked-attempts`,
      { query },
    );
  }

  async setSenderPolicy(
    mailboxId: string,
    mode: 'blocklist' | 'allowlist',
    options?: { forceEmpty?: boolean },
  ): Promise<{
    mailbox_id: string;
    sender_policy_mode: 'blocklist' | 'allowlist';
    previous_mode: 'blocklist' | 'allowlist';
    changed_at: string;
  }> {
    const body: Record<string, unknown> = { mode };
    if (options?.forceEmpty) body.force_empty = true;
    return this.request('PATCH', `/v1/mailboxes/${mailboxId}/sender-policy`, { body });
  }

  /**
   * Migration 047 — release a state='firewall_blocked' message back into
   * normal scanner processing. Atomic state-claim + worker enqueue;
   * returns 202 immediately. Auth: admin + agent (mailbox-bound).
   */
  async firewallRelease(messageId: string): Promise<{
    message_id: string;
    state: 'scanning';
  }> {
    return this.request('POST', `/v1/messages/${messageId}/firewall-release`, { body: {} });
  }

  /**
   * PR 6 — approve a state='pending_review' message and dispatch.
   * Wire status reports the Mailgun dispatch outcome (release-style).
   * Auth: admin (agent keys 403). Optional reason persisted to the
   * audit_log + webhook payload.
   */
  async approveReview(
    messageId: string,
    options: { reason?: string } = {},
  ): Promise<{ status: 'sent' | 'blocked'; message_id: string }> {
    const body: Record<string, string> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    return this.request('POST', `/v1/messages/${messageId}/approve`, { body });
  }

  /**
   * PR 6 — deny a state='pending_review' message; terminal block.
   * No dispatch. Auth: admin (agent keys 403).
   */
  async denyReview(
    messageId: string,
    options: { reason?: string } = {},
  ): Promise<{ status: 'denied'; message_id: string }> {
    const body: Record<string, string> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    return this.request('POST', `/v1/messages/${messageId}/deny`, { body });
  }

  /**
   * G7 — release a state='quarantined' INBOUND message (→ available).
   * Optional reason persisted to audit_log.detail_json.reason. INBOUND-ONLY
   * is enforced CLI-side (the server /release self-dispatches an outbound
   * quarantine via Mailgun), so callers MUST pre-check direction via
   * getMessage. Auth: admin OR mailbox-bound agent.
   */
  async release(
    messageId: string,
    options: { reason?: string } = {},
  ): Promise<{ status: string; message_id: string }> {
    const body: Record<string, string> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    return this.request('POST', `/v1/messages/${messageId}/release`, { body });
  }

  /**
   * G7 — block a state='quarantined' INBOUND message (→ terminal blocked).
   * Optional reason persisted to audit_log.detail_json.reason. INBOUND-ONLY
   * enforced CLI-side. Auth: admin OR mailbox-bound agent.
   */
  async block(
    messageId: string,
    options: { reason?: string } = {},
  ): Promise<{ status: string; message_id: string }> {
    const body: Record<string, string> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    return this.request('POST', `/v1/messages/${messageId}/block`, { body });
  }

  /**
   * Atomic report-and-block for an INBOUND message: blocks a held message and
   * adds the resolved sender to the account-wide inbound blocklist (idempotent).
   * Optional reason persisted to audit. The server rejects an outbound target
   * with 422 (an outbound message has no inbound sender to block); the command
   * additionally pre-fetches direction and refuses outbound for a clear error.
   */
  async report(
    messageId: string,
    options: { reason?: string } = {},
  ): Promise<{
    message_id: string;
    state: string;
    blocked: boolean;
    already_blocked: boolean;
    sender_blocklisted: string | null;
    already_blocklisted: boolean;
    pattern_type: string | null;
  }> {
    const body: Record<string, string> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    return this.request('POST', `/v1/messages/${messageId}/report`, { body });
  }

  /**
   * Soft-delete a message and purge its raw MIME (+ attachment derivatives)
   * from object storage. Direction-agnostic — works on inbound or outbound
   * rows in a deletable state; draft / scheduled / dispatching rows return
   * 409. Idempotent. Bodyless DELETE (no Content-Type set). Auth: admin +
   * session always; mailbox-bound agent keys only when the account has agent
   * message-deletion enabled (else 403 MESSAGE_DELETE_NOT_PERMITTED).
   */
  async deleteMessage(messageId: string): Promise<{
    status: string;
    message_id: string;
    raw_mime_deleted: boolean;
    derivatives_tombstoned: number;
    r2_objects_failed: string[];
  }> {
    return this.request('DELETE', `/v1/messages/${messageId}`);
  }

  /**
   * S7a — mark a single message as read. Eligible only for inbound,
   * visible (state NOT IN ('deleted', 'firewall_blocked')) rows.
   * Outbound / deleted / firewall_blocked rows return 200 no-op with the
   * row's existing read_at. Idempotent.
   */
  async markMessageRead(messageId: string): Promise<{
    message_id: string;
    read_at: string | null;
  }> {
    return this.request('POST', `/v1/messages/${messageId}/read`, { body: {} });
  }

  /**
   * S7a — bulk-mark every visible inbound unread message in a thread.
   * mailboxId accepts a name OR UUID; threadId is the thread key
   * (Message-Id or message UUID). Distinct 404 codes:
   * 'Mailbox not found' vs 'Thread not found'.
   */
  async markThreadRead(mailboxId: string, threadId: string): Promise<{
    thread_id: string;
    marked_count: number;
  }> {
    return this.request(
      'POST',
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}/read`,
      { body: {} },
    );
  }

  // === Threads (S7 NTH-004) ===

  /**
   * S7 NTH-004 — list threads in a mailbox. Mailbox-scoped by path param.
   * Returns per-thread summaries (id/subject/counts/starred/participants).
   */
  async listThreads(
    mailboxId: string,
    opts?: {
      limit?: number;
      before_ts?: string;
      since_ts?: string;
      starred?: boolean;
      has_inbound?: boolean;
      include_firewall_blocked?: boolean;
    },
  ): Promise<ListThreadsResponse> {
    const query: Record<string, string> = {};
    if (opts?.limit) query['limit'] = String(opts.limit);
    if (opts?.before_ts) query['before_ts'] = opts.before_ts;
    if (opts?.since_ts) query['since_ts'] = opts.since_ts;
    if (opts?.starred !== undefined) query['starred'] = String(opts.starred);
    if (opts?.has_inbound !== undefined) query['has_inbound'] = String(opts.has_inbound);
    if (opts?.include_firewall_blocked) query['include_firewall_blocked'] = 'true';
    return this.request<ListThreadsResponse>(
      'GET',
      `/v1/mailboxes/${mailboxId}/threads`,
      { query },
    );
  }

  /**
   * S7 NTH-004 — read a full thread (ordered messages). Account-wide by
   * default; pass `mailboxId` (gate C) to scope the lookup to one mailbox so
   * a thread key that collides across two of the account's mailboxes
   * resolves deterministically. The `?mailbox=` param requires a gate-C
   * server — a pre-gate server 400s the unknown param (fail-loud), which is
   * why the CLI `--mailbox` flag ships atomically with this.
   */
  async getThread(
    threadId: string,
    opts?: { view?: 'summary' | 'verbose'; mailboxId?: string },
  ): Promise<GetThreadResponse> {
    const query: Record<string, string> = {};
    if (opts?.view) query['view'] = opts.view;
    if (opts?.mailboxId) query['mailbox'] = opts.mailboxId;
    return this.request<GetThreadResponse>(
      'GET',
      `/v1/threads/${encodeURIComponent(threadId)}`,
      Object.keys(query).length ? { query } : undefined,
    );
  }

  // === Star (S7 NTH-005) — existing audited surface ===

  /**
   * S7 NTH-005 — star/unstar a single message. Idempotent server-side.
   * Auth: admin + agent (mailbox-bound, mask404).
   */
  async setMessageStarred(id: string, starred: boolean): Promise<MessageStarResponse> {
    return this.request<MessageStarResponse>('PATCH', `/v1/messages/${id}/star`, {
      body: { starred },
    });
  }

  /**
   * S7 NTH-005 — star/unstar every visible message in a thread. Returns
   * updated_count (rows that actually changed; idempotent re-star → 0).
   */
  async setThreadStarred(
    mailboxId: string,
    threadId: string,
    starred: boolean,
  ): Promise<ThreadStarResponse> {
    return this.request<ThreadStarResponse>(
      'PATCH',
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}/star`,
      { body: { starred } },
    );
  }

  // === API Key Management ===

  async createApiKey(body: { role: 'admin' | 'agent'; label?: string; mailbox_ids?: string[] }): Promise<CreateApiKeyResponse> {
    return this.request<CreateApiKeyResponse>('POST', '/v1/accounts/api-keys', { body });
  }

  async listApiKeys(opts?: { include_revoked?: boolean }): Promise<ListApiKeysResponse> {
    const qs = opts?.include_revoked ? '?include_revoked=true' : '';
    return this.request<ListApiKeysResponse>('GET', `/v1/accounts/api-keys${qs}`);
  }

  async updateApiKey(id: string, body: { mailbox_ids: string[] }): Promise<UpdateApiKeyResponse> {
    // Full-replace rebind of an agent key's mailbox bindings. The secret and
    // per-key capabilities are untouched — no agent redeploy needed.
    return this.request<UpdateApiKeyResponse>('PATCH', `/v1/accounts/api-keys/${encodeURIComponent(id)}`, { body });
  }

  async revokeApiKey(id: string): Promise<RevokeApiKeyResponse> {
    return this.request<RevokeApiKeyResponse>('DELETE', `/v1/accounts/api-keys/${id}`);
  }

  // === Email Verification ===

  async verifyEmail(code: string): Promise<{ verified: boolean }> {
    return this.request<{ verified: boolean }>('POST', '/v1/auth/verify-email', {
      body: { code },
    });
  }

  async verifyPhone(code: string): Promise<{ verified: boolean }> {
    return this.request<{ verified: boolean }>('POST', '/v1/auth/verify-phone', {
      body: { code },
    });
  }

  async resendPhoneVerification(phoneNumber?: string): Promise<{
    message: string;
    phone_number_masked: string;
    expires_at: string;
  }> {
    return this.request('POST', '/v1/auth/resend-phone-verification', {
      body: phoneNumber ? { phone_number: phoneNumber } : {},
    });
  }

  async resendVerification(email: string): Promise<{ message: string }> {
    return this.request<{ message: string }>('POST', '/v1/auth/resend-verification', {
      body: { email },
      auth: false,
    });
  }

  // === Health ===

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/v1/health', { auth: false });
  }

  // === Legal holds (PR 3) ===

  async applyLegalHold(params: {
    scope: 'account' | 'mailbox';
    reason: string;
    mailbox_id?: string;
    case_reference?: string;
  }): Promise<LegalHold> {
    return this.request<LegalHold>('POST', '/v1/legal-holds', { body: params });
  }

  async releaseLegalHold(holdId: string, releaseReason: string): Promise<LegalHold> {
    return this.request<LegalHold>(
      'POST',
      `/v1/legal-holds/${encodeURIComponent(holdId)}/release`,
      { body: { release_reason: releaseReason } },
    );
  }

  async listLegalHolds(options?: {
    include_released?: boolean;
    limit?: number;
  }): Promise<{ legal_holds: LegalHold[] }> {
    const query: Record<string, string> = {};
    if (options?.include_released) query.include_released = 'true';
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this.request('GET', '/v1/legal-holds', { query });
  }

  async getLegalHold(holdId: string): Promise<LegalHold> {
    return this.request<LegalHold>('GET', `/v1/legal-holds/${encodeURIComponent(holdId)}`);
  }
}

export interface LegalHold {
  id: string;
  scope: 'account' | 'mailbox';
  mailbox_id: string | null;
  case_reference: string;
  reason: string;
  applied_at: string;
  applied_by_type: 'admin' | 'customer' | 'system';
  released_at: string | null;
  released_by_type: 'admin' | 'customer' | 'system' | null;
  release_reason: string | null;
}
