/**
 * Server assembly: wires config, logger, client and tools together.
 *
 * Split from `index.ts` so the whole server can be constructed in a test or an
 * alternative host without going near `process.argv`, stdio or signals.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { TenderlyClient, type FetchLike } from './tenderly/client.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'mcp-tenderly';
export const SERVER_VERSION = '0.1.0';

export interface BuildServerOptions {
  config: Config;
  logger?: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface BuiltServer {
  server: McpServer;
  logger: Logger;
  client: TenderlyClient;
}

export function buildServer(options: BuildServerOptions): BuiltServer {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tenderly transaction simulation and trace debugging for EVM chains. Simulations run against real forked state at the latest block and never broadcast, so they are safe to run freely. ' +
        'On a revert, the reason and failing frame are reported first; ask for include_state_diff when a storage write is what matters.',
    }
  );

  const client = new TenderlyClient({
    config,
    logger,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  registerTools({ server, client, config, logger });

  return { server, logger, client };
}
