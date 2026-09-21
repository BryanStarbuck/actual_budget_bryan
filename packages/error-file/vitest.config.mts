import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: process.env.CI
      ? [
          'default',
          [
            'junit',
            { outputFile: './test-results/junit.xml', suiteName: 'error-file' },
          ],
        ]
      : ['default'],
  },
});
