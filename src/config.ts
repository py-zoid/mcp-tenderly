/**
 * The single typed view of this server's configuration.
 *
 * Nothing else in the codebase reads `process.env`. Validation happens once, at
 * startup, so a misconfigured server refuses to start with a message naming the
 * variable at fault rather than failing inside the first tool call.
 */

import { z } from 'zod';
import { ConfigError } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

const DEFAULT_BASE_URL = 'https://api.tenderly.co';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Treats an empty or whitespace-only variable as absent. An exported-but-empty
 * shell variable is the single most common way these get "set" without being
 * set, and reporting it as missing is far more useful than a 401 later.
 */
const RequiredString = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: 'must not be empty' });

/**
 * Tenderly slugs appear in URLs, so they are restricted to URL-safe characters.
 * Rejecting a slug with a slash in it here turns a confusing 404 into a clear
 * message — users often paste `account/project` into one variable.
 */
const Slug = RequiredString.refine((s) => /^[A-Za-z0-9._-]+$/.test(s), {
  message:
    'must be a URL slug (letters, digits, dot, underscore, hyphen) — copy it from your dashboard URL, and do not include a slash',
});

const Booleanish = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => ['true', 'false', '1', '0', 'yes', 'no'].includes(s), {
    message: 'must be one of: true, false, 1, 0, yes, no',
  })
  .transform((s) => s === 'true' || s === '1' || s === 'yes');

const PositiveInt = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => /^\d+$/.test(s) && Number(s) > 0, { message: 'must be a positive integer' })
  .transform(Number);

const EnvSchema = z.object({
  TENDERLY_API_KEY: RequiredString,
  TENDERLY_ACCOUNT_SLUG: Slug,
  TENDERLY_PROJECT_SLUG: Slug,
  TENDERLY_SAVE_SIMULATIONS: Booleanish.optional(),
  TENDERLY_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  TENDERLY_TIMEOUT_MS: PositiveInt.optional(),
  TENDERLY_BASE_URL: z.url().optional(),
});

export interface Config {
  readonly apiKey: string;
  readonly accountSlug: string;
  readonly projectSlug: string;
  readonly baseUrl: string;
  readonly saveSimulations: boolean;
  readonly logLevel: LogLevel;
  readonly timeoutMs: number;
}

/** Environment source, injectable so tests never mutate `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Drops absent and empty-string variables before validation so that optional
 * fields fall through to their defaults instead of failing their refinements.
 */
function compact(env: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function loadConfig(env: EnvSource = process.env): Config {
  const parsed = EnvSchema.safeParse(compact(env));

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const name = issue.path.join('.') || '(root)';
        const reason = issue.code === 'invalid_type' ? 'is required but not set' : issue.message;
        return `  - ${name}: ${reason}`;
      })
      .join('\n');
    throw new ConfigError(
      `Invalid Tenderly configuration:\n${details}\n\n` +
        'Set these in your MCP client config (the "env" block of your server entry) or in a .env file. ' +
        'See .env.example for where each value comes from.'
    );
  }

  const e = parsed.data;
  return {
    apiKey: e.TENDERLY_API_KEY,
    accountSlug: e.TENDERLY_ACCOUNT_SLUG,
    projectSlug: e.TENDERLY_PROJECT_SLUG,
    baseUrl: (e.TENDERLY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    saveSimulations: e.TENDERLY_SAVE_SIMULATIONS ?? true,
    logLevel: e.TENDERLY_LOG_LEVEL ?? 'info',
    timeoutMs: e.TENDERLY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Dashboard URL for a saved simulation. Safe to embed in tool output. */
export function simulationUrl(config: Config, simulationId: string): string {
  return `https://dashboard.tenderly.co/${config.accountSlug}/${config.projectSlug}/simulator/${simulationId}`;
}
