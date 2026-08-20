import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TenderlyClient } from '../tenderly/client.js';
import { formatSimulationLine } from '../tenderly/format.js';
import { runTool, textResult } from './common.js';

const TOOL = 'tenderly_list_simulations';

export function registerListSimulations(options: {
  server: McpServer;
  client: TenderlyClient;
  config: Config;
  logger: Logger;
}): void {
  const { server, client, config, logger } = options;

  server.registerTool(
    TOOL,
    {
      title: 'List recent saved simulations',
      description:
        'List recent saved simulations in the project, newest first, one line each — use it to find an id for tenderly_get_simulation.',
      inputSchema: {
        page: z.number().int().positive().optional().describe('1-based. Default 1.'),
        per_page: z.number().int().positive().max(100).optional().describe('Max 100. Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool({ tool: TOOL, logger, config }, async () => {
        const page = args.page ?? 1;
        const perPage = args.per_page ?? 20;
        logger.info('listing simulations', { tool: TOOL, page, perPage });

        const results = await client.listSimulations({ page, perPage });

        if (results.length === 0) {
          return textResult(
            `No saved simulations found in ${config.accountSlug}/${config.projectSlug}` +
              (page > 1
                ? ` on page ${String(page)}.`
                : '. Run a simulation with save=true to create one.')
          );
        }

        const lines = results.map((result) => formatSimulationLine(result, config));
        return textResult(
          [
            `# Saved simulations (page ${String(page)}, ${String(results.length)} shown)`,
            `Project: ${config.accountSlug}/${config.projectSlug}`,
            '',
            ...lines,
            '',
            'Pass a simulation id to tenderly_get_simulation for its full trace.',
          ].join('\n')
        );
      })
  );
}
