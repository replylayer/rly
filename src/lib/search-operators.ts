/**
 * S7 NTH-002 — Gmail-style search-operator parser for the CLI.
 *
 * Unlike the dashboard's display-only parser (which uses a NARROW
 * `(from|to|subject|has|before|after)` alternation), this parser uses a
 * GENERIC `word:value` recognizer plus an
 * explicit allow-list dispatch. That is load-bearing: the generic recognizer
 * is what lets the CLI SEE unsupported operators (`is:read`, `in:inbox`,
 * `label:x`, `to:`) so it can REJECT them loudly with
 * `SEARCH_OPERATOR_UNSUPPORTED`, instead of silently leaving them in the
 * free-text residual where the API would treat them as a literal substring
 * and return zero results (the documented web foot-gun, F12).
 *
 * Supported operators (the ONLY allow-listed ones):
 *   from:<addr>     → --sender (partial match)
 *   subject:<term>  → folded into the free-text `search=` term
 *   after:<date>    → --since  (normalized to ISO)
 *   before:<date>   → --until  (normalized to ISO)
 *   is:starred      → --starred (starred=true)
 *   has:attachment  → has_attachment=true (S7 gate A; capability-gated in the
 *                     inbox command against /v1/health before forwarding)
 *
 * Everything else the recognizer captures (`to:`, `is:read`, `is:unread`,
 * `is:unstarred`, `in:<anything>`, `label:`, any other `word:value`) →
 * `SEARCH_OPERATOR_UNSUPPORTED`. `has:<other>` (e.g. `has:drive`) stays
 * unsupported; only `has:attachment` is allow-listed.
 *
 * Residual (non-operator) text becomes `search=`, mirroring the server's
 * minimum-3-NFKC-char rule (the API returns 400 SEARCH_TERM_TOO_SHORT below
 * that, BEFORE any DB work). Three cases — see resolveSearchOperators.
 */

import { LocalCliError } from '../errors.js';

/** Minimum NFKC-normalized search-term length the API enforces server-side. */
export const MIN_SEARCH_LENGTH = 3;

/**
 * The result of resolving a `--search` value: the structured filters plus any
 * non-fatal warnings (e.g. a short residual that was dropped while other
 * filters still applied). JSON-STDERR-001 (c) — warnings are RETURNED rather
 * than emitted as a stderr side-effect, so the caller can place them in the
 * structured `--json` output or render them on stderr in human mode.
 */
export interface SearchResolution {
  resolved: ResolvedSearchOpts;
  warnings: string[];
}

/** The structured filters the parser can resolve out of `--search`. */
export interface ResolvedSearchOpts {
  search?: string;
  sender?: string;
  since?: string;
  until?: string;
  starred?: boolean;
  // S7 gate A — has:attachment → has_attachment=true. The parser only RESOLVES
  // this (it stays pure + pre-auth); the inbox command capability-gates it
  // against /v1/health before forwarding has_attachment to the API.
  has_attachment?: boolean;
}

/** Structured flags already set on the CLI invocation (for conflict detection). */
export interface ExplicitSearchFlags {
  sender?: string;
  since?: string;
  until?: string;
  starred?: boolean;
  /**
   * True when the invocation carries ANOTHER list filter the parser does not
   * own (`--unread`/`--status`/`--direction`). Used so a short/empty search is
   * treated as "not the only filter" — omitted-with-warning rather than a hard
   * error — and so the zero-filter guard does not fire when the list is in fact
   * constrained by one of those flags.
   */
  otherListFilter?: boolean;
}

// Generic operator recognizer: a bare lowercase word, then `:`, then either a
// "quoted value" or a bare non-whitespace token. The `\b` anchor + leading
// lowercase-word requirement means an email like `bob@x.com` or a URL like
// `https://x.com` is NOT matched as `word:value` here — see isOperatorMatch.
const OPERATOR_RE = /([a-z]+):(?:"([^"]*)"|(\S+))/gi;

/**
 * Normalize a date string to ISO. Mirrors the web parser's normalizeDate:
 * `new Date(v)`; NaN → reject; else `toISOString()`. We REJECT (throw) rather
 * than silently dropping so a malformed `after:`/`before:` value fails loud.
 */
