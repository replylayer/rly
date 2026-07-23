import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolveApiKey, getCredentialFilePath, type KeySource } from '../auth.js';
import { stripTrailingSlashes } from '../api-client.js';
import { buildMetadata } from '../build-metadata.js';
import { redactUrlCredentials } from '../redact.js';
import { EXIT } from '../errors.js';
import { output } from '../format.js';

export type CheckSeverity = 'ok' | 'warn' | 'error' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  severity: CheckSeverity;
  detail: string;
}

export interface DoctorReport {
  /** True when no check has `error` severity. */
  ok: boolean;
  checks: DoctorCheck[];
}

const DEFAULT_NETWORK_TIMEOUT_MS = 4000;

/** Per-check network timeout, env-overridable (plan M2.6 budget). */
export function networkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.REPLYLAYER_DOCTOR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NETWORK_TIMEOUT_MS;
}

// --------------------------------------------------------------------------
// Pure detectors (no network) — individually unit-tested.
// --------------------------------------------------------------------------

export function detectLibc(platform: NodeJS.Platform = process.platform): DoctorCheck {
  if (platform !== 'linux') {
    return { id: 'libc', title: 'libc', severity: 'skip', detail: 'not applicable on this platform' };
  }
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const glibc = report?.header?.glibcVersionRuntime;
    if (glibc) {
      return { id: 'libc', title: 'libc', severity: 'ok', detail: `glibc ${glibc}` };
    }
    // No glibc runtime version on Linux ⇒ almost certainly musl (Alpine). The
    // published Linux binaries are glibc-built and will not run on musl, so
    // flag it rather than silently failing with an opaque loader error.
    return {
      id: 'libc',
      title: 'libc',
      severity: 'warn',
      detail: 'musl libc detected (no glibc runtime) — the published Linux binaries are glibc-built and will not run here',
    };
  } catch {
    return { id: 'libc', title: 'libc', severity: 'skip', detail: 'could not determine libc' };
  }
}

export function checkApiUrl(apiUrl: string): DoctorCheck {
  try {
    const u = new URL(apiUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { id: 'api_url', title: 'API URL', severity: 'error', detail: `unsupported protocol: ${u.protocol}` };
    }
    return { id: 'api_url', title: 'API URL', severity: 'ok', detail: apiUrl };
  } catch {
    return { id: 'api_url', title: 'API URL', severity: 'error', detail: `not a valid URL: ${apiUrl}` };
  }
}

export function checkProxyEnv(env: NodeJS.ProcessEnv = process.env): DoctorCheck {
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  const http = env.HTTP_PROXY ?? env.http_proxy;
  if (!https && !http) {
    return { id: 'proxy', title: 'HTTP(S) proxy', severity: 'ok', detail: 'no proxy env set' };
  }
  const parts: string[] = [];
  if (https) parts.push(`HTTPS_PROXY=${redactUrlCredentials(https)}`);
  if (http) parts.push(`HTTP_PROXY=${redactUrlCredentials(http)}`);
  return {
    id: 'proxy',
    title: 'HTTP(S) proxy',
    severity: 'warn',
    detail: `${parts.join(', ')} — the CLI does not currently route requests through an HTTP(S) proxy (see docs/cli-network-behavior.md)`,
  };
}

export function checkCustomCa(env: NodeJS.ProcessEnv = process.env): DoctorCheck {
  const ca = env.NODE_EXTRA_CA_CERTS;
  if (!ca) {
    return { id: 'tls_custom_ca', title: 'Custom CA', severity: 'ok', detail: 'no NODE_EXTRA_CA_CERTS set' };
  }
  return {
    id: 'tls_custom_ca',
    title: 'Custom CA',
    severity: 'warn',
    detail: `NODE_EXTRA_CA_CERTS=${ca} — a custom CA can intercept TLS to the API; confirm it is trusted (see docs/cli-security.md)`,
  };
}

export function checkCredential(source: KeySource): DoctorCheck {
  if (source === 'none') {
    return {
      id: 'credential',
      title: 'Credential',
      severity: 'warn',
      detail: 'no API key configured (run `rly auth login`, set REPLYLAYER_API_KEY, or pass --api-key)',
    };
  }
  return { id: 'credential', title: 'Credential', severity: 'ok', detail: `source: ${source}` };
}

