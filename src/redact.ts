/**
 * Secret-redaction helpers for `config show` / `doctor` / `auth status` output
 * (plan M2.5 / M2.8). Proxy env vars frequently embed credentials
 * (`https://user:pass@proxy.example:8443`); these MUST never be echoed
 * verbatim by a diagnostics command.
 */

/**
 * Redact the userinfo (`user:password`) from a URL while preserving
 * scheme/host/port/path for diagnostics.
 *
 * - A URL with no userinfo is returned unchanged.
 * - Present credentials are replaced with `***` (so the host is still
 *   visible for debugging but the secret is not).
 * - A value that does not parse as a URL but contains `@` (so it may carry
 *   userinfo, e.g. a bare `user:pass@host:port`) is collapsed to
 *   `<redacted>` — refusing to echo it is the fail-safe choice.
 */
export function redactUrlCredentials(value: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  // Only trust WHATWG userinfo parsing for real http(s) proxy URLs. A bare
  // `user:pass@host:3128` (no scheme) actually PARSES with `user:` as a
  // pseudo-scheme and empty userinfo, which would otherwise slip the secret
  // through unredacted — so anything that is not http(s) falls to the
  // refuse-if-it-contains-@ branch below.
  if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
    if (!url.username && !url.password) {
      // Nothing to redact — return the original verbatim so a clean proxy URL
      // is not surprised by WHATWG normalization (e.g. an added trailing slash).
      return value;
    }
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    return url.toString();
  }

  return value.includes('@') ? '<redacted>' : value;
}

/**
 * Redact a delimited list of host/URL entries (e.g. `NO_PROXY`), applying the
 * same fail-closed rule per entry: any segment that carries userinfo is
 * collapsed to `<redacted>`, plain hosts/domains pass through. Returns null
 * for an empty/unset value.
 */
export function redactCredentialList(
  value: string | undefined,
  separator = ',',
): string | null {
  if (!value) return null;
  return value
    .split(separator)
    .map((part) => redactUrlCredentials(part.trim()))
    .join(separator);
}

/**
 * Mask an API key for display so the CLI and the dashboard show the SAME
 * string for the same key.
 *
 * A current key is `rly_live_<public_id>.<secret>`: the head before the `.` is
 * the non-secret public id assigned when the key is minted, and the dashboard's
 * key list renders exactly `rly_live_<public_id>.****` (the server computes that
 * same string for the key-list `prefix` field). The secret is unrecoverable
 * after creation, so the public id is the only stable identity both surfaces can
 * show; deriving it locally is what lets a user match the key their CLI is using
 * to a row in the dashboard.
 *
 * Pure string work over the key the CLI already holds — no network call and no
 * cross-package import (this CLI ships as a standalone public source tree).
 *
 * Legacy `rl_live_` keys carry no `.` and therefore no public id. They fall back
 * to the historical head-and-tail preview rather than crashing or asserting a
 * public id that does not exist. Any other unexpected shape (no `.`, a leading
 * `.`, or nothing after the `.`) takes the same fallback.
 */
export function maskApiKeyForDisplay(apiKey: string): string {
  const dot = apiKey.indexOf('.');
  // Require a non-empty head AND a non-empty secret: `rly_live_abc.` has no
  // secret to mask, so rendering `rly_live_abc.****` would misreport the shape.
  if (dot > 0 && dot < apiKey.length - 1) {
    return `${apiKey.slice(0, dot)}.****`;
  }
  return legacyKeyPreview(apiKey);
}

/**
 * The pre-2026-09 preview: first 10 chars, an ellipsis, last 4 chars. Retained
 * ONLY as the fallback for a key with no public id. It reveals the tail of the
 * credential, which is why it is no longer the default for current keys.
 */
function legacyKeyPreview(apiKey: string): string {
  return apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4);
}
