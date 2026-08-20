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
        'Look up a saved simulation by id (the UUID reported by the simulate tools, also in dashboard simulator URLs) and render its outcome and call trace. ' +
        'The saved record stores metadata only, so the trace is rebuilt by replaying the recorded inputs at the recorded block — faithful, but costs one simulation against the rate limit. ' +
        'Pass reconstruct_trace=false for a metadata-only lookup that makes no simulation call.',
      inputSchema: {
        simulation_id: z.string().min(1).describe('Simulation UUID.'),
        reconstruct_trace: z
          .boolean()
          .optional()
          .describe('Replay to obtain the call trace, events and state diff. Default true.'),
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
        let rawReplay: SimulateResponse | null = null;
        const notes: string[] = [];

        if (wantTrace && meta !== null && meta !== undefined) {
          try {
            const replay = await client.replaySimulation(meta);
            rawReplay = replay;
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
              `Trace reproduced by replaying at block ${String(meta.block_number ?? 'unknown')}; the saved record stores metadata only. Not saved, so no quota consumed.`
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
            'Metadata only, as requested. The saved record has no trace; reconstruct_trace=true rebuilds it.'
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
          text = appendRaw(text, { saved, replay: rawReplay });

        return { ...textResult(text), structuredContent: { ...buildDigest(response, config) } };
      })
  );
}
