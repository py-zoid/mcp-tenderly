/**
 * Thin client over the Tenderly Simulation REST API (v1).
 *
 * Scope is deliberately limited to the endpoints available on a free plan:
 * `/simulate`, `/simulate-bundle`, `/simulations` and `/simulations/{id}`.
 * Nothing here touches the Web3 Gateway, DevNets, Virtual TestNets, Alerts or
 * the Actions API — those are paid or OAuth-gated, and reaching for them would
 * make the server fail confusingly for exactly the users it targets.
 */

import { z } from 'zod';
import { TenderlyApiError } from '../errors.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import {
  ApiErrorBodySchema,
  GetSimulationResponseSchema,
  ListSimulationsResponseSchema,
  SimulateBundleResponseSchema,
  SimulateResponseSchema,
  type SimulateResponse,
} from './schemas.js';

/** Per-account state override applied before execution. */
export interface StateOverride {
  balance?: string;
  nonce?: number;
  code?: string;
  /** Raw storage slots: 32-byte hex key to 32-byte hex value. */
  storage?: Record<string, string>;
}

export type SimulationType = 'full' | 'quick' | 'abi';

export interface SimulateParams {
  networkId: string;
  from: string;
  /** Omit for a contract deployment. */
  to?: string | undefined;
  /** Hex calldata. */
  data?: string | undefined;
  /** Native value in wei, as a decimal string. */
  value?: string | undefined;
  gas?: number | undefined;
  gasPrice?: string | undefined;
  /** Block to fork from. Omit for the latest block. */
  blockNumber?: number | undefined;
  transactionIndex?: number | undefined;
  save?: boolean | undefined;
  saveIfFails?: boolean | undefined;
  simulationType?: SimulationType | undefined;
  stateOverrides?: Record<string, StateOverride> | undefined;
  generateAccessList?: boolean | undefined;
}

/** Snake-cases one simulation into the wire body, dropping absent fields. */
function toWireBody(params: SimulateParams, defaults: { save: boolean }): Record<string, unknown> {
  const save = params.save ?? defaults.save;
  const body: Record<string, unknown> = {
    network_id: params.networkId,
    from: params.from,
    save,
    // A failed simulation is the interesting case when debugging, so persist it
    // on the same terms as a successful one rather than losing the trace.
    save_if_fails: params.saveIfFails ?? save,
    simulation_type: params.simulationType ?? 'full',
  };

  if (params.to !== undefined) body.to = params.to;
  // Tenderly names the calldata field `input`; `data` is the JSON-RPC spelling
  // exposed to callers, mapped here so both worlds read naturally.
  if (params.data !== undefined) body.input = params.data;
  if (params.value !== undefined) body.value = params.value;
  if (params.gas !== undefined) body.gas = params.gas;
  if (params.gasPrice !== undefined) body.gas_price = params.gasPrice;
  if (params.blockNumber !== undefined) body.block_number = params.blockNumber;
  if (params.transactionIndex !== undefined) body.transaction_index = params.transactionIndex;
  if (params.stateOverrides !== undefined) body.state_objects = params.stateOverrides;
  if (params.generateAccessList !== undefined) {
    body.generate_access_list = params.generateAccessList;
  }

  return body;
}

/** Statuses worth a second attempt: rate limiting and server-side faults. */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Low-level transport faults (reset connections, DNS blips) are retriable; a
 * timeout is not. Retrying a request that already burned the full timeout
 * budget just multiplies the wait past what an MCP client will sit through.
 */
function isRetriableTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT'].includes(code)
  );
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 10_000);
  return undefined;
}

