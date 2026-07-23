import { Command } from 'commander';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveApiKey, getCredentialFilePath, type KeySource } from '../auth.js';
import { redactUrlCredentials, redactCredentialList } from '../redact.js';
import { output } from '../format.js';

export interface ConfigReport {
  api_url: string;
  /** Where the API key would resolve from — NEVER the key value itself. */
  credential_source: KeySource;
  config_dir: string;
  legacy_credential_file: { path: string; present: boolean };
  env: {
    REPLYLAYER_API_URL: boolean;
    REPLYLAYER_MAILBOX: boolean;
    HTTPS_PROXY: string | null;
    HTTP_PROXY: string | null;
    NO_PROXY: string | null;
    NODE_EXTRA_CA_CERTS: string | null;
  };
}

/**
 * Build the effective-config report. No authentication or network access —
 * only the resolution SOURCE is reported, never the key. Proxy env values are
 * credential-redacted; the API key never appears.
 */
export function buildConfigReport(
  opts: { apiUrl: string; apiKey?: string },
  env: NodeJS.ProcessEnv = process.env,
): ConfigReport {
  const credPath = getCredentialFilePath();
  const proxyOrNull = (v: string | undefined) =>
    v ? redactUrlCredentials(v) : null;
  return {
    api_url: opts.apiUrl,
    credential_source: resolveApiKey(opts.apiKey).source,
    config_dir: path.join(os.homedir(), '.replylayer'),
    legacy_credential_file: { path: credPath, present: existsSync(credPath) },
    env: {
      REPLYLAYER_API_URL: !!env.REPLYLAYER_API_URL,
      REPLYLAYER_MAILBOX: !!env.REPLYLAYER_MAILBOX,
      HTTPS_PROXY: proxyOrNull(env.HTTPS_PROXY ?? env.https_proxy),
      HTTP_PROXY: proxyOrNull(env.HTTP_PROXY ?? env.http_proxy),
      // NO_PROXY is a host list, but fail-closed: redact any entry that
      // carries userinfo (uncommon, but never echo a secret).
      NO_PROXY: redactCredentialList(env.NO_PROXY ?? env.no_proxy),
      // NODE_EXTRA_CA_CERTS is a filesystem path, not a credential URL — show
      // it verbatim so operators can confirm which CA bundle is in effect.
      NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? null,
    },
  };
}

export function formatConfigReport(r: ConfigReport): string {
  const yn = (b: boolean) => (b ? 'set' : 'unset');
  const lines = [
    'ReplyLayer CLI configuration',
    '',
    `API URL:           ${r.api_url}`,
    `Credential source: ${r.credential_source}`,
    `Config directory:  ${r.config_dir}`,
    `Credential file:   ${r.legacy_credential_file.path} (${r.legacy_credential_file.present ? 'present' : 'absent'})`,
    '',
    'Environment',
    `  REPLYLAYER_API_URL:  ${yn(r.env.REPLYLAYER_API_URL)}`,
    `  REPLYLAYER_MAILBOX:  ${yn(r.env.REPLYLAYER_MAILBOX)}`,
    `  HTTPS_PROXY:         ${r.env.HTTPS_PROXY ?? 'unset'}`,
    `  HTTP_PROXY:          ${r.env.HTTP_PROXY ?? 'unset'}`,
    `  NO_PROXY:            ${r.env.NO_PROXY ?? 'unset'}`,
    `  NODE_EXTRA_CA_CERTS: ${r.env.NODE_EXTRA_CA_CERTS ?? 'unset'}`,
  ];
  return lines.join('\n');
}

/**
 * `rly config show [--json]` (plan M2.5). Local-only; no auth.
 */
export function configCommand(): Command {
  const config = new Command('config').description(
    'Inspect CLI configuration',
  );

  config.addCommand(
    new Command('show')
      .description('Show effective CLI configuration (no auth, no network)')
      .action((_opts, cmd) => {
        const opts = cmd.optsWithGlobals();
        const report = buildConfigReport({
          apiUrl: opts.apiUrl,
          apiKey: opts.apiKey,
        });
        output(report, formatConfigReport(report), opts.json);
      }),
  );

  return config;
}
