import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  findFailingCall,
  formatCallTrace,
  formatSimulation,
  formatUnits,
  renderSolValue,
} from '../src/tenderly/format.js';
import type { CallTraceNode } from '../src/tenderly/schemas.js';
import { revertResponse, successResponse, testConfig } from './helpers.js';

describe('formatUnits', () => {
  it('converts wei to a trimmed decimal string', () => {
    expect(formatUnits('1000000000000000000')).toBe('1');
    expect(formatUnits('1500000000000000000')).toBe('1.5');
    expect(formatUnits('1')).toBe('0.000000000000000001');
    expect(formatUnits('0')).toBe('0');
  });

  it('honours a non-18 decimal count', () => {
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1234567', 6)).toBe('1.234567');
    expect(formatUnits('42', 0)).toBe('42');
  });

  it('keeps the sign on a negative delta', () => {
    expect(formatUnits('-500000000000000000')).toBe('-0.5');
  });

  // Amounts beyond Number.MAX_SAFE_INTEGER must not lose precision.
  it('handles values larger than a double can represent exactly', () => {
    expect(formatUnits('123456789012345678901234567890')).toBe('123456789012.34567890123456789');
  });

  it('returns the input unchanged when it is not a number', () => {
    expect(formatUnits('not-a-number')).toBe('not-a-number');
  });
});

describe('renderSolValue', () => {
  it('shortens long hex blobs', () => {
    const long = `0x${'ab'.repeat(64)}`;
    expect(renderSolValue(long)).toContain('…');
    expect(renderSolValue(long).length).toBeLessThan(long.length);
  });

  it('caps array width and reports the remainder', () => {
    expect(renderSolValue(Array.from({ length: 20 }, (_, i) => i))).toContain('12 more');
  });

  it('stops descending at depth 3 instead of recursing without bound', () => {
    expect(renderSolValue({ a: { b: { c: { d: { e: 1 } } } } })).toContain('{…}');
  });
});

describe('buildDigest', () => {
  it('extracts the success outcome and dashboard link', () => {
    const digest = buildDigest(successResponse(), testConfig);
    expect(digest.status).toBe('success');
    expect(digest.gas_used).toBe(51234);
    expect(digest.simulation_id).toBe('sim-abc-123');
    expect(digest.event_count).toBe(1);
    expect(digest.dashboard_url).toBe(
      'https://dashboard.tenderly.co/acme/widgets/simulator/sim-abc-123'
    );
  });

  it('surfaces the revert reason out of the stack trace', () => {
    const digest = buildDigest(revertResponse(), testConfig);
    expect(digest.status).toBe('reverted');
    expect(digest.error_message).toBe('execution reverted');
    expect(digest.revert_reason).toBe('ERC20: transfer amount exceeds balance');
  });

  it('reports unknown rather than guessing when status is absent', () => {
    expect(buildDigest({ transaction: null, simulation: null }, testConfig).status).toBe('unknown');
  });

  it('omits the dashboard link for an unsaved simulation', () => {
    const digest = buildDigest({ transaction: { status: true }, simulation: null }, testConfig);
    expect(digest.dashboard_url).toBeNull();
  });
});

describe('findFailingCall', () => {
  it('returns the deepest failing frame, not the outermost one', () => {
    const failing = findFailingCall(revertResponse().transaction?.transaction_info?.call_trace);
    expect(failing?.function_name).toBe('_transfer');
  });

  it('returns null when nothing failed', () => {
    expect(findFailingCall(successResponse().transaction?.transaction_info?.call_trace)).toBeNull();
  });
});