function normalizeDate(value: string, operator: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new LocalCliError(
      `Invalid date for ${operator}: "${value}". Use an ISO date (e.g. 2026-01-01).`,
      'VALIDATION_ERROR',
      { operator, value },
      2,
    );
  }
  return d.toISOString();
}

function unsupported(operator: string, message?: string): LocalCliError {
  return new LocalCliError(
    message ??
      `Unsupported search operator: ${operator}. Supported: from: subject: after: before: is:starred has:attachment.`,
    'SEARCH_OPERATOR_UNSUPPORTED',
    { operator },
    2,
  );
}

function conflict(operator: string, flag: string): LocalCliError {
  return new LocalCliError(
    `Conflicting filter: ${operator} and ${flag} both set ${flag.replace('--', '')}. Pass only one.`,
    'VALIDATION_ERROR',
    { operator, flag },
    2,
  );
}

/**
 * Determine whether a given OPERATOR_RE match is a real `word:value` operator
 * (vs a coincidental colon inside an email / URL / quoted span that should stay
 * free text). The match must:
 *   - have its operator-NAME start at the beginning of the raw string OR be
 *     preceded by whitespace (so the operator name is a standalone token, not
 *     the tail of a larger token like an email's domain `…@x.com:…`); and
 *   - NOT have a value that begins with `//` (a URL like `https://…`, where
 *     `https` would otherwise look like an operator name).
 *
 * Note: an `@` is allowed INSIDE the value (`from:bob@x.com` is valid) — the
 * exclusion is only about the operator-name side and URL schemes.
 */
function isOperatorMatch(raw: string, match: RegExpExecArray): boolean {
  const start = match.index;
  if (start > 0) {
    const prev = raw[start - 1]!;
    // The operator name must be a standalone token: only whitespace (or the
    // string start) may precede it. A preceding word/`@`/`.` etc. means the
    // `word:` is embedded in a larger token (e.g. an email or path) → free text.
    if (!/\s/.test(prev)) return false;
  }
  // URL scheme: value (m[3], unquoted) starting with `//` → not an operator.
  const bareValue = match[3];
  if (bareValue !== undefined && bareValue.startsWith('//')) return false;
  return true;
}

/**
 * Parse the raw `--search` string, route allow-listed operators to structured
 * opts, reject unsupported operators / conflicts / short residuals, and return
 * the resolved structured opts. Throws LocalCliError on any failure.
 *
 * @param raw      The raw `--search` value.
 * @param explicit Structured flags the user ALSO passed explicitly (for
 *                 fail-closed conflict detection).
 */
