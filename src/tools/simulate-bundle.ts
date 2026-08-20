import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TenderlyClient } from '../tenderly/client.js';
import { buildDigest, formatSimulation } from '../tenderly/format.js';
import {
  appendRaw,
  NetworkSchema,
  OutputControlSchema,
  resolveNetworkArg,
  runTool,
  SimulationTypeSchema,
  StateOverridesSchema,
  textResult,
  toFormatOptions,
  toSimulateParams,
  TransactionFieldsSchema,
} from './common.js';

const TOOL = 'tenderly_simulate_bundle';
const MAX_BUNDLE = 20;

export function registerSimulateBundle(options: {
  server: McpServer;
  client: TenderlyClient;
  config: Config;
  logger: Logger;
}): void {
  const { server, client, config, logger } = options;

  server.registerTool(
    TOOL,
    {
      title: 'Simulate a sequence of EVM transactions',
      description:
        'Simulate several transactions in order against shared state, so each one sees the effects of the ones before it. ' +
        'This is the tool for multi-step flows that cannot be checked one transaction at a time: approve then swap, deploy then initialise, or reproducing an exploit sequence. ' +
        'Every transaction gets its own outcome, gas figure and call trace, and the run reports which step in the sequence broke.',
      inputSchema: {
        network: NetworkSchema,
        transactions: z
          .array(z.object(TransactionFieldsSchema))
          .min(1)
          .max(MAX_BUNDLE)
          .describe(
            `Transactions to run in order, sharing state. Between 1 and ${String(MAX_BUNDLE)} entries.`
          ),
        block_number: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Fork from this block. Omit to use the latest block.'),
        simulation_type: SimulationTypeSchema.optional(),
        state_overrides: StateOverridesSchema.optional().describe(
          'Account state overrides applied before the first transaction, keyed by address.'
        ),
        save: z
          .boolean()
          .optional()
          .describe(
            'Persist each simulation to the dashboard. Consumes free-tier quota per transaction.'
          ),
        ...OutputControlSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool({ tool: TOOL, logger, config }, async () => {
        const networkId = resolveNetworkArg(args.network);

        logger.info('simulating bundle', {
          tool: TOOL,
          networkId,
          count: args.transactions.length,
        });

        const results = await client.simulateBundle(
          args.transactions.map((tx) =>
            toSimulateParams({
              networkId,
              tx,
              blockNumber: args.block_number,
              save: args.save,
              simulationType: args.simulation_type,
              stateOverrides: args.state_overrides,
            })
          )
        );

        if (results.length === 0) {
          return textResult(
            'Tenderly accepted the bundle but returned no results. This usually means the request was rejected upstream without an error body — re-run with include_raw_response=true.'
          );
        }

        const digests = results.map((r) => buildDigest(r, config));
        const firstFailure = digests.findIndex((d) => d.status !== 'success');

        const header = [
          `# Bundle: ${String(results.length)} transaction(s)`,
          firstFailure === -1
            ? 'All transactions succeeded ✅'
            : `First failure at transaction ${String(firstFailure + 1)} of ${String(results.length)} ❌ — transactions after it ran against the state that failure left behind, so treat their results as suspect.`,
        ].join('\n');

        const bodies = results.map((result, index) =>
          formatSimulation(
            result,
            config,
            toFormatOptions(args),
            `Transaction ${String(index + 1)} of ${String(results.length)}`
          )
        );

        let text = [header, ...bodies].join('\n\n---\n\n');
        if (args.include_raw_response === true) text = appendRaw(text, results);

        return {
          ...textResult(text),
          structuredContent: {
            transaction_count: results.length,
            first_failure_index: firstFailure === -1 ? null : firstFailure,
            all_succeeded: firstFailure === -1,
            results: digests,
          },
        };
      })
  );
}
