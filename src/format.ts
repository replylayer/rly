import type { AgentSafetyContext, GetMessageResponse, MessageSummary, ScanSummary, SenderAuthentication } from './protocol.js';
import type { ThreadSummary, GetThreadResponse } from './types.js';

const isTTY = process.stdout.isTTY;

// ANSI color helpers — only emit codes when stdout is a TTY
const color = {
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

/**
 * Format a table with aligned columns.
 */
export function formatTable(
  headers: string[],
  rows: string[][],
): string {
  if (rows.length === 0) {
    return '(no results)';
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxRow = rows.reduce(
      (max, row) => Math.max(max, (row[i] || '').length),
      0,
    );
    return Math.max(h.length, maxRow);
  });

  // Build header line
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i]!))
    .join('  ');

  // Build separator
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  // Build rows
  const dataLines = rows.map((row) =>
    row.map((cell, i) => (cell || '').padEnd(widths[i]!)).join('  '),
  );

  return [color.bold(headerLine), separator, ...dataLines].join('\n');
}

/**
 * Format a message for `inbox read` display.
 */
export function formatMessage(msg: GetMessageResponse): string {
  const lines: string[] = [];

  lines.push(`${color.bold('From:')}    ${msg.sender}`);
  lines.push(`${color.bold('To:')}      ${msg.recipient}`);
  // Resolve the owning mailbox to its human-readable name when the server
  // supplied it (additive field); otherwise the agent only has the UUID.
  if (msg.mailbox_name) {
    lines.push(`${color.bold('Mailbox:')} ${msg.mailbox_name}`);
  }
  lines.push(`${color.bold('Subject:')} ${msg.subject}`);
  lines.push(
    `${color.bold('Date:')}    ${formatDate(msg.created_at)}`,
  );
  lines.push(`${color.bold('State:')}   ${formatState(msg.state)}`);

  // R5 — verified-sender signal. Honest labels: verified_aligned is high-confidence
  // DOMAIN authenticity (not identity/content). Omitted when not evaluated (null).
  const senderAuthLine = formatSenderAuth(msg.sender_authentication ?? null);
  if (senderAuthLine) {
    lines.push(`${color.bold('Sender:')} ${senderAuthLine}`);
  }

  if (msg.thread_id) {
    lines.push(`${color.bold('Thread:')}  ${msg.thread_id}`);
  }
  if (msg.in_reply_to) {
    lines.push(`${color.bold('Reply to:')} ${msg.in_reply_to}`);
  }
  // S7 NTH-003 — deep link into the web inbox; only when the server computed
  // one (null when PUBLIC_LINK_BASE_URL is unset, e.g. staging).
  if (msg.dashboard_url) {
    lines.push(`${color.bold('Link:')}    ${msg.dashboard_url}`);
  }
  // S7 NTH-005 — only surface a Starred line when the message is starred.
  if (msg.starred) {
    lines.push(`${color.bold('Starred:')} ${color.yellow('★')}`);
  }

  // Slice 6b — standing untrusted-content contract + any trusted-instruction
  // relaxation. Rendered BEFORE the body (right after the metadata) so an agent
  // consuming this output reads the behavioural contract AHEAD of the
  // untrusted/trusted message content — an injection in the body can never
  // precede the handling guidance in reading order. The human path surfaces it;
  // --json carries the raw field regardless.
  const safetyLines = formatAgentSafetyContext(msg.agent_safety_context ?? null);
  if (safetyLines.length > 0) {
    lines.push('');
    lines.push(...safetyLines);
  }

  lines.push('');
  const bodyContent = msg.body?.content ?? null;
  lines.push(bodyContent || color.dim('(no body)'));
  if (msg.body?.truncated) {
    lines.push(color.dim(`(body truncated: ${msg.body.returned_char_count}/${msg.body.char_count} chars returned)`));
  }

  // Attachments
  if (msg.attachments && msg.attachments.length > 0) {
    lines.push('');
    lines.push(color.bold('Attachments:'));
    for (const att of msg.attachments) {
      const sizeStr = formatSize(att.size);
      const action =
        att.policy_action === 'deliver'
          ? color.green(att.policy_action)
          : att.policy_action === 'quarantine'
            ? color.yellow(att.policy_action)
            : att.policy_action === 'block'
              ? color.red(att.policy_action)
              : att.policy_action;
      lines.push(`  ${att.filename} (${att.content_type}, ${sizeStr}) [${action}]`);
    }
  }

  // Scan summary — per-finding detail (incl. any agent_instructions), rendered
  // after the body. The standing agent_safety_context contract is rendered above
  // the body (see the slice-6b block after the metadata).
  const scanLines = formatScanSummary(msg.scan ?? null);
  if (scanLines.length > 0) {
    lines.push('');
    lines.push(...scanLines);
  }

  return lines.join('\n');
}

