import { Command } from 'commander';
import type { CreateDomainRequest } from '../protocol.js';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { formatTable, output } from '../format.js';
import { ensureConfirmed } from '../lib/confirm.js';
import { readSecrets } from '../lib/secret-input.js';

type DomainCreateOptions = {
  transport?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecurity?: 'starttls' | 'tls';
  smtpUsername?: string;
  smtpPasswordStdin?: boolean;
  imapHost?: string;
  imapPort?: string;
  imapSecurity?: 'starttls' | 'tls';
  imapUsername?: string;
  imapPasswordStdin?: boolean;
  networkMode?: string;
};

function normalizeTransportMode(
  transport?: string,
): 'mailgun' | 'self_hosted' | null {
  if (!transport) return 'mailgun';
  if (transport === 'mailgun') return 'mailgun';
  if (transport === 'self-hosted' || transport === 'self_hosted') {
    return 'self_hosted';
  }
  return null;
}

function requireOption(value: string | undefined, flag: string): string {
  if (value) return value;
  throw new LocalCliError(
    `${flag} is required when --transport self-hosted`,
    'INVALID_OPTION',
    { option: flag },
    2,
  );
}

function parsePort(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new LocalCliError(
      `${flag} must be an integer between 1 and 65535`,
      'INVALID_OPTION',
      { option: flag, value },
      2,
    );
  }
  return parsed;
}

function formatDomainInspect(domain: Record<string, unknown>): string {
  const lines = [
    `ID: ${String(domain.id)}`,
    `Domain: ${String(domain.domain_name)}`,
    `Type: ${String(domain.domain_type)}`,
    `Transport: ${String(domain.transport_mode)}`,
    `Status: ${String(domain.verification_status)}`,
    `Default: ${domain.is_default ? 'yes' : 'no'}`,
  ];

  if (domain.admin_review_status) {
    lines.push(`Admin Review: ${String(domain.admin_review_status)}`);
  }
  if (domain.created_at) {
    lines.push(`Created: ${String(domain.created_at)}`);
  }
  if (domain.verified_at) {
    lines.push(`Verified: ${String(domain.verified_at)}`);
  }

  return lines.join('\n');
}

export function domainCommand(): Command {
  const domain = new Command('domain').description('Manage domains');

  domain.addCommand(createCommand());
  domain.addCommand(listCommand());
  domain.addCommand(inspectCommand());
  domain.addCommand(verifyCommand());
  // G10 — domain lifecycle mutations.
  domain.addCommand(setConfigCommand());
  domain.addCommand(setDefaultCommand());
  domain.addCommand(recheckCommand());
  domain.addCommand(deleteDomainCommand());

  return domain;
}

