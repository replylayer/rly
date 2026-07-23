/**
 * Secret-redaction helpers for `config show` / `doctor` output
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