export function checkConfigPerms(credPath: string = getCredentialFilePath()): DoctorCheck {
  if (!existsSync(credPath)) {
    return { id: 'config_perms', title: 'Credential file permissions', severity: 'skip', detail: 'no credential file' };
  }
  if (process.platform === 'win32') {
    return { id: 'config_perms', title: 'Credential file permissions', severity: 'ok', detail: 'POSIX mode not enforced on Windows' };
  }
  try {
    const mode = statSync(credPath).mode & 0o777;
    const octal = `0${mode.toString(8).padStart(3, '0')}`;
    if (mode & 0o077) {
      return {
        id: 'config_perms',
        title: 'Credential file permissions',
        severity: 'warn',
        detail: `credential file is mode ${octal}; expected 0600 (it is group/other-accessible)`,
      };
    }
    return { id: 'config_perms', title: 'Credential file permissions', severity: 'ok', detail: `mode ${octal}` };
  } catch {
    return { id: 'config_perms', title: 'Credential file permissions', severity: 'skip', detail: 'could not stat credential file' };
  }
}

export function checkLegacyPlaintext(credPath: string = getCredentialFilePath()): DoctorCheck {
  if (existsSync(credPath)) {
    return {
      id: 'legacy_plaintext',
      title: 'Plaintext credential',
      severity: 'warn',
      detail: `API key stored in plaintext at ${credPath} (OS-native secure storage is planned — see docs/cli-security.md)`,
    };
  }
  return { id: 'legacy_plaintext', title: 'Plaintext credential', severity: 'ok', detail: 'no plaintext credential file' };
}

const SECURE_STORE_CHECK: DoctorCheck = {
  id: 'secure_store',
  title: 'Secure credential store',
  severity: 'skip',
  detail: 'OS-native secure storage not yet implemented (planned — see docs/cli-security.md)',
};

/**
 * All local, no-network checks. Pure aside from reading env / fs / process,
 * which the individual detectors accept as injectable parameters for testing.
 */
export function buildLocalChecks(opts: { apiUrl: string; source: KeySource }): DoctorCheck[] {
  const meta = buildMetadata();
  return [
    { id: 'cli_version', title: 'CLI version', severity: 'ok', detail: `${meta.version} (${meta.channel}, ${meta.runtime})` },
    { id: 'runtime', title: 'Runtime', severity: 'ok', detail: `${meta.os}/${meta.arch}, node ${meta.node_version}` },
    detectLibc(),
    checkApiUrl(opts.apiUrl),
    checkCustomCa(),
    checkProxyEnv(),
    checkCredential(opts.source),
    SECURE_STORE_CHECK,
    checkConfigPerms(),
    checkLegacyPlaintext(),
  ];
}

// --------------------------------------------------------------------------
// Network checks — bounded by a per-check timeout; skipped under --offline.
// Direct bounded fetch (not ApiClient.request) so the timeout is honored and
// the 5xx-retry path is bypassed (a doctor probe wants one quick attempt).
// --------------------------------------------------------------------------

export async function checkConnectivity(apiUrl: string): Promise<DoctorCheck> {
  let host: string;
  let base: string;
  try {
    const u = new URL(apiUrl);
    host = u.host;
    base = stripTrailingSlashes(apiUrl);
  } catch {
    return { id: 'connectivity', title: 'API connectivity', severity: 'skip', detail: 'invalid API URL' };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(networkTimeoutMs()),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      return { id: 'connectivity', title: 'API connectivity', severity: 'ok', detail: `${host} reachable (HTTP ${res.status}, ${ms}ms)` };
    }
    return { id: 'connectivity', title: 'API connectivity', severity: 'warn', detail: `${host} returned HTTP ${res.status} (${ms}ms)` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    return { id: 'connectivity', title: 'API connectivity', severity: 'warn', detail: `could not reach ${host}: ${reason}` };
  }
}

