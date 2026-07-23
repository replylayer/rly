import readline from 'node:readline';
import { LocalCliError } from '../errors.js';

/**
 * Shared --confirm gate for egress-/credential-mutating verbs (webhook G8,
 * domain G10). In --json mode without --confirm, fail closed with
 * CONFIRM_REQUIRED *before* any prompt is created (so an agent piping to jq
 * never sees a prompt string on stderr). Interactively, require a typed "yes".
 */
export async function ensureConfirmed(json: boolean, confirmed: boolean, promptText: string): Promise<void> {
  if (json && !confirmed) {
    throw new LocalCliError(
      'This action requires --confirm in --json mode (cannot prompt interactively)',
      'CONFIRM_REQUIRED',
      undefined,
      1,
    );
  }
  if (!confirmed) {
    const answer = await promptStderr(promptText);
    if (answer.trim().toLowerCase() !== 'yes') {
      throw new LocalCliError('Aborted', 'USER_ABORTED', undefined, 130);
    }
  }
}

function promptStderr(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(message, (a) => {
      rl.close();
      resolve(a);
    });
  });
}
