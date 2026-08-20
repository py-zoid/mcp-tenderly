/**
 * Shapes for the Tenderly Simulation REST API (v1).
 *
 * Every response object is a *loose* object with almost every field optional.
 * That is a deliberate trade-off, not laziness: this is a third-party API we do
 * not version-lock and cannot pin, and its payloads differ between
 * `simulation_type` values, between `/simulate` and `/simulations/{id}`, and
 * between verified and unverified contracts. Strict parsing would turn a
 * harmless new field or an absent optional block into a hard tool failure,
 * which is a far worse outcome than a formatter that renders "unknown" for one
 * line. Unknown keys are preserved so `include_raw_response` can hand the
 * untouched payload back for inspection when the digest is not enough.
 *
 * The invariant we do keep: nothing reaches the formatter without passing
 * through one of these schemas, so the formatter never indexes into `any`.
 */

import { z } from 'zod';

/** A hex-encoded address, loosely checked. Tenderly echoes back mixed case. */
const Address = z.string();
/** Numeric strings appear as `string | number` depending on magnitude. */
const Numeric = z.union([z.string(), z.number()]);

/**
 * One entry of a decoded argument list. `value` is genuinely arbitrary JSON —
 * a decoded struct or array nests without bound — so it stays `unknown` and
 * the formatter is responsible for rendering it defensively.
 */
