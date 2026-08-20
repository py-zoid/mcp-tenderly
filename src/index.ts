#!/usr/bin/env node
/**
 * Entry point for the stdio transport.
 *
 * Two rules govern everything in this file. Stdout belongs to the JSON-RPC
 * framing, so nothing else may be written there — every diagnostic goes to
 * stderr. And a configuration fault must fail here, before the transport is
 * connected, with a message a human can act on: an MCP client shows the user
 * server logs, not a stack trace they can interpret.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logger.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const { server } = buildServer({ config, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('server ready', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    account: config.accountSlug,
    project: config.projectSlug,
    // Deliberately absent: apiKey. Never logged, not even truncated.
    saveSimulations: config.saveSimulations,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    void server
      .close()
      .catch((err: unknown) => {
        logger.error('error while closing server', { err });
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  // The host closing stdin is the normal end of a stdio session.
  process.stdin.on('close', () => {
    shutdown('stdin-close');
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason });
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    // Plain text, not JSON: this is the one message a human reads directly out
    // of their client's server log, and it must be immediately legible.
    process.stderr.write(`\n${SERVER_NAME}: ${err.message}\n\n`);
    process.exit(78); // EX_CONFIG
  }
  const logger = createLogger({ level: 'error' });
  logger.error('failed to start server', { err });
  process.exit(1);
});
