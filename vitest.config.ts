import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'unit',
          include: [
            'packages/**/*.test.ts',
            'packages/**/*.test.tsx',
            'apps/**/*.test.ts',
            'apps/**/*.test.tsx',
            'infra/**/*.test.ts'
          ],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**']
        }
      },
      {
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'integration',
          globalSetup: ['test/integration-global-setup.tsx'],
          include: ['**/*.integration.test.ts', '**/*.integration.test.tsx']
        }
      }
    ]
  }
});
