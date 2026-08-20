/**
 * Structured logging for a stdio MCP server.
 *
 * The critical constraint: under the stdio transport, stdout carries
 * newline-delimited JSON-RPC frames. Anything else written there corrupts the
 * stream and the client drops the connection — so every log line goes to
 * stderr, which MCP hosts surface as server logs.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Flat context object. Nested structures are allowed but discouraged. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/**
 * Serialises an Error including its `cause` chain, which is how this codebase
 * carries the "what were we attempting" context up to the logging boundary.
 */
function serialiseError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if (err.stack !== undefined) out.stack = err.stack;
  for (const [key, value] of Object.entries(err)) {
    if (key !== 'cause') out[key] = value;
  }
  if (err.cause !== undefined) out.cause = serialiseError(err.cause);
  return out;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serialiseError(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function createLogger(options: {
  level: LogLevel;
  stream?: { write(s: string): void };
}): Logger {
  const threshold = LEVEL_RANK[options.level];
  const stream = options.stream ?? process.stderr;

  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[level] < threshold) return;

    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      name: 'mcp-tenderly',
      msg: message,
    };
    // Omit empty context rather than emitting a bare `{}`.
    if (context !== undefined && Object.keys(context).length > 0) {
      for (const [key, value] of Object.entries(context)) {
        record[key] = value instanceof Error ? serialiseError(value) : value;
      }
    }

    let line: string;
    try {
      line = JSON.stringify(record, replacer);
    } catch {
      // A context value with a circular reference must not take down the
      // server; degrade to the message alone.
      line = JSON.stringify({ level, time: record.time, name: 'mcp-tenderly', msg: message });
    }
    stream.write(`${line}\n`);
  };

  return {
    debug: (m, c) => {
      emit('debug', m, c);
    },
    info: (m, c) => {
      emit('info', m, c);
    },
    warn: (m, c) => {
      emit('warn', m, c);
    },
    error: (m, c) => {
      emit('error', m, c);
    },
  };
}
