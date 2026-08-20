import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TenderlyClient } from '../tenderly/client.js';
import { buildDigest, formatSimulation } from '../tenderly/format.js';
import { appendRaw, OutputControlSchema, runTool, textResult, toFormatOptions } from './common.js';

const TOOL = 'tenderly_get_simulation';

export function registerGetSimulation(options: {
  server: McpServer;
  client: TenderlyClient;
  config: Config;
  logger: Logger;
}): void {
  const { server, client, config, logger } = options;

  server.registerTool(
    TOOL,
    {
      title: 'Fetch a saved simulation and its trace',
      description:
        'Retrieve a previously saved Tenderly simulation by id and render its logs, events and full call trace. ' +
        'Use this to re-examine a simulation without re-running it — to go deeper on a trace that was truncated, to pull the state diff that was omitted by default, or to inspect a simulation created earlier or from the Tenderly dashboard. ' +
        'The id is the UUID reported as "Simulation ID" by the simulate tools, and the one in a dashboard simulator URL.',
      inputSchema: {
        simulation_id: z
          .string()
          .min(1)
          .describe(
            'Simulation UUID, as returned by the simulate tools or seen in a dashboard URL.'
          ),
        ...OutputControlSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool({ tool: TOOL, logger, config }, async () => {
        const simulationId = args.simulation_id.trim();
        logger.info('fetching simulation', { tool: TOOL, simulationId });

        const response = await client.getSimulation(simulationId);

        let text = formatSimulation(
          response,
          config,
          toFormatOptions(args),
          `Saved simulation ${simulationId}`
        );
        if (args.include_raw_response === true) text = appendRaw(text, response);

        return { ...textResult(text), structuredContent: { ...buildDigest(response, config) } };
      })
  );
}
