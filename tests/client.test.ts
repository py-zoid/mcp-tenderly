import { describe, expect, it } from 'vitest';
import { TenderlyApiError } from '../src/errors.js';
import { TenderlyClient } from '../src/tenderly/client.js';
import {
  fakeFetch,
  recordingLogger,
  silentLogger,
  successResponse,
  testConfig,
} from './helpers.js';

const noSleep = (): Promise<void> => Promise.resolve();

function makeClient(
  responses: { status: number; body: unknown; headers?: Record<string, string> }[],
  logger = silentLogger()
) {
  const fetcher = fakeFetch(responses);
  const client = new TenderlyClient({
    config: testConfig,
    logger,
    fetchImpl: fetcher.impl,
    sleep: noSleep,
  });
  return { client, calls: fetcher.calls };
}

/** Parses a recorded request body, failing loudly if it is not JSON text. */
function bodyOf(call: { init: RequestInit } | undefined): Record<string, unknown> {
  const body = call?.init.body;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return JSON.parse(body) as Record<string, unknown>;
}

const simulateArgs = {
  networkId: '1',
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  data: '0xa9059cbb',
};

describe('TenderlyClient.simulate', () => {
  it('posts to the project-scoped simulate endpoint with the access-key header', async () => {
    const { client, calls } = makeClient([{ status: 200, body: successResponse() }]);
    await client.simulate(simulateArgs);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.tenderly.co/api/v1/account/acme/project/widgets/simulate');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['X-Access-Key']).toBe('test-key');
    // Tenderly does not accept Bearer auth for access tokens.
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps `data` onto the wire field `input` and defaults the simulation type', async () => {
    const { client, calls } = makeClient([{ status: 200, body: successResponse() }]);
    await client.simulate(simulateArgs);

    const body = bodyOf(calls[0]);
    expect(body.input).toBe('0xa9059cbb');
    expect(body.data).toBeUndefined();
    expect(body.simulation_type).toBe('full');
    expect(body.network_id).toBe('1');
  });

  it('omits fields the caller did not set rather than sending nulls', async () => {
    const { client, calls } = makeClient([{ status: 200, body: successResponse() }]);
    await client.simulate({ networkId: '1', from: simulateArgs.from });

    const body = bodyOf(calls[0]);
    expect('to' in body).toBe(false);
    expect('value' in body).toBe(false);
    expect('gas' in body).toBe(false);
    expect('block_number' in body).toBe(false);
  });

  it('takes the save default from config and lets the caller override it', async () => {
    const { client: saving, calls: savingCalls } = makeClient([
      { status: 200, body: successResponse() },
    ]);
    await saving.simulate(simulateArgs);
    expect(bodyOf(savingCalls[0]).save).toBe(true);

    const { client: notSaving, calls: notSavingCalls } = makeClient([
      { status: 200, body: successResponse() },
    ]);
    await notSaving.simulate({ ...simulateArgs, save: false });
    const body = bodyOf(notSavingCalls[0]);
    expect(body.save).toBe(false);
    // A failed run is the interesting one when debugging, so save_if_fails
    // tracks save rather than defaulting to true independently.
    expect(body.save_if_fails).toBe(false);
  });

  it('forwards state overrides under the wire field `state_objects`', async () => {
    const { client, calls } = makeClient([{ status: 200, body: successResponse() }]);
    await client.simulate({
      ...simulateArgs,
      stateOverrides: { '0x1111111111111111111111111111111111111111': { balance: '1000' } },
    });
    const body = bodyOf(calls[0]);
    expect(body.state_objects).toEqual({
      '0x1111111111111111111111111111111111111111': { balance: '1000' },
    });
  });
});

