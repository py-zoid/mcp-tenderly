import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The suite is pure-unit: the Tenderly client is exercised against an
    // injected fetch, never the network.
    restoreMocks: true,
    unstubEnvs: true,
  },
});