export function resolveSearchOperators(
  raw: string,
  explicit: ExplicitSearchFlags = {},
): SearchResolution {
  const resolved: ResolvedSearchOpts = {};
  const warnings: string[] = [];

  // Collect operator matches (with their spans) so we can strip them from the
  // residual free text afterward by index, avoiding re-matching the residual.
  OPERATOR_RE.lastIndex = 0;
  const matches: { start: number; end: number; op: string; value: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = OPERATOR_RE.exec(raw)) !== null) {
    if (!isOperatorMatch(raw, m)) continue;
    const op = m[1]!.toLowerCase();
    // m[2] = quoted value (may be empty string), m[3] = bare token.
    const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
    matches.push({ start: m.index, end: m.index + m[0].length, op, value });
  }

  // Build the residual (free text) by blanking out operator spans.
  let residual = raw;
  // Replace from the end so earlier indices stay valid.
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    residual = residual.slice(0, match.start) + ' ' + residual.slice(match.end);
  }

  // Subject terms fold into the free-text search; collect them and prepend.
  const subjectTerms: string[] = [];

  for (const { op, value } of matches) {
    switch (op) {
      case 'from':
        // An empty value (e.g. `from:""`) would map to an empty sender that the
        // client then drops as falsy → a silently sender-unfiltered list. Reject.
        if (value === '') {
          throw new LocalCliError('from: requires a value', 'VALIDATION_ERROR', { operator: 'from:' }, 2);
        }
        if (explicit.sender !== undefined) throw conflict('from:', '--sender');
        if (resolved.sender !== undefined) throw conflict('from:', '--sender');
        resolved.sender = value;
        break;
      case 'subject':
        subjectTerms.push(value);
        break;
      case 'after':
        if (explicit.since !== undefined) throw conflict('after:', '--since');
        if (resolved.since !== undefined) throw conflict('after:', '--since');
        resolved.since = normalizeDate(value, 'after:');
        break;
      case 'before':
        if (explicit.until !== undefined) throw conflict('before:', '--until');
        if (resolved.until !== undefined) throw conflict('before:', '--until');
        resolved.until = normalizeDate(value, 'before:');
        break;
      case 'is':
        if (value.toLowerCase() === 'starred') {
          if (explicit.starred !== undefined) throw conflict('is:starred', '--starred');
          if (resolved.starred !== undefined) throw conflict('is:starred', '--starred');
          resolved.starred = true;
        } else {
          // is:read, is:unread, is:unstarred, etc. — recognized but unsupported.
          throw unsupported(`is:${value}`);
        }
        break;
      case 'has':
        if (value.toLowerCase() === 'attachment') {
          // S7 gate A — resolve the filter pure + pre-auth. The capability gate
          // (probe /v1/health for 'messages.has_attachment_filter') lives in the
          // inbox command, after the client exists. A pre-gate-A server that
          // omits the capability fails loud there before the param is ever sent.
          resolved.has_attachment = true;
          break;
        }
        throw unsupported(`has:${value}`);
      default:
        // to:, in:, label:, and any other word:value — not in the allow-list.
        throw unsupported(`${op}:${value}`);
    }
  }

  // Assemble the residual free-text term (subject operators + leftover text).
  const freeText = [...subjectTerms, residual]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Decide whether any OTHER filter constrains the result (so a short residual
  // can be safely dropped-with-warning instead of being the only filter).
  const hasOtherFilter =
    resolved.sender !== undefined ||
    resolved.since !== undefined ||
    resolved.until !== undefined ||
    resolved.starred !== undefined ||
    resolved.has_attachment !== undefined ||
    explicit.sender !== undefined ||
    explicit.since !== undefined ||
    explicit.until !== undefined ||
    explicit.starred !== undefined ||
    explicit.otherListFilter === true;

  if (freeText.length > 0) {
    const normalizedLength = freeText.normalize('NFKC').length;
    if (normalizedLength >= MIN_SEARCH_LENGTH) {
      resolved.search = freeText;
    } else if (hasOtherFilter) {
      // (b) 1–2-char residual WITH other filters → omit search, warn once.
      // JSON-STDERR-001 (c): COLLECT the warning instead of writing to stderr
      // directly, so the caller can structure it under --json.
      warnings.push(
        `ignoring search term "${freeText}" — under the ${MIN_SEARCH_LENGTH}-character minimum; other filters still applied`,
      );
    } else {
      // (a) residual is the ONLY filter and <3 chars → fail loud, mirror server.
      throw new LocalCliError(
        'search terms must be at least 3 characters',
        'SEARCH_TERM_TOO_SHORT',
        { min_search_length: MIN_SEARCH_LENGTH },
        2,
      );
    }
  }

  // Zero-filter guard: a search input that resolved to NO filter at all (e.g.
  // `subject:""` folding to nothing, or an empty `--search ""`) must NOT
  // silently broaden to an unfiltered mailbox listing — the same invariant the
  // short-residual cases above enforce. If another list filter is present
  // (--unread/--status/--direction or a structured flag), the empty search is
  // a harmless no-op (the list is still constrained); otherwise fail loud.
  const resolvedSomething =
    resolved.search !== undefined ||
    resolved.sender !== undefined ||
    resolved.since !== undefined ||
    resolved.until !== undefined ||
    resolved.starred !== undefined ||
    resolved.has_attachment !== undefined;
  if (!resolvedSomething && !hasOtherFilter) {
    throw new LocalCliError(
      'Your search has no usable term or operator value — it would list the whole mailbox. Provide a search term (≥3 chars) or a supported operator value.',
      'SEARCH_TERM_TOO_SHORT',
      { min_search_length: MIN_SEARCH_LENGTH },
      2,
    );
  }

  return { resolved, warnings };
}
