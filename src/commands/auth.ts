import { Command } from 'commander';
import readline from 'node:readline';
import { ApiClient } from '../api-client.js';
import {
  resolveApiKey,
  storeApiKey,
  deleteCredentialFile,
  getCredentialFilePath,
  requireApiKey,
} from '../auth.js';
import { LocalCliError } from '../errors.js';
import { ApiError } from '../types.js';
import { output } from '../format.js';

export function authCommand(): Command {
  const auth = new Command('auth').description('Manage authentication');

  auth.addCommand(loginCommand());
  auth.addCommand(logoutCommand());
  auth.addCommand(rotateCommand());
  auth.addCommand(statusCommand());
  auth.addCommand(verifyCommand());
  auth.addCommand(resendCommand());
  auth.addCommand(verifyPhoneCommand());
  auth.addCommand(resendPhoneCommand());

  return auth;
}

function loginCommand(): Command {
  return new Command('login')
    .description('Store an API key for authentication')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      let apiKey: string;

      if (!process.stdin.isTTY) {
        // Reading from pipe/redirect
        apiKey = await readStdin();
      } else {
        apiKey = await promptApiKey();
      }

      apiKey = apiKey.trim();
      if (!apiKey) {
        throw new LocalCliError(
          'API key is required.',
          'API_KEY_REQUIRED',
        );
      }

      storeApiKey(apiKey);
      output(
        { stored: true, path: getCredentialFilePath() },
        `API key stored in ${getCredentialFilePath()}`,
        opts.json,
      );
    });
}

function logoutCommand(): Command {
  return new Command('logout')
    .description('Remove stored API key')
    .action((_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const deleted = deleteCredentialFile();
      if (deleted) {
        output(
          { deleted: true },
          `Removed credentials from ${getCredentialFilePath()}`,
          opts.json,
        );
        // UAT-20: logout only removes the LOCAL credential — the API key is
        // still valid server-side. Warn on stderr so --json/machine output
        // (driven by `output` above) stays clean. The credential-free revoke
        // path is the dashboard; `api-key revoke <id>` is a PURE revoke (no
        // replacement) but needs another admin credential since this logout
        // just removed the stored one. Do NOT present `auth rotate` as the
        // revoke path: rotate MINTS A REPLACEMENT key, so `rotate` then `logout`
        // revokes the old key but leaves the NEW key valid server-side while
        // deleting its only local copy — an orphaned, active, unreachable key.
        // (Nor can rotate run AFTER logout: it reads the now-deleted key.)
        if (!opts.json) {
          console.error('');
          console.error(
            'Note: this only removed the local credential — the API key is still ' +
              'valid server-side.',
          );
          console.error(
            'To revoke it, use the dashboard, or run `rly api-key revoke <key-id>` ' +
              'with another admin credential (this logout removed the stored key, so the CLI ' +
              'revoke must be given one via `--api-key <key>` or a fresh `auth login`).',
          );
          console.error(
            'Do NOT use `auth rotate` to revoke — rotate REPLACES the key with a new one, ' +
              'which this logout would then strand (old key revoked, but the new key left ' +
              'valid server-side and no longer stored locally).',
          );
        }
      } else {
        output(
          { deleted: false },
          'No credentials file found.',
          opts.json,
        );
      }
    });
}

// UAT-21: rotate is destructive (revokes the calling key) but its blast radius
// is narrow — ONLY the calling key. State that in the output, and offer a
// non-destructive `--dry-run` preview. Default behaviour is unchanged so
// existing scripts keep working (no TTY prompt that would break a pipe).
export const ROTATE_SCOPE_NOTE =
  'Scope: only the calling API key was revoked — other admin/agent keys on the account are unaffected.';

function rotateCommand(): Command {
  return new Command('rotate')
    .description('Rotate your API key (revokes ONLY the calling key, issues a new one)')
    .option('--dry-run', 'Show what rotate would do without revoking or issuing a key')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);

      if (localOpts.dryRun) {
        output(
          { dry_run: true, would_rotate: true },
          `Dry run: rotate would revoke ONLY the calling API key and issue a replacement, ` +
            `then store it in ${getCredentialFilePath()}.\n${ROTATE_SCOPE_NOTE}`,
          opts.json,
        );
        return;
      }

      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      const result = await client.rotateKey();
      storeApiKey(result.api_key);

      output(
        result,
        `New API key: ${result.api_key} (stored in ${getCredentialFilePath()})\n${ROTATE_SCOPE_NOTE}`,
        opts.json,
      );
    });
}

function statusCommand(): Command {
  return new Command('status')
    .description('Show authentication status')
    .action((_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const { apiKey, source } = resolveApiKey(opts.apiKey);

      const data = {
        authenticated: !!apiKey,
        source,
        key_preview: apiKey
          ? apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4)
          : null,
      };

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        if (apiKey) {
          console.log(`Authenticated: yes`);
          console.log(`Source: ${source}`);
          console.log(`Key: ${data.key_preview}`);
        } else {
          console.log('Authenticated: no');
          console.log(
            'Run `rly auth login` or set REPLYLAYER_API_KEY to authenticate.',
          );
        }
      }
    });
}

function verifyCommand(): Command {
  return new Command('verify')
    .description('Verify your email address with the code sent during signup')
    .requiredOption('--code <code>', '6-digit verification code')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });

      try {
        const result = await client.verifyEmail(localOpts.code);
        output(result, 'Email verified successfully.', opts.json);
      } catch (err) {
        // B1-2: on VERIFICATION_CODE_EXPIRED, guide the user to resend.
        if (err instanceof ApiError && err.code === 'VERIFICATION_CODE_EXPIRED') {
          if (!opts.json) {
            console.error(`Error: ${err.message}`);
            console.error(`Code: ${err.code}`);
            console.error('');
            console.error('Your verification code has expired (codes are valid for 10 minutes).');
            console.error('Request a new one: rly auth resend --email <your-email>');
          }
          throw err;
        }
        throw err;
      }
    });
}

function resendCommand(): Command {
  return new Command('resend')
    .description('Resend email verification code')
    .requiredOption('--email <email>', 'Email address to resend code to')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const client = new ApiClient({ baseUrl: opts.apiUrl });

      const result = await client.resendVerification(localOpts.email);
      if (opts.json) {
        output(result, result.message, opts.json);
      } else {
        // B1-2 / ONB-EC-13: surface the rate-limit and TTL constraints plainly so
        // users understand why they may get the same confirmation without a new
        // send, and that resend also clears a too-many-attempts lockout.
        console.log(result.message);
        console.log('');
        console.log(
          'Note: if your current code is still valid (codes last 10 minutes) you may get ' +
            'the same confirmation without a new email — check your spam folder. If you were ' +
            'locked out by too many wrong attempts, this also sends a fresh code and clears ' +
            'the lockout. You can resend up to 3 times per hour.',
        );
      }
    });
}

function verifyPhoneCommand(): Command {
  return new Command('verify-phone')
    .description('Verify your signup phone number with the SMS code')
    .requiredOption('--code <code>', '6-digit SMS verification code')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.verifyPhone(localOpts.code);
      output(result, 'Phone number verified successfully.', opts.json);
    });
}

function resendPhoneCommand(): Command {
  return new Command('resend-phone')
    .description('Resend the signup SMS verification code')
    .option('--phone <phone>', 'Correct the pending phone number before resending')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.resendPhoneVerification(localOpts.phone);
      output(
        result,
        `${result.message} Destination: ${result.phone_number_masked}.`,
        opts.json,
      );
    });
}

function promptApiKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question('API Key: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}