/**
 * Slice 6b — render the standing agent-safety contract for an inbound message.
 * Returns lines (caller decides spacing); empty for outbound (ctx null).
 *
 * When `instruction_trust` is present the message is from a TRUSTED instruction
 * source (the read gate relaxed + this client opted in): surface that prominently
 * (the verified domain + verdict/provenance) so a human or agent sees the
 * relaxation, then the server's authoritative trusted-instruction guidance.
 * Otherwise the baseline "treat the body as untrusted data" guidance is shown
 * dimmed. The guidance string is printed verbatim — it is vendor-free and
 * content-free, so there is no anonymization concern.
 */
export function formatAgentSafetyContext(ctx: AgentSafetyContext | null): string[] {
  if (!ctx) return [];
  const lines: string[] = [];
  const trust = ctx.instruction_trust;
  if (trust) {
    const domain = trust.verified_domain ?? color.dim('(domain hidden)');
    lines.push(
      `${color.bold('Agent trust:')} ` +
        color.green(`✓ trusted instruction source — ${domain}`) +
        ` ${color.dim(`(${trust.verdict} via ${trust.provenance})`)}`,
    );
  }
  lines.push(`${color.bold('Agent guidance:')} ${color.dim(ctx.guidance)}`);
  return lines;
}

/**
 * Standalone scan-summary renderer. Returns an array of lines (caller
 * decides spacing). Empty array when scan is null or has no signal worth
 * displaying. Vendor names never appear (anonymized server-side).
 *
 * Plan B note (per plans/scan-result-summary-and-vendor-anonymization.md
 * §7 and §2a layering invariant): kept independent of body / header
 * rendering so a future `formatAgentSafetyContext(ctx)` block can be
 * spliced in above this section without touching `formatMessage`.
 */
export function formatScanSummary(scan: ScanSummary | null): string[] {
  if (scan === null) return [];
  if (scan.findings.length === 0 && scan.categories.length === 0) {
    // Verdict-only on a totally clean message — show a one-line "All clear"
    // marker only when verdict is clean; otherwise drop the section.
    if (scan.verdict === 'clean') return [color.bold('Scan:'), `  ${color.green('clean')}`];
    return [color.bold('Scan:'), `  ${formatVerdict(scan.verdict)}`];
  }

  const lines: string[] = [];
  lines.push(`${color.bold('Scan:')}    ${formatVerdict(scan.verdict)}`);
  if (scan.categories.length > 0) {
    const cats = scan.categories.map((c) => `${c.category}(${formatDecision(c.decision)})`).join(', ');
    lines.push(`  ${color.dim('categories:')} ${cats}`);
  }
  if (scan.findings.length > 0) {
    lines.push(color.bold('Findings:'));
    for (const f of scan.findings) {
      const reason = f.reason ?? color.dim('(no detail)');
      const subtype = f.subtype ? ` [${f.subtype}]` : '';
      const piiType = f.pii_type ? ` [pii_type=${f.pii_type}]` : '';
      const aIdx = f.attachment_index !== undefined ? ` [attachment_index=${f.attachment_index}]` : '';
      const aName = f.attachment_filename ? ` [attachment_filename=${f.attachment_filename}]` : '';
      const action = f.attachment_policy_action ? ` [${f.attachment_policy_action}]` : '';
      // Inference-failure-transparency plan §5.5 — short suffix so operators
      // and agents can tell at a glance that this quarantine is an infra
      // failure rather than a model content judgment.
      const infraSuffix = f.failure_class === 'inference_error' ? ' (infrastructure error)' : '';
      lines.push(`  ${f.category}: ${formatDecision(f.decision)}${subtype}${piiType}${aIdx}${aName}${action} - ${reason}${infraSuffix}`);
      if (f.agent_instructions && f.agent_instructions.length > 0) {
        for (const ins of f.agent_instructions) {
          lines.push(`    ${color.dim('→')} ${ins}`);
        }
      }
    }
  }
  return lines;
}

/**
 * R5 — render the verified-sender signal as one honest line, or null to omit
 * (null/not-evaluated). verified_aligned is the only "trust" affordance and is
 * deliberately worded as DOMAIN authenticity, never identity or content safety.
 */
