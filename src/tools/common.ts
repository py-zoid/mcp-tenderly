/**
 * Input schema fragments and result helpers shared by the tools.
 *
 * Tool descriptions are load-bearing: they are the only documentation the model
 * reads before choosing a tool and filling its arguments. They say what the
 * argument means in EVM terms and what happens when it is omitted, because a
 * vague description costs a wasted round trip on every call.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { describeError, remediationFor, TenderlyApiError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { SimulateParams, SimulationType } from '../tenderly/client.js';
import { resolveNetworkId } from '../tenderly/networks.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const DECIMAL_RE = /^\d+$/;

export const AddressSchema = z
  .string()
  .refine((s) => ADDRESS_RE.test(s.trim()), { message: 'must be a 0x-prefixed 20-byte address' })
  .transform((s) => s.trim());

export const HexDataSchema = z
  .string()
  .refine((s) => HEX_RE.test(s.trim()), { message: 'must be 0x-prefixed hex calldata' })
  .transform((s) => s.trim());

/**
 * Wei amounts are decimal strings, never numbers: 1 ETH in wei exceeds
 * Number.MAX_SAFE_INTEGER, so a JSON number would silently lose precision.
 */
export const WeiSchema = z
  .string()
  .refine((s) => DECIMAL_RE.test(s.trim()), {
    message:
      'must be a decimal string in wei (not hex, not a float) — 1 ETH is "1000000000000000000"',
  })
  .transform((s) => s.trim());

export const NetworkSchema = z
  .union([z.string(), z.number()])
  .describe(
    'Chain to simulate on. Accepts a name ("ethereum", "base", "arbitrum", "polygon", "optimism", "sepolia", …) or a numeric chain id ("8453" or 8453).'
  );

export const StateOverridesSchema = z
  .record(
    z.string(),
    z.object({
      balance: WeiSchema.optional().describe('Native balance in wei.'),
      nonce: z.number().int().nonnegative().optional(),
      code: HexDataSchema.optional().describe('Replace the account bytecode.'),
      storage: z
        .record(z.string(), z.string())
        .optional()
        .describe('Raw storage overrides: 32-byte hex slot key to 32-byte hex value.'),
    })
  )
  .refine((record) => Object.keys(record).every((key) => ADDRESS_RE.test(key.trim())), {
    message: 'every key must be a 0x-prefixed 20-byte address',
  })
  .describe(
    'Override account state before execution, keyed by address. Use this to fund an account, fake a token balance, or stub a contract, without needing those conditions to hold on-chain.'
  );

export const SimulationTypeSchema = z
  .enum(['full', 'quick', 'abi'])
  .describe(
    'Depth of the simulation. "full" returns the decoded call trace, events, state diff and source-mapped revert trace — use it for debugging. "quick" returns only the outcome and gas, and is markedly faster. "abi" decodes against the ABI without a full trace.'
  );

/** The transaction fields shared by the single and bundle tools. */
export const TransactionFieldsSchema = {
  from: AddressSchema.describe('Sender address. Does not need to be an account you control.'),
  to: AddressSchema.optional().describe(
    'Target address. Omit for a contract deployment, in which case `data` is the init code.'
  ),
  data: HexDataSchema.optional().describe(
    'Hex calldata — the ABI-encoded function selector and arguments. Omit for a plain native transfer.'
  ),
  value: WeiSchema.optional().describe('Native value to send, in wei. Defaults to 0.'),
  gas: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Gas limit. Omit to let Tenderly apply the block gas limit.'),
  gas_price: WeiSchema.optional().describe(
    'Gas price in wei. Defaults to 0, which skips fee checks.'
  ),
};

export const OutputControlSchema = {
  include_call_trace: z
    .boolean()
    .optional()
    .describe('Render the decoded call tree. Default true — it is the main debugging artefact.'),
  include_state_diff: z
    .boolean()
    .optional()
    .describe(
      'Render the storage state diff. Default false because it is the bulkiest section by far; enable it when a storage write is what you are chasing.'
    ),
  include_asset_changes: z
    .boolean()
    .optional()
    .describe('Render token transfers and native balance deltas. Default true.'),
  max_trace_nodes: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe('Cap on rendered call-trace frames. Default 200. Truncation is always reported.'),
  max_trace_depth: z
    .number()
    .int()
    .positive()
    .max(64)
    .optional()
    .describe('Cap on call-trace nesting depth. Default 12.'),
  include_raw_response: z
    .boolean()
    .optional()
    .describe(
      'Append the untouched Tenderly JSON. Very large — reach for it only when the formatted digest is missing something you need.'
    ),
};

