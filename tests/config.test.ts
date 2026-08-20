import { describe, expect, it } from 'vitest';
import { loadConfig, simulationUrl } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const valid = {
  TENDERLY_API_KEY: 'key-123',
  TENDERLY_ACCOUNT_SLUG: 'acme',
  TENDERLY_PROJECT_SLUG: 'widgets',
};

describe('loadConfig', () => {
  it('accepts the three required variables and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.apiKey).toBe('key-123');
    expect(config.accountSlug).toBe('acme');
    expect(config.projectSlug).toBe('widgets');
    expect(config.baseUrl).toBe('https://api.tenderly.co');
    expect(config.saveSimulations).toBe(true);
    expect(config.logLevel).toBe('info');
    expect(config.timeoutMs).toBe(30_000);
  });

  it('reports every missing variable at once, naming each', () => {
    let message = '';
    try {
      loadConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('TENDERLY_API_KEY');
    expect(message).toContain('TENDERLY_ACCOUNT_SLUG');
    expect(message).toContain('TENDERLY_PROJECT_SLUG');
  });

  // An exported-but-empty shell variable is the most common way these are
  // "set" without being set.
  it('treats an empty string as missing rather than as a value', () => {
    expect(() => loadConfig({ ...valid, TENDERLY_API_KEY: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, TENDERLY_API_KEY: '   ' })).toThrow(ConfigError);
  });

  it('trims surrounding whitespace off values', () => {
    expect(loadConfig({ ...valid, TENDERLY_API_KEY: '  key-123  ' }).apiKey).toBe('key-123');
  });

  // Pasting "account/project" into one variable would otherwise surface as a 404.
  it('rejects a slug containing a slash', () => {
    expect(() => loadConfig({ ...valid, TENDERLY_PROJECT_SLUG: 'acme/widgets' })).toThrow(
      /URL slug/
    );
  });

  it('parses the booleanish save flag in both directions', () => {
    expect(loadConfig({ ...valid, TENDERLY_SAVE_SIMULATIONS: 'false' }).saveSimulations).toBe(
      false
    );
    expect(loadConfig({ ...valid, TENDERLY_SAVE_SIMULATIONS: '0' }).saveSimulations).toBe(false);
    expect(loadConfig({ ...valid, TENDERLY_SAVE_SIMULATIONS: 'no' }).saveSimulations).toBe(false);
    expect(loadConfig({ ...valid, TENDERLY_SAVE_SIMULATIONS: 'TRUE' }).saveSimulations).toBe(true);
  });

  it('rejects a non-boolean save flag instead of coercing it', () => {
    expect(() => loadConfig({ ...valid, TENDERLY_SAVE_SIMULATIONS: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => loadConfig({ ...valid, TENDERLY_TIMEOUT_MS: 'soon' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, TENDERLY_TIMEOUT_MS: '0' })).toThrow(ConfigError);
    expect(loadConfig({ ...valid, TENDERLY_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
  });

  it('strips trailing slashes from a custom base url', () => {
    expect(loadConfig({ ...valid, TENDERLY_BASE_URL: 'https://proxy.test/' }).baseUrl).toBe(
      'https://proxy.test'
    );
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...valid, TENDERLY_LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });
});

describe('simulationUrl', () => {
  it('builds the dashboard simulator url from the account and project slugs', () => {
    expect(simulationUrl(loadConfig(valid), 'sim-1')).toBe(
      'https://dashboard.tenderly.co/acme/widgets/simulator/sim-1'
    );
  });
});