describe('formatCallTrace', () => {
  const labels = new Map<string, string>();

  it('renders nested calls as a tree', () => {
    const trace = successResponse().transaction?.transaction_info?.call_trace;
    const { text, notes } = formatCallTrace(trace, labels, { maxNodes: 100, maxDepth: 10 });
    expect(text).toContain('transfer');
    expect(text).toContain('balanceOf');
    expect(text).toContain('└─');
    expect(notes).toHaveLength(0);
  });

  it('marks a failing frame and shows its reason', () => {
    const trace = revertResponse().transaction?.transaction_info?.call_trace;
    const { text } = formatCallTrace(trace, labels, { maxNodes: 100, maxDepth: 10 });
    expect(text).toContain('✗');
    expect(text).toContain('ERC20: transfer amount exceeds balance');
  });

  // A silent cap reads as "that was everything" and misleads the model.
  it('reports how many frames were dropped by the node cap', () => {
    const wide: CallTraceNode = {
      call_type: 'CALL',
      function_name: 'batch',
      calls: Array.from({ length: 50 }, (_, i) => ({
        call_type: 'CALL',
        function_name: `step${String(i)}`,
        calls: null,
      })),
    };
    const { notes } = formatCallTrace(wide, labels, { maxNodes: 10, maxDepth: 10 });
    expect(notes.join(' ')).toMatch(/showed 10 of 51 frames/);
    expect(notes.join(' ')).toContain('max_trace_nodes');
  });

  it('reports frames dropped by the depth cap', () => {
    let deep: CallTraceNode = { call_type: 'CALL', function_name: 'leaf', calls: null };
    for (let i = 0; i < 10; i++) {
      deep = { call_type: 'CALL', function_name: `level${String(i)}`, calls: [deep] };
    }
    const { text, notes } = formatCallTrace(deep, labels, { maxNodes: 500, maxDepth: 3 });
    expect(text).toContain('below depth limit');
    expect(notes.join(' ')).toMatch(/omitted below depth 3/);
  });

  it('falls back to the selector when a contract is unverified', () => {
    const node: CallTraceNode = {
      call_type: 'CALL',
      to: '0x5555555555555555555555555555555555555555',
      input: '0xa9059cbb0000000000000000000000000000000000000000',
      calls: null,
    };
    const { text } = formatCallTrace(node, labels, { maxNodes: 10, maxDepth: 5 });
    expect(text).toContain('<0xa9059cbb>');
  });

  it('says so plainly when there is no trace at all', () => {
    expect(formatCallTrace(null, labels, { maxNodes: 10, maxDepth: 5 }).text).toContain(
      'no call trace'
    );
  });
});

describe('formatSimulation', () => {
  it('leads with the outcome and includes the decoded event', () => {
    const text = formatSimulation(successResponse(), testConfig);
    expect(text.startsWith('# Simulation: SUCCESS')).toBe(true);
    expect(text).toContain('Transfer(from=0x1111');
    expect(text).toContain('ethereum (1)');
    // The contract label comes from the contracts array, not the raw address.
    expect(text).toContain('USDC');
  });

  it('puts the failure section ahead of the trace and includes the source line', () => {
    const text = formatSimulation(revertResponse(), testConfig);
    expect(text).toContain('# Simulation: REVERTED');
    expect(text.indexOf('## Failure')).toBeLessThan(text.indexOf('## Call trace'));
    expect(text).toContain('ERC20: transfer amount exceeds balance');
    expect(text).toContain('ERC20.sol:212');
    expect(text).toContain('base (8453)');
  });

  it('names the failing call frame, not just the top-level error', () => {
    expect(formatSimulation(revertResponse(), testConfig)).toContain('Failing call:');
  });

  // Regression: tool arguments arrive as explicit `undefined` properties, and
  // spreading those over the defaults used to switch the call trace off.
  it('still renders the call trace when options are present but undefined', () => {
    const text = formatSimulation(successResponse(), testConfig, {
      includeCallTrace: undefined,
      includeStateDiff: undefined,
      maxTraceNodes: undefined,
      maxTraceDepth: undefined,
    });
    expect(text).toContain('## Call trace');
    expect(text).toContain('balanceOf');
  });

  it('omits the call trace only when explicitly disabled', () => {
    const text = formatSimulation(successResponse(), testConfig, { includeCallTrace: false });
    expect(text).not.toContain('## Call trace');
  });

  it('keeps the state diff out unless asked for', () => {
    const response = successResponse();
    const info = response.transaction?.transaction_info;
    if (info) {
      info.state_diff = [
        {
          address: '0x2222222222222222222222222222222222222222',
          soltype: { name: 'balances' },
          original: '1',
          dirty: '2',
        },
      ];
    }
    expect(formatSimulation(response, testConfig)).not.toContain('Storage state diff');
    expect(formatSimulation(response, testConfig, { includeStateDiff: true })).toContain(
      'Storage state diff'
    );
  });

  it('flags a response with no transaction detail instead of rendering an empty digest', () => {
    const text = formatSimulation({ transaction: null, simulation: { id: 'x' } }, testConfig);
    expect(text).toContain('no transaction detail');
    expect(text).toContain('include_raw_response');
  });

  it('reports an undecoded event by its topic rather than dropping it', () => {
    const response = successResponse();
    const info = response.transaction?.transaction_info;
    if (info) {
      info.logs = [
        {
          name: null,
          raw: {
            address: '0x9999999999999999999999999999999999999999',
            topics: ['0xdeadbeef'],
            data: '0x',
          },
        },
      ];
    }
    const text = formatSimulation(response, testConfig);
    expect(text).toContain('<undecoded>');
    expect(text).toContain('0xdeadbeef');
  });
});
