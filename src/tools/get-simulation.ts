import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { describeError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { TenderlyClient } from '../tenderly/client.js';
import { buildDigest, formatSimulation } from '../tenderly/format.js';
import type { SimulateResponse } from '../tenderly/schemas.js';
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
      title: 'Inspect a saved simulation, with its trace',
      description:
        'Look up a saved Tenderly simulation by id and render its outcome and full call trace. ' +
        'Use this to re-examine a simulation you already ran — to go deeper on a trace that was truncated, to pull the state diff that is omitted by default, or to inspect one created earlier or from the Tenderly dashboard. ' +
        "Note that Tenderly's saved-simulation record stores only metadata (inputs, gas, status, error), not the trace; the trace is therefore reproduced by replaying the recorded inputs at the recorded block, which is faithful but costs one simulation against your rate limit. " +
        'Pass reconstruct_trace=false for a cheap metadata-only lookup. ' +
        'The id is the UUID reported as "Simulation ID" by the simulate tools, and the one in a dashboard simulator URL.',
      inputSchema: {
        simulation_id: z
          .string()
          .min(1)
          .describe(
            'Simulation UUID, as returned by the simulate tools or seen in a dashboard URL.'
          ),
        reconstruct_trace: z
          .boolean()
          .optional()
          .describe(
            'Replay the recorded inputs to obtain the call trace, events and state diff. Default true. Set false for a metadata-only lookup that makes no simulation call.'
          ),
        ...OutputControlSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool({ tool: TOOL, logger, config }, async () => {
        const simulationId = args.simulation_id.trim();
        const wantTrace = args.reconstruct_trace ?? true;
        logger.info('fetching simulation', { tool: TOOL, simulationId, wantTrace });

        const saved = await client.getSimulation(simulationId);
        const meta = saved.simulation;

        let response: SimulateResponse = saved;
        const notes: string[] = [];

        if (wantTrace && meta !== null && meta !== undefined) {
          try {
            const replay = await client.replaySimulation(meta);
            // Keep the *original* metadata for identity, so the reported id and
            // dashboard link still point at the saved simulation rather than at
            // the throwaway replay.
            response = {
              transaction: replay.transaction ?? saved.transaction ?? null,
              simulation: meta,
              contracts: replay.contracts ?? saved.contracts ?? null,
              generated_access_list: replay.generated_access_list ?? null,
            };
            notes.push(
              'The trace shown was reproduced by re-running the recorded inputs at block ' +
                `${String(meta.block_number ?? 'unknown')}, because Tenderly's saved-simulation record stores metadata only. ` +
                'The replay was not saved and does not consume stored-simulation quota.'
            );
          } catch (err) {
            // A replay failure must not lose the metadata we already have.
            logger.warn('trace reconstruction failed', { tool: TOOL, simulationId, err });
            notes.push(
              `The call trace could not be reproduced: ${describeError(err)} Showing the saved metadata only.`
            );
          }
        } else if (!wantTrace) {
          notes.push(
            'Metadata only, as requested. Tenderly does not store the call trace with a saved simulation; pass reconstruct_trace=true to reproduce it.'
          );
        }

        let text = formatSimulation(
          response,
          config,
          toFormatOptions(args),
          `Saved simulation ${simulationId}`
        );
        if (notes.length > 0) text += `\n\n## Notes\n${notes.map((n) => `- ${n}`).join('\n')}`;
        if (args.include_raw_response === true)
          text = appendRaw(text, { saved, rendered: response });

        return { ...textResult(text), structuredContent: { ...buildDigest(response, config) } };
      })
  );
}