function formatSenderAuth(sa: SenderAuthentication | null): string | null {
  if (!sa) return null;
  const domain = sa.from_domain ? ` (${sa.from_domain})` : '';
  switch (sa.verdict) {
    case 'verified_aligned':
      return color.green(`✓ verified — genuinely from this domain${domain}`) +
        color.dim(' (domain auth, not identity/content)');
    case 'authenticated_unaligned':
      return color.yellow(`~ authenticated but not From-aligned${domain}`);
    case 'failed':
      return color.red('✗ authentication failed');
    case 'error':
      return color.yellow('! authentication anomaly — treated as unverified');
    case 'none':
      return color.dim('unverified — sender published no authentication');
    default: {
      // Tolerant reader: an unknown verdict is never treated as verified.
      return color.dim('unverified');
    }
  }
}

function formatVerdict(verdict: ScanSummary['verdict']): string {
  switch (verdict) {
    case 'clean':           return color.green(verdict);
    case 'warning':         return color.yellow(verdict);
    case 'review_required': return color.yellow(verdict);
    case 'quarantined':     return color.yellow(verdict);  // releasable → yellow, like pending_review
    case 'blocked':         return color.red(verdict);     // terminal → red
    default: {
      const _exhaustive: never = verdict;   // compile error if a new verdict is added without a case
      return _exhaustive;
    }
  }
}

function formatDecision(decision: string): string {
  if (decision === 'allow') return color.green(decision);
  if (decision === 'block' || decision === 'quarantine') return color.red(decision);
  return color.yellow(decision);
}

/**
 * Format a message summary for inbox list rows.
 *
 * The 6th cell ("SCAN") surfaces the vendor-neutral scan verdict that
 * the JSON payload already carries via `msg.scan.verdict`. Reuses the
 * shared `formatVerdict` color helper so verdict rendering stays
 * single-sourced with `formatScanSummary`. Null-scan rows
 * (state=`scanning`, `firewall_blocked` with no scan run, legacy
 * pre-scan-summary rows) render `-`.
 */
export function formatMessageRow(msg: MessageSummary): string[] {
  const unreadMarker = msg.read_at ? ' ' : '*';
  // S7 NTH-005 — prepend a star indicator alongside the unread marker so the
  // list shows star state without adding a 7th column (keeps the 6-cell shape).
  const starMarker = msg.starred ? '★' : ' ';
  return [
    starMarker + unreadMarker + msg.id.substring(0, 8),
    msg.sender,
    msg.subject.substring(0, 50),
    formatDate(msg.created_at),
    formatState(msg.state),
    msg.scan ? formatVerdict(msg.scan.verdict) : '-',
  ];
}

/**
 * S7 NTH-004 — format a list of thread summaries as a table.
 *
 * THREAD shows the FULL thread key (NOT truncated) — the S7 acceptance path is
 * that this key is pasted verbatim into `send --thread` / `draft create
 * --thread`, so a truncated key would break the headline workflow. STARRED is a
 * `★` when any message in the thread is starred, blank otherwise.
 */
export function formatThreadList(threads: ThreadSummary[]): string {
  return formatTable(
    ['THREAD', 'SUBJECT', 'MSGS', 'UNREAD', 'LAST', 'STARRED'],
    threads.map((t) => [
      t.id,
      t.subject.substring(0, 50),
      String(t.message_count),
      String(t.unread_count),
      formatDate(t.last_message_at),
      t.starred ? color.yellow('★') : '',
    ]),
  );
}

/**
 * S7 NTH-004 — render a full thread as a conversation: a one-line header, then
 * each message via the existing formatMessage() block separated by `---`. The
 * endpoint already returns messages in created_at ASC order.
 */
export function formatThread(thread: GetThreadResponse): string {
  const count = thread.message_count;
  const header = `${color.bold('Thread:')} ${thread.subject} ${color.dim(`(${count} message${count === 1 ? '' : 's'})`)}`;
  const blocks = thread.messages.map((msg) => formatMessage(msg));
  return [header, '', ...joinWithRule(blocks)].join('\n');
}

/** Join rendered message blocks with a `---` separator line between each. */
function joinWithRule(blocks: string[]): string[] {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) out.push(color.dim('---'));
    out.push(block);
  });
  return out;
}

function formatState(state: string): string {
  switch (state) {
    case 'available':
      return color.green(state);
    case 'quarantined':
      return color.yellow(state);
    case 'pending_review':
      // PR 6 — distinct from quarantined; awaiting human approve/deny.
      return color.yellow(state);
    case 'blocked':
      return color.red(state);
    case 'delivered':
      return color.green(state);
    case 'bounced':
      return color.red(state);
    default:
      return state;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return iso;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Output helper: prints JSON if --json flag is set, otherwise the formatted string.
 */
export function output(data: unknown, formatted: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatted);
  }
}

