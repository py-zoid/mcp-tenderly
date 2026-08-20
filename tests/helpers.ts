import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { SimulateResponse } from '../src/tenderly/schemas.js';

export const testConfig: Config = {
  apiKey: 'test-key',
  accountSlug: 'acme',
  projectSlug: 'widgets',
  baseUrl: 'https://api.tenderly.co',
  saveSimulations: true,
  logLevel: 'error',
  timeoutMs: 1000,
};

export function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

export function recordingLogger(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    debug: (m) => lines.push({ level: 'debug', msg: m }),
    info: (m) => lines.push({ level: 'info', msg: m }),
    warn: (m) => lines.push({ level: 'warn', msg: m }),
    error: (m) => lines.push({ level: 'error', msg: m }),
  };
}

/** A minimal successful simulation, shaped like a real /simulate response. */
export function successResponse(): SimulateResponse {
  return {
    transaction: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      gas: 200000,
      gas_used: 51234,
      value: '0',
      status: true,
      network_id: '1',
      method: 'transfer',
      transaction_info: {
        block_number: 19000000,
        gas_used: 51234,
        logs: [
          {
            name: 'Transfer',
            inputs: [
              {
                soltype: { name: 'from', type: 'address', indexed: true },
                value: '0x1111111111111111111111111111111111111111',
              },
              { soltype: { name: 'value', type: 'uint256' }, value: '1000000' },
            ],
            raw: {
              address: '0x2222222222222222222222222222222222222222',
              topics: ['0xddf2'],
              data: '0x',
            },
          },
        ],
        call_trace: {
          call_type: 'CALL',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          function_name: 'transfer',
          gas_used: 51234,
          calls: [
            {
              call_type: 'STATICCALL',
              to: '0x3333333333333333333333333333333333333333',
              function_name: 'balanceOf',
              gas_used: 2100,
              calls: null,
            },
          ],
        },
      },
    },
    simulation: { id: 'sim-abc-123', status: true, network_id: '1', gas_used: 51234 },
    contracts: [
      {
        address: '0x2222222222222222222222222222222222222222',
        contract_name: 'USDC',
        token_data: { symbol: 'USDC', decimals: 6 },
      },
    ],
  };
}

/** A reverting simulation carrying a source-mapped stack trace. */
export function revertResponse(): SimulateResponse {
  return {
    transaction: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      gas_used: 24000,
      status: false,
      network_id: '8453',
      error_message: 'execution reverted',
      transaction_info: {
        stack_trace: [
          {
            name: 'ERC20.sol',
            line: 212,
            op: 'REVERT',
            code: 'require(balance >= amount, "ERC20: transfer amount exceeds balance");',
            error_reason: 'ERC20: transfer amount exceeds balance',
          },
        ],
        call_trace: {
          call_type: 'CALL',
          to: '0x2222222222222222222222222222222222222222',
          function_name: 'transfer',
          error: 'execution reverted',
          calls: [
            {
              call_type: 'DELEGATECALL',
              to: '0x4444444444444444444444444444444444444444',
              function_name: '_transfer',
              error: 'execution reverted',
              error_reason: 'ERC20: transfer amount exceeds balance',
              calls: null,
            },
          ],
        },
      },
    },
    simulation: { id: 'sim-fail-9', status: false, network_id: '8453' },
  };
}

/** Builds a fake fetch that replays the given responses in order. */
export function fakeFetch(
  responses: { status: number; body: unknown; headers?: Record<string, string> }[]
): {
  impl: (url: string, init: RequestInit) => Promise<Response>;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, init });
      const spec = responses[Math.min(index, responses.length - 1)];
      index++;
      if (spec === undefined) throw new Error('no response configured');
      return Promise.resolve(
        new Response(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body), {
          status: spec.status,
          headers: spec.headers ?? { 'content-type': 'application/json' },
        })
      );
    },
  };
}

/**
 * Shaped from an actual `POST /simulate` response for a mainnet USDC transfer.
 *
 * Captured because the stub fixtures were too clean to expose what real
 * payloads contain: `value: "0x"` rather than `"0"`, the int64-max gas
 * sentinel, an empty `method`, and a call tree in which storage opcodes
 * outnumber real calls.
 */
export function realWorldUsdcResponse(): SimulateResponse {
  return {
    transaction: {
      from: '0x000000000000000000000000000000000000dEaD',
      to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      // Tenderly sends the int64 maximum when the caller set no gas limit. The
      // literal here is 2^63 rather than 2^63-1 because that is what
      // JSON.parse actually yields for it — the odd value is not representable
      // as a double, and this fixture mirrors what the process receives.
      gas: 9223372036854775808,
      gas_used: 44920,
      // Hex, not decimal, and bare "0x" for zero.
      value: '0x',
      status: true,
      network_id: '1',
      method: '',
      transaction_info: {
        block_number: 25794834,
        gas_used: 44920,
        logs: [
          {
            name: 'Transfer',
            inputs: [
              {
                soltype: { name: 'from', type: 'address', indexed: true },
                value: '0x000000000000000000000000000000000000dEaD',
              },
              {
                soltype: { name: 'to', type: 'address', indexed: true },
                value: '0x0000000000000000000000000000000000000001',
              },
              { soltype: { name: 'value', type: 'uint256' }, value: '1000000' },
            ],
            raw: {
              address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              topics: ['0xddf252ad'],
              data: '0x',
            },
          },
        ],
        call_trace: {
          call_type: 'CALL',
          to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          function_name: 'transfer',
          gas_used: 23552,
          value: '0x',
          calls: [
            { call_type: 'SLOAD', gas_used: 2100, calls: null },
            { call_type: 'SLOAD', gas_used: 2100, calls: null },
            {
              call_type: 'DELEGATECALL',
              to: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd',
              function_name: 'transfer',
              gas_used: 16263,
              calls: [
                { call_type: 'SLOAD', gas_used: 2100, calls: null },
                {
                  call_type: 'JUMPDEST',
                  to: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd',
                  function_name: '_transfer',
                  gas_used: 9238,
                  calls: [
                    { call_type: 'SSTORE', gas_used: 2900, calls: null },
                    { call_type: 'LOG3', gas_used: 1756, calls: null },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    simulation: { id: 'sim-real-1', status: true, network_id: '1', gas_used: 44920 },
    contracts: [
      {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        contract_name: 'FiatTokenProxy',
        token_data: { symbol: 'usdc', decimals: 6 },
      },
      { address: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd', contract_name: 'FiatTokenV2_2' },
    ],
  };
}