// G10 — update the self-hosted SMTP/IMAP config. Passwords are NEVER accepted
// on argv (no --smtp-password flag — that is the `domain create` smell); with
// --smtp-password-stdin / --imap-password-stdin the secret is read from a
// no-echo TTY prompt, or as ordered lines (SMTP then IMAP) when stdin is piped.
function setConfigCommand(): Command {
  return new Command('set-config')
    .description('Update the self-hosted SMTP/IMAP config for a domain (secrets via no-echo prompt or piped stdin, never argv)')
    .argument('<id>', 'Domain id')
    .option('--smtp-host <host>', 'SMTP hostname')
    .option('--smtp-port <port>', 'SMTP port')
    .option('--smtp-security <mode>', 'SMTP security: starttls or tls')
    .option('--smtp-username <username>', 'SMTP username')
    .option('--smtp-password-stdin', 'Read the SMTP password from a no-echo prompt / piped stdin')
    .option('--imap-host <host>', 'IMAP hostname')
    .option('--imap-port <port>', 'IMAP port')
    .option('--imap-security <mode>', 'IMAP security: starttls or tls')
    .option('--imap-username <username>', 'IMAP username')
    .option('--imap-password-stdin', 'Read the IMAP password from a no-echo prompt / piped stdin')
    .option('--network-mode <mode>', 'Network mode (e.g. public)')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts() as Record<string, string | boolean | undefined>;

      const smtp: Record<string, unknown> = {};
      if (localOpts.smtpHost) smtp.host = localOpts.smtpHost;
      if (localOpts.smtpPort) smtp.port = parsePort(localOpts.smtpPort as string, '--smtp-port');
      if (localOpts.smtpSecurity) smtp.security = requireSecurity(localOpts.smtpSecurity as string, '--smtp-security');
      if (localOpts.smtpUsername) smtp.username = localOpts.smtpUsername;

      const imap: Record<string, unknown> = {};
      if (localOpts.imapHost) imap.host = localOpts.imapHost;
      if (localOpts.imapPort) imap.port = parsePort(localOpts.imapPort as string, '--imap-port');
      if (localOpts.imapSecurity) imap.security = requireSecurity(localOpts.imapSecurity as string, '--imap-security');
      if (localOpts.imapUsername) imap.username = localOpts.imapUsername;

      const wants: Array<'smtp' | 'imap'> = [];
      if (localOpts.smtpPasswordStdin) wants.push('smtp');
      if (localOpts.imapPasswordStdin) wants.push('imap');

      // Usage check (no secret read, no network) BEFORE the confirm gate.
      if (Object.keys(smtp).length === 0 && Object.keys(imap).length === 0 && !localOpts.networkMode && wants.length === 0) {
        throw new LocalCliError('at least one config field is required (an smtp/imap field or --network-mode)', 'INVALID_OPTION', {}, 2);
      }

      // The confirm gate runs BEFORE any prompt or secret read — so `--json`
      // without --confirm returns CONFIRM_REQUIRED before we ever prompt for or
      // consume SMTP/IMAP credentials (machine-contract requirement).
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Update self-hosted config for domain ${id}? Type "yes": `);

      // Read secrets (ordered SMTP then IMAP) only AFTER confirmation.
      if (wants.length > 0) {
        const secrets = await readSecrets(wants.map((w) => (w === 'smtp' ? 'SMTP password' : 'IMAP password')));
        wants.forEach((w, i) => {
          if (w === 'smtp') smtp.password = secrets[i];
          else imap.password = secrets[i];
        });
      }

      const body: { smtp?: Record<string, unknown>; imap?: Record<string, unknown>; network_mode?: string } = {};
      if (Object.keys(smtp).length > 0) body.smtp = smtp;
      if (Object.keys(imap).length > 0) body.imap = imap;
      if (localOpts.networkMode) body.network_mode = localOpts.networkMode as string;

      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.setSelfHostedConfig(id, body);
      output(result, `Updated self-hosted config for domain ${id}.`, opts.json);
    });
}

function requireSecurity(value: string, flag: string): 'starttls' | 'tls' {
  if (value !== 'starttls' && value !== 'tls') {
    throw new LocalCliError(`${flag} must be 'starttls' or 'tls'`, 'INVALID_OPTION', { option: flag, value }, 2);
  }
  return value;
}

function setDefaultCommand(): Command {
  return new Command('set-default')
    .description('Set this domain as the account default sending domain')
    .argument('<id>', 'Domain id')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Set domain ${id} as the default sending domain? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.setDefaultDomain(id);
      output(result, `Set domain ${id} as the default sending domain.`, opts.json);
    });
}

function recheckCommand(): Command {
  return new Command('recheck')
    .description('Force a fresh self-hosted SMTP/IMAP verification probe')
    .argument('<id>', 'Domain id')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.recheckDomain(id);
      output(result, `Triggered a self-hosted recheck for domain ${id}.`, opts.json);
    });
}

function deleteDomainCommand(): Command {
  return new Command('delete')
    .description('Delete a delegated domain')
    .argument('<id>', 'Domain id')
    .option('--confirm', 'Skip the confirmation prompt')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      await ensureConfirmed(opts.json, !!localOpts.confirm, `Delete domain ${id}? Type "yes": `);
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.deleteDomain(id);
      output(result, `Deleted domain ${id}.`, opts.json);
    });
}

function createCommand(): Command {
  return new Command('create')
    .description('Create a new domain')
    .argument('<domain>', 'Domain to register')
    .option('--transport <mode>', 'Transport mode: "mailgun" (fully managed by ReplyLayer, default) or "self-hosted" (your own SMTP/IMAP)')
    .option('--smtp-host <host>', 'Self-hosted SMTP hostname')
    .option('--smtp-port <port>', 'Self-hosted SMTP port')
    .option('--smtp-security <mode>', 'Self-hosted SMTP security: starttls or tls')
    .option('--smtp-username <username>', 'Self-hosted SMTP username')
    .option('--smtp-password-stdin', 'Read the SMTP password from a no-echo prompt / piped stdin')
    .option('--imap-host <host>', 'Self-hosted IMAP hostname')
    .option('--imap-port <port>', 'Self-hosted IMAP port')
    .option('--imap-security <mode>', 'Self-hosted IMAP security: starttls or tls')
    .option('--imap-username <username>', 'Self-hosted IMAP username')
    .option('--imap-password-stdin', 'Read the IMAP password from a no-echo prompt / piped stdin')
    .option('--network-mode <mode>', 'Self-hosted network mode', 'public')
    .action(async (domainName: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts() as DomainCreateOptions;
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const transportMode = normalizeTransportMode(localOpts.transport);
      if (!transportMode) {
        throw new LocalCliError(
          '--transport must be "mailgun" or "self-hosted"',
          'INVALID_OPTION',
          { option: '--transport', value: localOpts.transport },
          2,
        );
      }

      const body: CreateDomainRequest = { domain: domainName };
      if (localOpts.transport) {
        body.transport_mode = transportMode;
      }

      if (transportMode === 'self_hosted') {
        // Validate all non-secret fields (transport/host/port/security/username)
        // BEFORE reading any secret, so a malformed invocation fails network-free
        // and prompt-free. Secrets are NEVER accepted on argv (RL-UAT-029): each
        // role requires its --*-password-stdin flag, mirroring `set-config`.
        const smtpSecurity = requireOption(localOpts.smtpSecurity, '--smtp-security') as 'starttls' | 'tls';
        const imapSecurity = requireOption(localOpts.imapSecurity, '--imap-security') as 'starttls' | 'tls';

        const smtp: {
          host: string;
          port: number;
          security: 'starttls' | 'tls';
          username: string;
          password: string;
        } = {
          host: requireOption(localOpts.smtpHost, '--smtp-host'),
          port: parsePort(requireOption(localOpts.smtpPort, '--smtp-port'), '--smtp-port'),
          security: smtpSecurity,
          username: requireOption(localOpts.smtpUsername, '--smtp-username'),
          password: '',
        };
        const imap: {
          host: string;
          port: number;
          security: 'starttls' | 'tls';
          username: string;
          password: string;
        } = {
          host: requireOption(localOpts.imapHost, '--imap-host'),
          port: parsePort(requireOption(localOpts.imapPort, '--imap-port'), '--imap-port'),
          security: imapSecurity,
          username: requireOption(localOpts.imapUsername, '--imap-username'),
          password: '',
        };

        // Per-role required validation. The -stdin flag is required for each
        // role of a self-hosted transport, so both-missing stays INVALID_OPTION
        // (preserving today's `requireOption` required-ness at the password sites).
        const wants: Array<'smtp' | 'imap'> = [];
        if (localOpts.smtpPasswordStdin) {
          wants.push('smtp');
        } else {
          throw new LocalCliError(
            '--smtp-password-stdin is required when --transport self-hosted',
            'INVALID_OPTION',
            { option: '--smtp-password-stdin' },
            2,
          );
        }
        if (localOpts.imapPasswordStdin) {
          wants.push('imap');
        } else {
          throw new LocalCliError(
            '--imap-password-stdin is required when --transport self-hosted',
            'INVALID_OPTION',
            { option: '--imap-password-stdin' },
            2,
          );
        }

        // Read secrets (ordered SMTP then IMAP) only AFTER all usage validation.
        const secrets = await readSecrets(
          wants.map((w) => (w === 'smtp' ? 'SMTP password' : 'IMAP password')),
        );
        wants.forEach((w, i) => {
          if (w === 'smtp') smtp.password = secrets[i]!;
          else imap.password = secrets[i]!;
        });

        body.transport_mode = 'self_hosted';
        body.self_hosted_config = {
          network_mode: (localOpts.networkMode ?? 'public') as 'public' | 'tailnet',
          smtp,
          imap,
        };
      }

      const result = await client.createDomain(body);
      output(
        result,
        `Created domain: ${result.domain_name} (${result.transport_mode})`,
        opts.json,
      );
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List all domains')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.listDomains();
      const table = formatTable(
        ['DOMAIN', 'TRANSPORT', 'STATUS', 'DEFAULT', 'CREATED'],
        result.domains.map((domain) => [
          String(domain.domain_name),
          String(domain.transport_mode),
          String(domain.verification_status),
          domain.is_default ? 'yes' : '',
          String(domain.created_at ?? ''),
        ]),
      );

      output(result, table, opts.json);
    });
}

function inspectCommand(): Command {
  return new Command('inspect')
    .description('Inspect a domain')
    .argument('<id>', 'Domain id')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.getDomain(id);
      output(result, formatDomainInspect(result), opts.json);
    });
}

function verifyCommand(): Command {
  return new Command('verify')
    .description('Trigger a domain verification check')
    .argument('<id>', 'Domain id')
    .action(async (id: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.verifyDomain(id);
      output(
        result,
        `Verification status: ${result.verification_status}${result.message ? ` — ${result.message}` : ''}`,
        opts.json,
      );
    });
}
