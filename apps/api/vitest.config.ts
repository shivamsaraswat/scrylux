import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Files whose transactions are long enough to stall the rest of the suite while they run.
const HEAVY = 'test/contract/v1/exchange-bound.test.ts';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to source, including inside globalSetup (which Vitest loads
    // outside the `ssr` environment, so export conditions alone don't reach it).
    alias: {
      '@scrylux/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@scrylux/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@scrylux/threat-library': fileURLToPath(new URL('../../packages/threat-library/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/env.setup.ts'],
    // Two groups, the second after the first has finished. exchange-bound.test.ts imports and exports the largest threat
    // model, each in one transaction of several seconds on a shared runner. generate-atomicity.test.ts creates and drops
    // a trigger on `threats` and `mitigations`, which waits for every transaction that has touched them and makes the
    // ones after it wait in turn, so run alongside the bound test it stalled past its 5 s timeout (measured: 90 ms alone,
    // 2.5 s overlapping, on a faster machine than CI). Nothing is skipped, loosened or reordered within a group.
    projects: [
      {
        extends: true,
        test: { name: 'api', include: ['test/**/*.test.ts'], exclude: [HEAVY], sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: { name: 'bounds', include: [HEAVY], sequence: { groupOrder: 2 } },
      },
    ],
  },
});
