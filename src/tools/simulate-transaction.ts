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

const TOOL = 'tenderly_simulate_transaction';

export function registerSimulateTransaction(options: {
  server: McpServer;
  client: TenderlyClient;
  config: Config;
  logger: Logger;
}): void {
  const { server, client, config, logger } = options;

  server.registerTool(
    TOOL,
    {
      title: 'Simulate an EVM transaction',
      description:
        'Simulate a single transaction against real forked chain state using Tenderly, without broadcasting it. ' +
        'Returns whether it would succeed or revert, gas used, the revert reason with a source-mapped stack trace where the contract is verified, decoded events, token transfers, and the full decoded call trace. ' +
        'Use this to answer "would this transaction work" and "why did it fail" before spending gas. ' +
        'Simulation runs at the latest block unless block_number is given, so it reflects current on-chain state.',
      inputSchema: {
        network: NetworkSchema,
        ...TransactionFieldsSchema,
        block_number: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Fork from this block. Omit to use the latest block.'),
        simulation_type: SimulationTypeSchema.optional(),
        state_overrides: StateOverridesSchema.optional(),
        save: z
          .boolean()
          .optional()
          .describe(
            'Persist the simulation to the Tenderly dashboard and return a shareable URL. Consumes free-tier stored-simulation quota. Defaults to the server TENDERLY_SAVE_SIMULATIONS setting (true unless configured otherwise).'
          ),
        ...OutputControlSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool({ tool: TOOL, logger, config }, async () => {
        const networkId = resolveNetworkArg(args.network);

        logger.info('simulating transaction', {
          tool: TOOL,
          networkId,
          to: args.to ?? '(deploy)',
          hasData: args.data !== undefined,
        });

        const response = await client.simulate(
          toSimulateParams({
            networkId,
            tx: args,
            blockNumber: args.block_number,
            save: args.save,
            simulationType: args.simulation_type,
            stateOverrides: args.state_overrides,
          })
        );

        let text = formatSimulation(response, config, toFormatOptions(args));
        if (args.include_raw_response === true) text = appendRaw(text, response);

        return { ...textResult(text), structuredContent: { ...buildDigest(response, config) } };
      })
  );
}
