import { describe, expect, it } from 'vitest';
import { describeNetwork, nativeSymbol, resolveNetworkId } from '../src/tenderly/networks.js';

describe('resolveNetworkId', () => {
  it('resolves known names to chain ids', () => {
    expect(resolveNetworkId('ethereum')).toBe('1');
    expect(resolveNetworkId('mainnet')).toBe('1');
    expect(resolveNetworkId('base')).toBe('8453');
    expect(resolveNetworkId('arbitrum')).toBe('42161');
    expect(resolveNetworkId('polygon')).toBe('137');
  });

  it('is case- and separator-insensitive', () => {
    expect(resolveNetworkId('Base-Sepolia')).toBe('84532');
    expect(resolveNetworkId('base_sepolia')).toBe('84532');
    expect(resolveNetworkId('BASE SEPOLIA')).toBe('84532');
  });

  // An unlisted chain must never be blocked by the name table.
  it('passes numeric ids through as strings', () => {
    expect(resolveNetworkId(8453)).toBe('8453');
    expect(resolveNetworkId('8453')).toBe('8453');
    expect(resolveNetworkId('999999')).toBe('999999');
  });

  it('rejects a non-positive or fractional chain id', () => {
    expect(() => resolveNetworkId(0)).toThrow(/positive integer/);
    expect(() => resolveNetworkId(-1)).toThrow(/positive integer/);
    expect(() => resolveNetworkId(1.5)).toThrow(/positive integer/);
  });

  it('suggests near matches for an unknown name', () => {
    expect(() => resolveNetworkId('arbitrum-goerli')).toThrow(/Did you mean/);
  });

  it('rejects an empty network', () => {
    expect(() => resolveNetworkId('  ')).toThrow(/must not be empty/);
  });
});

describe('describeNetwork', () => {
  it('labels a known chain with its canonical name', () => {
    expect(describeNetwork('1')).toBe('ethereum (1)');
    expect(describeNetwork('8453')).toBe('base (8453)');
  });

  it('falls back to the bare id for an unknown chain', () => {
    expect(describeNetwork('424242')).toBe('chain 424242');
  });
});

describe('nativeSymbol', () => {
  it('returns the native currency for chains that are not ETH', () => {
    expect(nativeSymbol('137')).toBe('POL');
    expect(nativeSymbol('56')).toBe('BNB');
    expect(nativeSymbol('43114')).toBe('AVAX');
  });

  it('defaults to ETH for rollups and mainnet', () => {
    expect(nativeSymbol('1')).toBe('ETH');
    expect(nativeSymbol('8453')).toBe('ETH');
  });
});