export async function checkAuth(apiUrl: string, apiKey: string): Promise<DoctorCheck> {
  // GET /v1/accounts/quota is a read-only endpoint that works with both admin
  // and agent-scoped keys — the right probe for "is this credential valid?".
  // Direct bounded fetch (not ApiClient.getQuota) so AbortSignal.timeout
  // actually aborts the in-flight request — a Promise.race against a timer
  // would leave the request hanging past the budget. Mirrors
  // checkConnectivity().
  let base: string;
  try {
    new URL(apiUrl);
    base = stripTrailingSlashes(apiUrl);
  } catch {
    return { id: 'auth', title: 'Auth validity', severity: 'skip', detail: 'invalid API URL' };
  }
  try {
    const res = await fetch(`${base}/v1/accounts/quota`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(networkTimeoutMs()),
    });
    if (res.ok) {
      return { id: 'auth', title: 'Auth validity', severity: 'ok', detail: 'API key accepted (GET /v1/accounts/quota)' };
    }
    if (res.status === 401 || res.status === 403) {
      // B1-2: on a 403, try to read the body so we can distinguish an
      // verification-gated key (valid key, incomplete signup) from a genuinely
      // rejected key. A 401 is always a bad key — no body read needed.
      if (res.status === 403) {
        let code: string | undefined;
        try {
          const body = (await res.json()) as { code?: unknown };
          code = typeof body.code === 'string' ? body.code : undefined;
        } catch {
          // non-JSON 403 — fall through to generic message
        }
        if (code === 'EMAIL_NOT_VERIFIED') {
          return {
            id: 'auth',
            title: 'Auth validity',
            severity: 'error',
            detail:
              'Email not verified — run `rly auth verify --code <code>` ' +
              '(or `auth resend --email <your-email>` for a new code).',
          };
        }
        if (code === 'PHONE_NOT_VERIFIED') {
          return {
            id: 'auth',
            title: 'Auth validity',
            severity: 'error',
            detail:
              'Phone not verified — run `rly auth verify-phone --code <code>` ' +
              '(or `rly auth resend-phone` for a new SMS code).',
          };
        }
      }
      return { id: 'auth', title: 'Auth validity', severity: 'error', detail: `API key rejected (HTTP ${res.status})` };
    }
    return { id: 'auth', title: 'Auth validity', severity: 'warn', detail: `could not verify (HTTP ${res.status})` };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      id: 'auth',
      title: 'Auth validity',
      severity: 'warn',
      detail: timedOut
        ? `could not verify (timed out after ${networkTimeoutMs()}ms)`
        : 'could not verify (network error)',
    };
  }
}

const SYMBOL: Record<CheckSeverity, string> = { ok: '✓', warn: '!', error: '✗', skip: '·' };

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((c) => `  ${SYMBOL[c.severity]} ${c.title}: ${c.detail}`);
  const errors = report.checks.filter((c) => c.severity === 'error').length;
  const warns = report.checks.filter((c) => c.severity === 'warn').length;
  const summary = report.ok
    ? warns
      ? `Doctor: no errors, ${warns} warning(s).`
      : 'Doctor: all checks passed.'
    : `Doctor: ${errors} error(s), ${warns} warning(s).`;
  return ['ReplyLayer CLI doctor', '', ...lines, '', summary].join('\n');
}

/**
 * `rly doctor [--json] [--offline]` (plan M2.6). Works unauthenticated.
 * Network checks are bounded and skipped under --offline / --skip-network.
 * Exits non-zero (EXIT.FAILURE) only when a check has `error` severity
 * (warnings do not fail the command).
 */
export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose CLI configuration, connectivity, and credentials')
    .option('--offline', 'Skip all network checks', false)
    .option('--skip-network', 'Alias for --offline', false)
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const local = cmd.opts();
      const resolved = resolveApiKey(opts.apiKey);
      const checks = buildLocalChecks({ apiUrl: opts.apiUrl, source: resolved.source });

      const offline = !!(local.offline || local.skipNetwork);
      if (offline) {
        checks.push({ id: 'connectivity', title: 'API connectivity', severity: 'skip', detail: 'skipped (--offline)' });
        checks.push({ id: 'auth', title: 'Auth validity', severity: 'skip', detail: 'skipped (--offline)' });
      } else {
        checks.push(await checkConnectivity(opts.apiUrl));
        checks.push(
          resolved.apiKey
            ? await checkAuth(opts.apiUrl, resolved.apiKey)
            : { id: 'auth', title: 'Auth validity', severity: 'skip', detail: 'no credential to verify' },
        );
      }

      const hasError = checks.some((c) => c.severity === 'error');
      const report: DoctorReport = { ok: !hasError, checks };
      output(report, formatDoctor(report), opts.json);
      if (hasError) process.exitCode = EXIT.FAILURE;
    });
}
