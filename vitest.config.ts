import { defineConfig } from 'vitest/config';

// Two projects:
//  - unit: no external services, always runs (`pnpm test`).
//  - integration: needs `docker compose up` (Postgres + S3 storage), `pnpm test:integration`.
export default defineConfig({
  resolve: { conditions: ['@cms/source'] },
  ssr: { resolve: { conditions: ['@cms/source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/src/**/*.int.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
