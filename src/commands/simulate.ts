import { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { requireApiKey } from '../auth.js';
import { LocalCliError } from '../errors.js';
import { output } from '../format.js';

// First-party simulator MVP — `rly simulate inbound` injects a synthetic
// inbound message through the real ingestion + scanning pipeline (no
// stubbed scan result). New top-level namespace (no existing
// sandbox/dev-tools precedent to fold this into).

const SIMULATE_INBOUND_SCENARIOS = ['clean', 'prompt_injection_quarantined'] as const;

export function simulateCommand(): Command {
  const simulate = new Command('simulate').description('First-party simulator — test send/receive without real recipients');
  simulate.addCommand(inboundCommand());
  return simulate;
}

function inboundCommand(): Command {
  return new Command('inbound')
    .description('Inject a synthetic inbound message into a mailbox (real ingestion + scanning)')
    .requiredOption('--mailbox <id>', 'Mailbox name or UUID')
    .requiredOption(
      '--scenario <scenario>',
      `Scenario to inject (one of ${SIMULATE_INBOUND_SCENARIOS.join(', ')})`,
    )
    .option('--label <label>', 'Optional correlation label appended to the message subject')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const localOpts = cmd.opts();
      const scenario = localOpts.scenario as string;
      if (!(SIMULATE_INBOUND_SCENARIOS as readonly string[]).includes(scenario)) {
        throw new LocalCliError(
          `--scenario must be one of ${SIMULATE_INBOUND_SCENARIOS.join(', ')}`,
          'INVALID_OPTION',
          { option: 'scenario', value: scenario },
          2,
        );
      }
      const apiKey = requireApiKey(opts.apiKey);
      const client = new ApiClient({ baseUrl: opts.apiUrl, apiKey });
      const result = await client.injectSimulatorInbound({
        mailbox_id: localOpts.mailbox as string,
        scenario: scenario as (typeof SIMULATE_INBOUND_SCENARIOS)[number],
        ...(localOpts.label ? { label: localOpts.label as string } : {}),
      });

      let human: string;
      if (result.status === 'pending') {
        human = 'Status: pending — scanning had not finished within the poll window.\n' +
          'Check the mailbox with `rly inbox list` or `rly inbox wait` to see the final state.';
      } else {
        human = `Status: ${result.status}${result.message_id ? `\nMessage ID: ${result.message_id}` : ''}`;
      }
      output(result, human, opts.json);
    });
}
