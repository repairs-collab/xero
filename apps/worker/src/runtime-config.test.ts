import { describe, expect, it } from 'vitest';

import {
  databaseUrlFromEnvironment,
  parseProviderCredentials
} from './runtime-config.js';

describe('worker runtime configuration', () => {
  it('constructs a URL without corrupting reserved credential characters', () => {
    expect(
      databaseUrlFromEnvironment({
        DATABASE_HOST: 'private.example',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'bc5000',
        DATABASE_USER: 'bill@chaser',
        DATABASE_PASSWORD: 'safe:/?#[]@!'
      })
    ).toBe(
      'postgresql://bill%40chaser:safe%3A%2F%3F%23%5B%5D%40!@private.example:5432/bc5000'
    );
  });

  it('requires the exact provider credential fields', () => {
    expect(
      parseProviderCredentials({
        XERO_API_CREDENTIALS: JSON.stringify({
          clientId: 'xero-id',
          clientSecret: 'xero-secret'
        }),
        SINCH_API_CREDENTIALS: JSON.stringify({
          apiKey: 'sinch-key',
          apiSecret: 'sinch-secret'
        })
      })
    ).toEqual({
      xero: { clientId: 'xero-id', clientSecret: 'xero-secret' },
      sinch: {
        apiKey: 'sinch-key',
        apiSecret: 'sinch-secret'
      }
    });
  });
});