/**
 * Print a status message about a send/reply result.
 */
export function formatSendResult(result: {
  message_id: string;
  status: string;
  warning?: string | null;
  daily_limit?: number;
  sends_remaining?: number;
  // inline-scan-verdict-on-send §3c — additive send-response channels.
  scan?: ScanSummary | null;
  hold_context?: { trigger_source: string; summary_reasons: string[] } | null;
  // Outbound HTML sanitization (Phase 2, D3). Present on send/reply 200s.
  html_sanitized?: boolean;
  removed_categories?: string[];
  // Track 2 (Governed Email-Effect Contract v1) — additive + optional. Rendered
  // as a one-line "Effect:" marker so an agent sees the governed outcome
  // discriminator (sent / held_for_review / held_infrastructure / blocked)
  // without parsing status + scan + hold_context.
  email_effect?: { effect_status: string } | null;
}): string {
  const budgetInfo = result.sends_remaining != null
    ? ` (${result.sends_remaining}/${result.daily_limit} remaining)`
    : '';

  // Outbound HTML sanitization note — only when the deliverable HTML was
  // actually altered (html_sanitized === true with categories). Tells the
  // agent/operator what was stripped from the wire copy so a missing remote
  // image or external link in the delivered mail isn't a surprise.
  const sanitizeNote = (): string => {
    if (result.html_sanitized !== true) return '';
    const cats = result.removed_categories ?? [];
    if (cats.length === 0) return '';
    return '\n' + color.dim(`Note: removed for delivery: ${cats.join(', ')}`);
  };

  // Track 2 — surface the governed effect_status as its own line when present.
  // A vendor-neutral one-read discriminator (sent / held_for_review /
  // held_infrastructure / blocked) so the agent need not re-derive it from
  // status + scan + hold_context. Colorized by outcome class.
  const effectNote = (): string => {
    const es = result.email_effect?.effect_status;
    if (!es) return '';
    const painted =
      es === 'blocked'
        ? color.red(es)
        : es === 'held_infrastructure' || es === 'held_for_review'
          ? color.yellow(es)
          : color.green(es);
    return '\n' + `${color.bold('Effect:')}  ${painted}`;
  };

  // On non-sent (held) statuses, explain WHY inline so the agent doesn't need a
  // second read_message call. `scan` carries the scanner verdict; `hold_context`
  // carries the hold reason + agent_instructions on held sends (policy causes,
  // policy-changed decisions, and genuine scan-explained holds alike; null on
  // sent/terminal and normally on infrastructure holds). --json paths carry
  // both raw, untouched.
  const heldDetail = (): string => {
    const lines: string[] = [];
    const scanLines = formatScanSummary(result.scan ?? null);
    if (scanLines.length > 0) lines.push(...scanLines);
    if (result.hold_context) {
      lines.push(color.bold(`Hold: ${result.hold_context.trigger_source}`));
      for (const reason of result.hold_context.summary_reasons) {
        lines.push(`  ${reason}`);
      }
    }
    return lines.length > 0 ? '\n' + lines.join('\n') : '';
  };

  switch (result.status) {
    case 'sent': {
      // POST /v1/messages/send (and reply, draft-send) returns
      // status='sent' + warning?: string on allow_with_warning. Surface
      // the warning inline so agents/operators see actionable findings on
      // the default CLI path (the JSON output already carries it).
      const warningSuffix = result.warning ? ` — ${color.yellow(result.warning)}` : '';
      return color.green(`Sent: ${result.message_id}`) + warningSuffix + budgetInfo + sanitizeNote() + effectNote();
    }
    case 'quarantined':
      return color.yellow(
        `Quarantined: ${result.message_id}${result.warning ? ` — ${result.warning}` : ''}`,
      ) + budgetInfo + heldDetail() + effectNote();
    case 'blocked':
      return color.red(
        `Blocked: ${result.message_id}${result.warning ? ` — ${result.warning}` : ''}`,
      ) + budgetInfo + heldDetail() + effectNote();
    case 'pending_review':
      // PR 6 — message is held in the review queue (every tier). Distinct from
      // quarantined: customer must explicitly approve/deny before dispatch.
      return color.yellow(
        `Held for review — will not send until approved: ${result.message_id}${result.warning ? ` — ${result.warning}` : ''}`,
      ) + budgetInfo + heldDetail() + effectNote();
    default:
      return `${result.status}: ${result.message_id}` + budgetInfo + effectNote();
  }
}