export const SolValueSchema = z.looseObject({
  soltype: z
    .looseObject({
      name: z.string().optional(),
      type: z.string().optional(),
      indexed: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  value: z.unknown().optional(),
});
export type SolValue = z.infer<typeof SolValueSchema>;

/**
 * A node of the EVM call tree.
 *
 * The type is written out by hand rather than inferred because the schema is
 * recursive and `z.lazy` cannot infer through the cycle. That makes this the
 * one place in the codebase where a type duplicates a schema, so the two must
 * be changed together: every field marked `.nullable()` below needs `| null`
 * here. Tenderly really does use all three of missing, `null` and `""` for
 * absent values, and dropping `| null` here makes the guards that handle it
 * look like dead code.
 */
export interface CallTraceNode {
  call_type?: string | undefined;
  caller_op?: string | undefined;
  from?: string | undefined;
  to?: string | null | undefined;
  contract_name?: string | null | undefined;
  function_name?: string | null | undefined;
  function_signature?: string | null | undefined;
  gas?: string | number | undefined;
  gas_used?: string | number | undefined;
  value?: string | number | null | undefined;
  input?: string | null | undefined;
  output?: string | null | undefined;
  decoded_input?: SolValue[] | null | undefined;
  decoded_output?: SolValue[] | null | undefined;
  error?: string | null | undefined;
  error_reason?: string | null | undefined;
  error_op?: string | null | undefined;
  /** `null`, not `[]`, on a leaf frame. */
  calls?: CallTraceNode[] | null | undefined;
  [key: string]: unknown;
}

export const CallTraceNodeSchema: z.ZodType<CallTraceNode> = z.lazy(() =>
  z.looseObject({
    call_type: z.string().optional(),
    caller_op: z.string().optional(),
    from: Address.optional(),
    to: Address.nullable().optional(),
    contract_name: z.string().nullable().optional(),
    function_name: z.string().nullable().optional(),
    function_signature: z.string().nullable().optional(),
    gas: Numeric.optional(),
    gas_used: Numeric.optional(),
    value: Numeric.nullable().optional(),
    input: z.string().nullable().optional(),
    output: z.string().nullable().optional(),
    decoded_input: z.array(SolValueSchema).nullable().optional(),
    decoded_output: z.array(SolValueSchema).nullable().optional(),
    error: z.string().nullable().optional(),
    error_reason: z.string().nullable().optional(),
    error_op: z.string().nullable().optional(),
    calls: z.array(CallTraceNodeSchema).nullable().optional(),
  })
);

export const LogSchema = z.looseObject({
  name: z.string().nullable().optional(),
  anonymous: z.boolean().optional(),
  inputs: z.array(SolValueSchema).nullable().optional(),
  raw: z
    .looseObject({
      address: Address.optional(),
      topics: z.array(z.string()).nullable().optional(),
      data: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type TenderlyLog = z.infer<typeof LogSchema>;

/**
 * A frame of the source-mapped revert trace. Only present for verified
 * contracts with `simulation_type: "full"` — the single most useful field in
 * the whole payload when it is there, and absent far more often than not.
 */
export const StackFrameSchema = z.looseObject({
  file_index: z.number().optional(),
  contract: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  column: z.number().nullable().optional(),
  op: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  error_reason: z.string().nullable().optional(),
});
export type StackFrame = z.infer<typeof StackFrameSchema>;

export const BalanceDiffSchema = z.looseObject({
  address: Address.optional(),
  original: Numeric.nullable().optional(),
  dirty: Numeric.nullable().optional(),
  is_miner: z.boolean().optional(),
});

export const AssetChangeSchema = z.looseObject({
  type: z.string().nullable().optional(),
  from: Address.nullable().optional(),
  to: Address.nullable().optional(),
  amount: Numeric.nullable().optional(),
  raw_amount: Numeric.nullable().optional(),
  dollar_value: Numeric.nullable().optional(),
  token_info: z
    .looseObject({
      standard: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      symbol: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      decimals: z.number().nullable().optional(),
      contract_address: Address.nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const StateDiffSchema = z.looseObject({
  address: Address.nullable().optional(),
  soltype: z
    .looseObject({ name: z.string().optional(), type: z.string().optional() })
    .nullable()
    .optional(),
  original: z.unknown().optional(),
  dirty: z.unknown().optional(),
  raw: z
    .array(
      z.looseObject({
        address: Address.optional(),
        key: z.string().optional(),
        original: z.string().optional(),
        dirty: z.string().optional(),
      })
    )
    .nullable()
    .optional(),
});

export const ConsoleLogSchema = z.looseObject({
  raw: z.unknown().optional(),
  input: z.string().nullable().optional(),
  decoded_input: z.array(SolValueSchema).nullable().optional(),
});

export const TransactionInfoSchema = z.looseObject({
  block_number: z.number().nullable().optional(),
  transaction_id: z.string().nullable().optional(),
  contract_address: Address.nullable().optional(),
  method: z.string().nullable().optional(),
  gas_used: Numeric.nullable().optional(),
  call_trace: CallTraceNodeSchema.nullable().optional(),
  stack_trace: z.array(StackFrameSchema).nullable().optional(),
  logs: z.array(LogSchema).nullable().optional(),
  balance_diff: z.array(BalanceDiffSchema).nullable().optional(),
  asset_changes: z.array(AssetChangeSchema).nullable().optional(),
  state_diff: z.array(StateDiffSchema).nullable().optional(),
  console_logs: z.array(ConsoleLogSchema).nullable().optional(),
  created_at: z.string().nullable().optional(),
});

export const TransactionSchema = z.looseObject({
  hash: z.string().nullable().optional(),
  block_number: z.number().nullable().optional(),
  from: Address.optional(),
  to: Address.nullable().optional(),
  gas: Numeric.nullable().optional(),
  gas_price: Numeric.nullable().optional(),
  gas_used: Numeric.nullable().optional(),
  gas_fee_cap: Numeric.nullable().optional(),
  value: Numeric.nullable().optional(),
  nonce: Numeric.nullable().optional(),
  input: z.string().nullable().optional(),
  status: z.boolean().nullable().optional(),
  network_id: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
  decoded_input: z.array(SolValueSchema).nullable().optional(),
  error_message: z.string().nullable().optional(),
  error_info: z
    .looseObject({
      error_message: z.string().nullable().optional(),
      address: Address.nullable().optional(),
    })
    .nullable()
    .optional(),
  transaction_info: TransactionInfoSchema.nullable().optional(),
  addresses: z.array(Address).nullable().optional(),
});
export type TenderlyTransaction = z.infer<typeof TransactionSchema>;

export const SimulationMetaSchema = z.looseObject({
  id: z.string().optional(),
  project_id: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
  network_id: z.string().nullable().optional(),
  block_number: z.number().nullable().optional(),
  transaction_index: z.number().nullable().optional(),
  from: Address.nullable().optional(),
  to: Address.nullable().optional(),
  input: z.string().nullable().optional(),
  gas: Numeric.nullable().optional(),
  gas_price: Numeric.nullable().optional(),
  gas_used: Numeric.nullable().optional(),
  value: Numeric.nullable().optional(),
  status: z.boolean().nullable().optional(),
  method: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type SimulationMeta = z.infer<typeof SimulationMetaSchema>;

export const ContractSchema = z.looseObject({
  id: z.string().nullable().optional(),
  contract_id: z.string().nullable().optional(),
  address: Address.nullable().optional(),
  contract_name: z.string().nullable().optional(),
  standards: z.array(z.string()).nullable().optional(),
  standard: z.string().nullable().optional(),
  token_data: z
    .looseObject({
      symbol: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      decimals: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type TenderlyContract = z.infer<typeof ContractSchema>;

/** Response of `POST /simulate` and each element of a bundle response. */
export const SimulateResponseSchema = z.looseObject({
  transaction: TransactionSchema.nullable().optional(),
  simulation: SimulationMetaSchema.nullable().optional(),
  contracts: z.array(ContractSchema).nullable().optional(),
  generated_access_list: z.array(z.unknown()).nullable().optional(),
});
export type SimulateResponse = z.infer<typeof SimulateResponseSchema>;

export const SimulateBundleResponseSchema = z.looseObject({
  simulation_results: z.array(SimulateResponseSchema).nullable().optional(),
});

/**
 * Response of `GET /simulations/{id}`. Tenderly nests the transaction under
 * `simulation` on this endpoint but returns it as a sibling on `/simulate`, so
 * both positions are accepted and normalised by the caller.
 */
export const GetSimulationResponseSchema = z.looseObject({
  simulation: SimulationMetaSchema.extend({
    transaction: TransactionSchema.nullable().optional(),
  })
    .nullable()
    .optional(),
  transaction: TransactionSchema.nullable().optional(),
  contracts: z.array(ContractSchema).nullable().optional(),
  generated_access_list: z.array(z.unknown()).nullable().optional(),
});

export const ListSimulationsResponseSchema = z.looseObject({
  simulations: z.array(SimulationMetaSchema).nullable().optional(),
});

/** Tenderly's error envelope. Shape varies; both nestings are seen in the wild. */
export const ApiErrorBodySchema = z.looseObject({
  error: z
    .looseObject({
      id: z.string().nullable().optional(),
      slug: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  error_message: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});
