import { Command } from 'commander';
import readline from 'node:readline';
// CLI-local copy — see `lib/web-risk-acceptance.ts` for why we don't
// import these runtime values from the private monorepo (it's not a
// runtime dependency of the published CLI, so a runtime import here
// would crash on startup of an installed CLI binary). A drift guard
// test keeps the local copy in lockstep with the canonical source.
import {
  CURRENT_URL_REPUTATION_DISCLAIMER_VERSION,
  WEB_RISK_NOTICE,
} from '../lib/web-risk-acceptance.js';
import { LEGAL_ASSENT_REQUIRED_MESSAGE } from '../lib/legal-assent-copy.js';
import { ApiClient } from '../api-client.js';
import { storeApiKey, getCredentialFilePath } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { output } from '../format.js';
import { ApiError } from '../types.js';

export function signupCommand(): Command {
  return new Command('signup')
    .description('Create a new ReplyLayer account')
    .option('--email <email>', 'Email address for the account')
    .option('--phone <phone>', 'Mobile phone number with country code (for example, +13125550123)')
    .option(
      '--accept-terms',
      'Agree to the Terms of Service (which incorporate the Acceptable Use Policy and, where applicable, the Data Processing Agreement) and acknowledge the Privacy Policy',
    )
    .option(
      '--accept-web-risk',
      'Record an explicit acknowledgement of the URL-reputation disclosure (Google Web Risk subprocessor, imperfect protection). Optional: without it, URL reputation is still enabled by default under the Privacy Policy §7a signup disclosure.',
    )
    .option('--invite-code <code>', 'Invite code (required during invite-only period)')
    .option(
      '--cli-signup-code <code>',
      'Dashboard-issued CLI signup code (rls_cli_…) for bootstrapping a SEPARATE account. Required at public launch — mint one from the dashboard.',
    )
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      let email = localOpts.email as string | undefined;
      let phone = localOpts.phone as string | undefined;

      if (!email) {
        email = await promptEmail();
      }

      // --- Auto-route + conflict guard ---
      // The `rls_cli_` prefix is unambiguous. If a user passes a rls_cli_…
      // value to --invite-code, route it to cli_signup_code automatically so
      // the single flag users reach for "just works" with a dashboard code.
      // Both flags supplied with conflicting kinds → fail fast before any
      // network call.
      let resolvedInviteCode: string | undefined = localOpts.inviteCode as string | undefined;
      let resolvedCliSignupCode: string | undefined = localOpts.cliSignupCode as string | undefined;

      if (resolvedInviteCode?.startsWith('rls_cli_')) {
        if (resolvedCliSignupCode) {
          // Both --invite-code rls_cli_… AND --cli-signup-code supplied — conflict.
          throw new LocalCliError(
            'Conflicting signup codes: --invite-code has a dashboard-issued code (rls_cli_…) but --cli-signup-code was also supplied. Pass only --cli-signup-code.',
            'SIGNUP_CODE_CONFLICT',
          );
        }
        // Auto-route: treat the rls_cli_… value from --invite-code as the cli-signup-code.
        resolvedCliSignupCode = resolvedInviteCode;
        resolvedInviteCode = undefined;
      }

      if (!localOpts.acceptTerms) {
        // Preserve the multi-line URL block in human-readable output —
        // the URLs are part of the error-as-instruction UX. JSON mode
        // suppresses these and emits the structured code in the catch
        // block (so scripted callers don't get free-form stderr text
        // alongside JSON).
        if (!opts.json) {
          // Canonical hierarchy message from the generated mirror — one
          // affirmative action: ToS agreement (incorporating the AUP and
          // applicable DPA) + Privacy acknowledgement. All four documents
          // stay individually reviewable below.
          console.error(LEGAL_ASSENT_REQUIRED_MESSAGE);
          console.error('');
          console.error('Review them at:');
          console.error('  Terms of Service:          https://app.replylayer.ai/legal/terms');
          console.error('  Privacy Policy:            https://app.replylayer.ai/legal/privacy');
          console.error('  Acceptable Use Policy:     https://app.replylayer.ai/legal/acceptable-use');
          console.error('  Data Processing Agreement: https://app.replylayer.ai/legal/dpa');
          console.error('');
          console.error('Then re-run with: rly signup --accept-terms');
        }
        throw new LocalCliError(
          LEGAL_ASSENT_REQUIRED_MESSAGE,
          'TERMS_NOT_ACCEPTED',
        );
      }

      // Print the URL-reputation disclosure BEFORE the network call so the
      // notice is visible in the terminal session (scripted callers get it
      // in their logs). Web Risk ToS requires the notice to be shown prior
      // to signup; JSON mode suppresses it (structured-output contract —
      // the default-on behavior is documented in the option help and
      // CLI_GUIDE, and state is readable via
      // `rly account link-scanning status`).
      if (!opts.json) {
        console.error('URL reputation disclosure:');
        console.error(`  ${WEB_RISK_NOTICE}`);
        console.error('');
        console.error('Malicious link scanning is enabled by default under the Privacy Policy (§7a).');
        console.error('Pass --accept-web-risk to record an explicit acknowledgement, or turn it off');
        console.error('per mailbox later with the mailbox scanner policy.');
        console.error('');
      }

      if (!phone) {
        phone = await promptPhone();
      }

      const client = new ApiClient({ baseUrl: opts.apiUrl });

      let result;
      try {
        // Send the disclaimer version ONLY on an explicit --accept-web-risk:
        // a supplied version is an affirmative acknowledgement claim, and the
        // server records its provenance ('explicit'). Omission lets the
        // server's signup-disclosure default apply ('signup_default') — the
        // CLI must never claim an acknowledgement the user didn't make.
        result = await client.signup(
          email,
          phone,
          resolvedInviteCode,
          localOpts.acceptWebRisk ? CURRENT_URL_REPUTATION_DISCLAIMER_VERSION : undefined,
          resolvedCliSignupCode,
        );
      } catch (err) {
        // Error-as-instruction: CLI_SIGNUP_CODE_REQUIRED / CLI_SIGNUP_CODE_INVALID
        // route through the same human-mode stderr pattern as the terms/web-risk
        // gates above, suppressed under --json (the JSON consumer gets the
        // structured ApiError code from the outer catch in run()).
        if (err instanceof ApiError) {
          if (err.code === 'CLI_SIGNUP_CODE_REQUIRED' && !opts.json) {
            console.error('CLI signup needs a dashboard-issued code.');
            console.error('New to ReplyLayer? Create your first account at https://app.replylayer.ai/signup');
            console.error('Already have an account? Sign in at https://app.replylayer.ai, then generate a CLI signup code.');
            console.error('Re-run with: rly signup --cli-signup-code rls_cli_…');
          } else if (err.code === 'CLI_SIGNUP_CODE_INVALID' && !opts.json) {
            console.error('That code is expired or already used (30-min, single-use).');
            console.error('Generate a fresh one from https://app.replylayer.ai');
          }
        }
        throw err;
      }

      storeApiKey(result.api_key);

      const lines = [`Account created. Your API key: ${result.api_key} (stored in ${getCredentialFilePath()})`];
      if (result.verification_required) {
        lines.push('');
        lines.push(`A verification code was sent to ${email}.`);
        lines.push('Run: rly auth verify --code <6-digit-code>');
      }
      if (result.phone_verification_required) {
        lines.push('');
        if (result.sms_delivery_status === 'sent') {
          lines.push(`An SMS verification code was sent to ${result.phone_number_masked ?? 'your phone'}.`);
        } else {
          lines.push('The SMS code could not be sent yet. Retry with: rly auth resend-phone');
        }
        lines.push('Run: rly auth verify-phone --code <6-digit-code>');
      }

      output(result, lines.join('\n'), opts.json);
    });
}

function promptEmail(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question('Email: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new Error('Email is required'));
      } else {
        resolve(trimmed);
      }
    });
  });
}

function promptPhone(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question('Mobile phone (include country code): ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new Error('Mobile phone number is required'));
      } else {
        resolve(trimmed);
      }
    });
  });
}