describe('TenderlyClient error handling', () => {
  it('does not retry a 401 and marks it terminal', async () => {
    const logger = recordingLogger();
    const { client, calls } = makeClient(
      [{ status: 401, body: { error: { message: 'unauthorized', slug: 'unauthorized' } } }],
      logger
    );

    await expect(client.simulate(simulateArgs)).rejects.toThrow(TenderlyApiError);
    expect(calls).toHaveLength(1);

    const err = await client.simulate(simulateArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenderlyApiError);
    if (err instanceof TenderlyApiError) {
      expect(err.status).toBe(401);
      expect(err.apiCode).toBe('unauthorized');
      expect(err.retriable).toBe(false);
      expect(err.message).toContain('unauthorized');
    }
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const logger = recordingLogger();
    const { client, calls } = makeClient(
      [
        {
          status: 429,
          body: { error: { message: 'rate limited' } },
          headers: { 'retry-after': '0' },
        },
        { status: 200, body: successResponse() },
      ],
      logger
    );

    const result = await client.simulate(simulateArgs);
    expect(result.simulation?.id).toBe('sim-abc-123');
    expect(calls).toHaveLength(2);
    // Retriable friction is a warning, not an error — it did not fail overall.
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('gives up after the attempt budget and reports the last status', async () => {
    const { client, calls } = makeClient([{ status: 503, body: { message: 'upstream down' } }]);
    const err = await client.simulate(simulateArgs).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(err).toBeInstanceOf(TenderlyApiError);
    if (err instanceof TenderlyApiError) expect(err.status).toBe(503);
  });

  it('reports a non-JSON body as a shape failure rather than crashing', async () => {
    const { client } = makeClient([
      { status: 200, body: '<html>gateway</html>', headers: { 'content-type': 'text/html' } },
    ]);
    await expect(client.simulate(simulateArgs)).rejects.toThrow(/not JSON/);
  });

  it('wraps a transport failure and keeps the original as the cause', async () => {
    const client = new TenderlyClient({
      config: testConfig,
      logger: silentLogger(),
      fetchImpl: () => Promise.reject(new Error('socket hang up')),
      sleep: noSleep,
    });
    const err = await client.simulate(simulateArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenderlyApiError);
    if (err instanceof TenderlyApiError) {
      expect(err.message).toContain('Could not reach the Tenderly API');
      expect((err.cause as Error).message).toBe('socket hang up');
    }
  });

  it('never puts the api key in the error message or path', async () => {
    const { client } = makeClient([{ status: 500, body: { message: 'boom' } }]);
    const err = await client.simulate(simulateArgs).catch((e: unknown) => e);
    if (err instanceof TenderlyApiError) {
      expect(err.message).not.toContain('test-key');
      expect(err.path ?? '').not.toContain('test-key');
    }
  });
});

describe('TenderlyClient.simulateBundle', () => {
  it('wraps the simulations in the bundle envelope and unwraps the results', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { simulation_results: [successResponse(), successResponse()] } },
    ]);

    const results = await client.simulateBundle([simulateArgs, simulateArgs]);
    expect(results).toHaveLength(2);
    expect(calls[0]?.url).toContain('/simulate-bundle');

    const body = bodyOf(calls[0]) as unknown as { simulations: unknown[] };
    expect(body.simulations).toHaveLength(2);
  });

  it('returns an empty array when the envelope carries no results', async () => {
    const { client } = makeClient([{ status: 200, body: {} }]);
    expect(await client.simulateBundle([simulateArgs])).toEqual([]);
  });
});

describe('TenderlyClient.getSimulation', () => {
  it('normalises the transaction nested under `simulation` to the top level', async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          simulation: {
            id: 'sim-nested',
            status: false,
            transaction: { status: false, error_message: 'reverted' },
          },
        },
      },
    ]);

    const result = await client.getSimulation('sim-nested');
    expect(calls[0]?.url).toContain('/simulations/sim-nested');
    expect(result.transaction?.error_message).toBe('reverted');
    expect(result.simulation?.id).toBe('sim-nested');
  });

  it('url-encodes the simulation id', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { simulation: { id: 'x' } } }]);
    await client.getSimulation('a b/c');
    expect(calls[0]?.url).toContain('a%20b%2Fc');
  });
});

describe('TenderlyClient.listSimulations', () => {
  it('passes pagination through as query parameters', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { simulations: [{ id: 'sim-1' }, { id: 'sim-2' }] } },
    ]);
    const results = await client.listSimulations({ page: 2, perPage: 5 });
    expect(results).toHaveLength(2);
    expect(calls[0]?.url).toContain('page=2');
    expect(calls[0]?.url).toContain('perPage=5');
  });
});
