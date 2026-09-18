import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: 'react-jsx' },
  test: {
    passWithNoTests: true,
    projects: [
      {
        oxc: { jsx: 'react-jsx' },
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
        oxc: { jsx: 'react-jsx' },
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts', '**/*.integration.test.tsx']
        }
      }
    ]
  }
});
