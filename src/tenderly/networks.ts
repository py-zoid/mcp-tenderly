/**
 * Chain-name to chain-id resolution.
 *
 * Tenderly's `network_id` is the numeric chain id as a string. Requiring the
 * model to know that Base is 8453 wastes a turn and invites hallucinated ids,
 * so names are accepted and resolved here. The list is deliberately just the
 * chains Tenderly's simulator supports on a free plan; a numeric id always
 * passes through untouched, so an unlisted chain is never blocked by this map.
 */

export const NETWORKS: Readonly<Record<string, number>> = {
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  holesky: 17000,
  hoodi: 560048,

  polygon: 137,
  'polygon-amoy': 80002,
  'polygon-zkevm': 1101,

  arbitrum: 42161,
  'arbitrum-one': 42161,
  'arbitrum-nova': 42170,
  'arbitrum-sepolia': 421614,

  optimism: 10,
  'optimism-sepolia': 11155420,

  base: 8453,
  'base-sepolia': 84532,

  bsc: 56,
  'bnb-chain': 56,
  'bsc-testnet': 97,

  avalanche: 43114,
  'avalanche-fuji': 43113,

  gnosis: 100,
  linea: 59144,
  'linea-sepolia': 59141,
  scroll: 534352,
  'scroll-sepolia': 534351,
  zksync: 324,
  'zksync-sepolia': 300,
  blast: 81457,
  mantle: 5000,
  fantom: 250,
  celo: 42220,
  moonbeam: 1284,
  moonriver: 1285,
  zora: 7777777,
  unichain: 130,
  'unichain-sepolia': 1301,
  berachain: 80094,
  sonic: 146,
  ronin: 2020,
  cronos: 25,
  boba: 288,
  fraxtal: 252,
  mode: 34443,
  metis: 1088,
  taiko: 167000,
  immutable: 13371,
  'world-chain': 480,
  ink: 57073,
  abstract: 2741,
  sei: 1329,
  'sei-testnet': 1328,
  kaia: 8217,
  swellchain: 1923,
  lisk: 1135,
  soneium: 1868,
  corn: 21000000,
  hyperevm: 999,
};

/** Reverse lookup for display, preferring the canonical (first-listed) name. */
const DISPLAY_NAMES: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [name, id] of Object.entries(NETWORKS)) {
    if (!map.has(id)) map.set(id, name);
  }
  return map;
})();

/**
 * Accepts a chain id (number or numeric string) or a known network name and
 * returns the id as the string Tenderly expects.
 *
 * @throws Error naming the closest known alternatives when the input is neither.
 */
export function resolveNetworkId(network: string | number): string {
  if (typeof network === 'number') {
    if (!Number.isInteger(network) || network <= 0) {
      throw new Error(`Invalid chain id: ${network}. Expected a positive integer.`);
    }
    return String(network);
  }

  const raw = network.trim();
  if (raw === '') throw new Error('Network must not be empty.');
  if (/^\d+$/.test(raw)) return raw;

  const key = raw.toLowerCase().replace(/[\s_]+/g, '-');
  const id = NETWORKS[key];
  if (id !== undefined) return String(id);

  const suggestions = Object.keys(NETWORKS)
    .filter((name) => name.includes(key) || key.includes(name))
    .slice(0, 5);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(', ')}?`
      : ' Pass a numeric chain id if the network is not in the known-name list.';
  throw new Error(`Unknown network "${network}".${hint}`);
}

/** Human label for output, e.g. `ethereum (1)`. Never throws. */
export function describeNetwork(networkId: string): string {
  const numeric = Number(networkId);
  const name = Number.isFinite(numeric) ? DISPLAY_NAMES.get(numeric) : undefined;
  return name !== undefined ? `${name} (${networkId})` : `chain ${networkId}`;
}

/** Native currency symbol, used only to label value and balance deltas. */
export function nativeSymbol(networkId: string): string {
  switch (networkId) {
    case '137':
    case '80002':
      return 'POL';
    case '56':
    case '97':
      return 'BNB';
    case '43114':
    case '43113':
      return 'AVAX';
    case '100':
      return 'xDAI';
    case '250':
      return 'FTM';
    case '42220':
      return 'CELO';
    case '1284':
      return 'GLMR';
    case '1285':
      return 'MOVR';
    case '5000':
      return 'MNT';
    case '1088':
      return 'METIS';
    case '25':
      return 'CRO';
    case '2020':
      return 'RON';
    case '8217':
      return 'KAIA';
    case '146':
      return 'S';
    case '80094':
      return 'BERA';
    case '999':
      return 'HYPE';
    case '13371':
      return 'IMX';
    case '1329':
    case '1328':
      return 'SEI';
    default:
      return 'ETH';
  }
}
