/**
 * Error taxonomy.
 *
 * The distinction that matters here is retriable vs terminal, decided once at
 * the point where the HTTP status is known and consumed by the retry loop in
 * the client. Callers above that boundary only need to know whether a failure
 * is worth reporting to the model as "try again" or "this will never work".
 */

/** Configuration is wrong or missing; the process should refuse to start. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface TenderlyApiErrorInit {
  status?: number;
  /** Tenderly's own error slug, e.g. `unauthorized`, when the body carries one. */
  apiCode?: string;
  /** Endpoint path, with credentials already stripped. */
  path?: string;
  retriable?: boolean;
  cause?: unknown;
}

/**
 * A call to the Tenderly REST API failed. Wraps the underlying transport or
 * HTTP failure rather than replacing it, so the cause chain survives to the
 * logging boundary.
 */
export class TenderlyApiError extends Error {
  override readonly name = 'TenderlyApiError';
  readonly status: number | undefined;
  readonly apiCode: string | undefined;
  readonly path: string | undefined;
  readonly retriable: boolean;

  constructor(message: string, init: TenderlyApiErrorInit = {}) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.status = init.status;
    this.apiCode = init.apiCode;
    this.path = init.path;
    this.retriable = init.retriable ?? false;
  }
}

/** The caller passed something the Tenderly API cannot accept. */
export class InvalidArgumentError extends Error {
  override readonly name = 'InvalidArgumentError';
}

/**
 * Renders an error and its cause chain as a single line. Used for the text a
 * tool hands back to the model, which cannot read structured log fields.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    current = current.cause;
  }
  if (parts.length === 0) return typeof err === 'string' ? err : JSON.stringify(err);
  return parts.join(': ');
}

/**
 * Actionable guidance for the failures a user actually hits, keyed on status.
 * Kept next to the error type because the remedy is a property of the failure,
 * not of the call site.
 */
export function remediationFor(err: unknown): string | undefined {
  if (!(err instanceof TenderlyApiError)) return undefined;
  switch (err.status) {
    case 401:
    case 403:
      return 'Check TENDERLY_API_KEY. It must be an access token from Account Settings -> Access Tokens, and the token must belong to an account with access to TENDERLY_ACCOUNT_SLUG.';
    case 404:
      return 'Either the requested resource does not exist in this project, or the project itself is wrong. Check the simulation id first, then TENDERLY_ACCOUNT_SLUG and TENDERLY_PROJECT_SLUG — both are the slugs from your dashboard URL (dashboard.tenderly.co/<account>/<project>), not display names.';
    case 429:
      return 'Tenderly rate-limited this request. Free-tier projects have a monthly simulation quota and a per-minute rate limit; wait and retry, or pass save=false to avoid consuming stored-simulation quota.';
    default:
      return undefined;
  }
}
