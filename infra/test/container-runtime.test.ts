import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const runtimeImage = 'node:24.19.0-alpine3.23';
const dockerfiles = ['apps/web/Dockerfile', 'apps/worker/Dockerfile'];

describe('production container runtimes', () => {
  it.each(dockerfiles)('%s uses the pinned minimal Alpine runtime', (dockerfile) => {
    const contents = readFileSync(resolve(process.cwd(), dockerfile), 'utf8');

    expect(contents).toContain(`FROM ${runtimeImage} AS runtime`);
    expect(contents).not.toContain('FROM node:24.19.0-bookworm-slim AS runtime');
    expect(contents).toContain('RUN apk upgrade --no-cache');
    expect(contents).toContain('/usr/local/lib/node_modules/npm');
    expect(contents).toContain('USER node');
  });

  it('provides Node require support to bundled worker dependencies', () => {
    const contents = readFileSync(
      resolve(process.cwd(), 'apps/worker/Dockerfile'),
      'utf8'
    );

    expect(contents).toContain(
      `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`
    );
  });
});