/** Pulls the most specific message out of Tenderly's several error envelopes. */
function extractApiError(bodyText: string): { message?: string; code?: string } {
  try {
    const parsed = ApiErrorBodySchema.safeParse(JSON.parse(bodyText));
    if (!parsed.success) return {};
    const b = parsed.data;
    const message = b.error?.message ?? b.error_message ?? b.message ?? undefined;
    const code = b.error?.slug ?? b.error?.id ?? b.slug ?? undefined;
    // The `??` chains above already absorb null, so only undefined remains.
    return {
      ...(message !== undefined ? { message } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  } catch {
    return {};
  }
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TenderlyClientOptions {
  config: Config;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests so retry backoff does not sleep in the suite. */
  sleep?: (ms: number) => Promise<void>;
}

export class TenderlyClient {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TenderlyClientOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  private projectPath(suffix: string): string {
    const { accountSlug, projectSlug } = this.config;
    return `/api/v1/account/${accountSlug}/project/${projectSlug}${suffix}`;
  }

  /**
   * Issues one API call with timeout and bounded retry, and parses the response
   * through `schema`.
   *
   * Throws only `TenderlyApiError`, so every caller above this point has a
   * single failure type to reason about, with the original fault attached as
   * `cause`.
   */
  private async request<T>(options: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    query?: Record<string, string | number | undefined>;
  }): Promise<T> {
    const { method, path, body, schema, query } = options;

    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A fresh signal per attempt: an aborted signal cannot be reused.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.config.timeoutMs);

      try {
        this.logger.debug('tenderly request', { method, path, attempt });

        const response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            // Tenderly authenticates access tokens with this header, not Bearer.
            'X-Access-Key': this.config.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'mcp-tenderly',
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const { message, code } = extractApiError(text);
          const retriable = isRetriableStatus(response.status);

          const err = new TenderlyApiError(
            `Tenderly API returned ${response.status} ${response.statusText}${
              message !== undefined ? `: ${message}` : ''
            }`,
            {
              status: response.status,
              path,
              retriable,
              ...(code !== undefined ? { apiCode: code } : {}),
            }
          );

          if (retriable && attempt < MAX_ATTEMPTS) {
            const wait =
              parseRetryAfterMs(response.headers.get('retry-after')) ??
              BASE_BACKOFF_MS * 2 ** (attempt - 1);
            // Warn-and-retry lives here, at the retry boundary, so inner code
            // never has to decide whether a failure is worth alarming about.
            this.logger.warn('tenderly request failed, retrying', {
              path,
              status: response.status,
              attempt,
              waitMs: wait,
            });
            lastError = err;
            await this.sleep(wait);
            continue;
          }
          throw err;
        }

        const text = await response.text();
        let json: unknown;
        try {
          json = text === '' ? {} : JSON.parse(text);
        } catch (cause) {
          throw new TenderlyApiError(
            `Tenderly API returned a ${String(response.status)} with a body that is not JSON`,
            { status: response.status, path, cause }
          );
        }

        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new TenderlyApiError(
            `Tenderly API response did not match the expected shape for ${path}`,
            { status: response.status, path, cause: parsed.error }
          );
        }
        return parsed.data;
      } catch (err) {
        clearTimeout(timer);

        if (err instanceof TenderlyApiError) throw err;

        if (controller.signal.aborted) {
          throw new TenderlyApiError(
            `Tenderly API request timed out after ${this.config.timeoutMs}ms. A "full" simulation on a busy block can exceed this; raise TENDERLY_TIMEOUT_MS or use simulation_type "quick".`,
            { path, cause: err }
          );
        }

        if (isRetriableTransportError(err) && attempt < MAX_ATTEMPTS) {
          const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1);
          this.logger.warn('tenderly request transport error, retrying', {
            path,
            attempt,
            waitMs: wait,
            err,
          });
          lastError = err;
          await this.sleep(wait);
          continue;
        }

        throw new TenderlyApiError(`Could not reach the Tenderly API at ${path}`, {
          path,
          retriable: isRetriableTransportError(err),
          cause: err,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    // Reached only when the final attempt was itself a retriable failure.
    throw new TenderlyApiError(`Tenderly API did not succeed after ${MAX_ATTEMPTS} attempts`, {
      path,
      retriable: true,
      cause: lastError,
    });
  }

  async simulate(params: SimulateParams): Promise<SimulateResponse> {
    return this.request({
      method: 'POST',
      path: this.projectPath('/simulate'),
      body: toWireBody(params, { save: this.config.saveSimulations }),
      schema: SimulateResponseSchema,
    });
  }

  /**
   * Simulates transactions sequentially against shared state, so later
   * transactions observe the effects of earlier ones (an approve followed by a
   * transferFrom, for example).
   */
  async simulateBundle(simulations: SimulateParams[]): Promise<SimulateResponse[]> {
    const result = await this.request({
      method: 'POST',
      path: this.projectPath('/simulate-bundle'),
      body: {
        simulations: simulations.map((s) => toWireBody(s, { save: this.config.saveSimulations })),
      },
      schema: SimulateBundleResponseSchema,
    });
    return result.simulation_results ?? [];
  }

  async getSimulation(simulationId: string): Promise<SimulateResponse> {
    const result = await this.request({
      method: 'GET',
      path: this.projectPath(`/simulations/${encodeURIComponent(simulationId)}`),
      schema: GetSimulationResponseSchema,
    });

    // This endpoint nests the transaction inside `simulation`, where `/simulate`
    // returns it as a sibling. Normalise so downstream code sees one shape.
    const nested = result.simulation?.transaction ?? null;
    return {
      transaction: result.transaction ?? nested,
      simulation: result.simulation ?? null,
      contracts: result.contracts ?? null,
      generated_access_list: result.generated_access_list ?? null,
    };
  }

  async listSimulations(
    options: { page?: number; perPage?: number } = {}
  ): Promise<SimulateResponse[]> {
    const result = await this.request({
      method: 'GET',
      path: this.projectPath('/simulations'),
      schema: ListSimulationsResponseSchema,
      query: {
        ...(options.page !== undefined ? { page: options.page } : {}),
        ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
      },
    });
    return (result.simulations ?? []).map((simulation) => ({ simulation, transaction: null }));
  }
}
