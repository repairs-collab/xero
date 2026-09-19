import { describe, expect, it } from 'vitest';

import { parseRuntimeEnv } from './env.js';

describe('parseRuntimeEnv', () => {
  it('rejects live sending without an explicit acknowledgement', () => {
    expect(() =>
      parseRuntimeEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://bc5000:bc5000@localhost:5432/bc5000',
        AWS_REGION: 'ap-southeast-2',
        SEND_MODE: 'live'
      })
    ).toThrow('LIVE_SEND_ACK');
  });
});
