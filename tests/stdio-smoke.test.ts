/**
 * End-to-end check over the real stdio transport.
 *
 * The unit suite cannot catch the two ways a stdio MCP server fails in
 * practice: something writes to stdout and corrupts the JSON-RPC framing, or
 * the protocol handshake itself is wrong. Both only appear when a real client
 * talks to a real spawned process, so this test spawns `dist/index.js` and
 * speaks the protocol to it, with a stub HTTP server standing in for Tenderly.
 *
 * Requires `npm run build` first — it exercises the shipped artefact, which is
 * the point.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { successResponse } from './helpers.js';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Stub Tenderly. Records requests so the test can assert on what was sent. */
function startStubTenderly(): Promise<{
  server: Server;
  url: string;
  requests: { path: string; accessKey: string | undefined; body: string }[];
}> {
  const requests: { path: string; accessKey: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const entry = {
      path: req.url ?? '',
      accessKey:
        typeof req.headers['x-access-key'] === 'string' ? req.headers['x-access-key'] : undefined,
      body: '',
    };
    requests.push(entry);
    req.on('data', (chunk: Buffer) => {
      entry.body += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(successResponse()));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, requests });
    });
  });
}

/** Speaks newline-delimited JSON-RPC to the child over stdio. */
class StdioClient {
  private buffer = '';
  private readonly pending = new Map<number, (value: JsonRpcResponse) => void>();
  readonly stderr: string[] = [];
  /** Anything on stdout that is not a JSON-RPC frame — always a bug. */
  readonly stdoutNoise: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line === '') continue;
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          const id = message.id;
          if (typeof id === 'number') {
            this.pending.get(id)?.(message);
            this.pending.delete(id);
          }
        } catch {
          this.stdoutNoise.push(line);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async request(
    id: number,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<JsonRpcResponse> {
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        reject(new Error(`timed out awaiting ${method}; stderr: ${this.stderr.join('')}`));
      }, 10_000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
}

describe('stdio server', () => {
  let stub: Awaited<ReturnType<typeof startStubTenderly>>;
  let child: ChildProcessWithoutNullStreams;
  let client: StdioClient;

  beforeAll(async () => {
    expect(existsSync(ENTRY), `${ENTRY} is missing — run "npm run build" first`).toBe(true);
    stub = await startStubTenderly();

    child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        TENDERLY_API_KEY: 'smoke-key',
        TENDERLY_ACCOUNT_SLUG: 'acme',
        TENDERLY_PROJECT_SLUG: 'widgets',
        TENDERLY_BASE_URL: stub.url,
        TENDERLY_LOG_LEVEL: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    client = new StdioClient(child);

    const init = await client.request(1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.0' },
    });
    expect(init.result?.serverInfo).toMatchObject({ name: 'mcp-tenderly' });
    client.notify('notifications/initialized');
  }, 30_000);

  afterAll(async () => {
    child.kill('SIGTERM');
    stub.server.close();
    await once(child, 'exit').catch(() => undefined);
  });

  it('advertises every tool with a description and an input schema', async () => {
    const response = await client.request(2, 'tools/list');
    const tools = (response.result?.tools ?? []) as {
      name: string;
      description?: string;
      inputSchema?: unknown;
    }[];

    expect(tools.map((t) => t.name).sort()).toEqual([
      'tenderly_get_simulation',
      'tenderly_list_simulations',
      'tenderly_simulate_bundle',
      'tenderly_simulate_transaction',
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy();
    }
  });

  it('runs a simulation end to end and returns a formatted digest', async () => {
    const response = await client.request(3, 'tools/call', {
      name: 'tenderly_simulate_transaction',
      arguments: {
        network: 'base',
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        data: '0xa9059cbb',
      },
    });

    const result = response.result as {
      content: { type: string; text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.isError).toBeFalsy();

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('SUCCESS');
    expect(text).toContain('## Call trace');
    expect(text).toContain('Transfer(');
    expect(result.structuredContent).toMatchObject({ status: 'success', gas_used: 51234 });

    // The request reached the stub on the project-scoped path, authenticated
    // with the access-key header rather than a bearer token.
    const call = stub.requests.at(-1);
    expect(call?.path).toBe('/api/v1/account/acme/project/widgets/simulate');
    expect(call?.accessKey).toBe('smoke-key');

    // "base" resolved to a chain id, and `data` was mapped onto Tenderly's
    // `input` field, all the way through the real transport.
    const wire = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
    expect(wire.network_id).toBe('8453');
    expect(wire.input).toBe('0xa9059cbb');
  });

  it('reports a bad argument as a tool error rather than dropping the connection', async () => {
    const response = await client.request(4, 'tools/call', {
      name: 'tenderly_simulate_transaction',
      arguments: { network: 'base', from: 'not-an-address' },
    });
    // Either an isError result or a JSON-RPC error is acceptable; a dead
    // connection is not.
    const result = response.result as
      { isError?: boolean; content?: { text: string }[] } | undefined;
    expect(response.error !== undefined || result?.isError === true).toBe(true);
  });

  it('names the unknown network and suggests alternatives', async () => {
    const response = await client.request(5, 'tools/call', {
      name: 'tenderly_simulate_transaction',
      arguments: {
        network: 'ethereum-goerli',
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
      },
    });
    const result = response.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('network');
  });

  // The whole reason logging goes to stderr: one stray console.log corrupts the
  // framing and the host silently drops the server.
  it('writes nothing but JSON-RPC frames to stdout', () => {
    expect(client.stdoutNoise).toEqual([]);
  });

  it('logs to stderr as structured JSON', () => {
    const lines = client.stderr
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    // The access key must never appear in logs.
    expect(client.stderr.join('')).not.toContain('smoke-key');
  });
});
