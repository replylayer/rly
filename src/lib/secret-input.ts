import readline from 'node:readline';
import { LocalCliError } from '../errors.js';

/**
 * Read N secrets WITHOUT echoing them — secrets are NEVER taken from argv
 * (they would leak to shell history and `ps`).
 *
 * - On a TTY: prompt each `label` with terminal echo suppressed.
 * - When stdin is piped (non-TTY): read ordered lines, one per requested secret
 *   in the given order; fail closed if a line is missing.
 *
 * `input`/`isTty` are injectable for testing the piped path deterministically.
 */
export async function readSecrets(
  labels: string[],
  opts: { isTty?: boolean; input?: NodeJS.ReadableStream } = {},
): Promise<string[]> {
  const input = opts.input ?? process.stdin;
  const isTty = opts.isTty ?? Boolean((input as NodeJS.ReadStream).isTTY);

  if (isTty) {
    const out: string[] = [];
    for (const label of labels) {
      out.push(await readSecretNoEcho(`${label}: `, input as NodeJS.ReadStream));
    }
    return out;
  }

  const data = await readAll(input);
  const lines = data.split(/\r?\n/);
  return labels.map((label, i) => {
    const line = lines[i];
    if (line === undefined || line.length === 0) {
      throw new LocalCliError(
        `missing piped secret for ${label} (expected ${labels.length} ordered secret line(s), one per --*-password-stdin flag, in request order)`,
        'INVALID_OPTION',
        { secret: label },
        2,
      );
    }
    return line;
  });
}

function readSecretNoEcho(promptText: string, input: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: process.stderr, terminal: true });
    // Suppress echo of typed characters (password entry). readline calls
    // `_writeToOutput` for every keystroke echo; making it a no-op hides the
    // secret. The prompt + the terminating newline are written manually.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stderr.write(promptText);
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

function readAll(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    input.setEncoding('utf-8');
    input.on('data', (c) => {
      data += c;
    });
    input.on('end', () => resolve(data));
  });
}
