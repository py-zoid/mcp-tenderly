import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TenderlyClient } from '../tenderly/client.js';
import { registerGetSimulation } from './get-simulation.js';
import { registerListSimulations } from './list-simulations.js';
import { registerSimulateBundle } from './simulate-bundle.js';
import { registerSimulateTransaction } from './simulate-transaction.js';

export interface ToolDeps {
  server: McpServer;
  client: TenderlyClient;
  config: Config;
  logger: Logger;
}

/**
 * Registers every tool. Kept small and explicit rather than auto-discovered:
 * the set is the server's public contract, and it should be readable in one
 * place without running anything.
 */
export function registerTools(deps: ToolDeps): void {
  registerSimulateTransaction(deps);
  registerSimulateBundle(deps);
  registerGetSimulation(deps);
  registerListSimulations(deps);
}
