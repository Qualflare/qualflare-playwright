import { createRequire } from 'node:module';

import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  define: {
    // Mirrors tsup.config.ts's `define` — see src/config/version.ts for why
    // this is a build-time constant rather than a runtime read.
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
  },
});