/** Shape of the output-control arguments after parsing. */
export interface OutputControlArgs {
  include_call_trace?: boolean | undefined;
  include_state_diff?: boolean | undefined;
  include_asset_changes?: boolean | undefined;
  max_trace_nodes?: number | undefined;
  max_trace_depth?: number | undefined;
  include_raw_response?: boolean | undefined;
}

export function toFormatOptions(args: OutputControlArgs): {
  includeCallTrace?: boolean | undefined;
  includeStateDiff?: boolean | undefined;
  includeAssetChanges?: boolean | undefined;
  maxTraceNodes?: number | undefined;
  maxTraceDepth?: number | undefined;
} {
  return {
    includeCallTrace: args.include_call_trace,
    includeStateDiff: args.include_state_diff,
    includeAssetChanges: args.include_asset_changes,
    maxTraceNodes: args.max_trace_nodes,
    maxTraceDepth: args.max_trace_depth,
  };
}

export interface TransactionFieldArgs {
  from: string;
  to?: string | undefined;
  data?: string | undefined;
  value?: string | undefined;
  gas?: number | undefined;
  gas_price?: string | undefined;
}

/** Maps parsed tool arguments onto the client's request shape. */
export function toSimulateParams(options: {
  networkId: string;
  tx: TransactionFieldArgs;
  blockNumber?: number | undefined;
  save?: boolean | undefined;
  simulationType?: SimulationType | undefined;
  stateOverrides?: Record<string, Record<string, unknown>> | undefined;
}): SimulateParams {
  const { tx } = options;
  return {
    networkId: options.networkId,
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
    gasPrice: tx.gas_price,
    blockNumber: options.blockNumber,
    save: options.save,
    simulationType: options.simulationType,
    stateOverrides: options.stateOverrides,
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Appends the raw payload, guarded so a huge body cannot be pasted unbounded. */
const RAW_LIMIT = 200_000;

export function appendRaw(text: string, raw: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(raw, null, 2);
  } catch {
    return `${text}\n\n## Raw response\n(could not serialise the raw response)`;
  }
  if (json.length > RAW_LIMIT) {
    return `${text}\n\n## Raw response (truncated)\nShowing the first ${String(RAW_LIMIT)} of ${String(json.length)} characters.\n\n\`\`\`json\n${json.slice(0, RAW_LIMIT)}\n\`\`\``;
  }
  return `${text}\n\n## Raw response\n\`\`\`json\n${json}\n\`\`\``;
}

/**
 * The single place a tool failure is logged and rendered.
 *
 * Tools return `isError` results rather than throwing, so the model gets a
 * message it can act on instead of an opaque protocol error. This is the
 * outermost boundary, so it is also the only place that logs — anything below
 * rethrows with context and stays quiet.
 */
export async function runTool(
  options: { tool: string; logger: Logger; config: Config },
  body: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const { tool, logger } = options;
  const startedAt = Date.now();
  try {
    const result = await body();
    logger.info('tool completed', { tool, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    const isApi = err instanceof TenderlyApiError;
    const context = {
      tool,
      durationMs: Date.now() - startedAt,
      ...(isApi ? { status: err.status, apiCode: err.apiCode, path: err.path } : {}),
      err,
    };

    // Retriable failures are expected friction on a free tier, not incidents.
    if (isApi && err.retriable) logger.warn('tool failed (retriable)', context);
    else logger.error('tool failed', context);

    const remedy = remediationFor(err);
    return errorResult(
      [`${tool} failed: ${describeError(err)}`, ...(remedy !== undefined ? ['', remedy] : [])].join(
        '\n'
      )
    );
  }
}

/** Resolves a network argument, rewriting the error to name the offending tool arg. */
export function resolveNetworkArg(network: string | number): string {
  try {
    return resolveNetworkId(network);
  } catch (err) {
    throw new Error(`Invalid "network" argument. ${describeError(err)}`, { cause: err });
  }
}
