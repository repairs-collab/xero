import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
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
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts', '**/*.integration.test.tsx']
        }
      }
    ]
  }
});
