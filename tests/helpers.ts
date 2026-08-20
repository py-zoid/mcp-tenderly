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
