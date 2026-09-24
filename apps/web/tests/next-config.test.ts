import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.js';

describe('Next.js production proxy configuration', () => {
  it('allows Server Actions from both deployed public hostnames', () => {
    expect(nextConfig.experimental?.serverActions?.allowedOrigins).toEqual([
      'staging-billchaser.motts.com.au',
      'billchaser.motts.com.au'
    ]);
  });
});
