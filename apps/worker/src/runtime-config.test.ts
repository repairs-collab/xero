import { describe, expect, it } from 'vitest';

import {
  databaseUrlFromEnvironment,
  parseOperationalResetCommand,
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

  it('parses fixed operational-reset commands without provider credentials', () => {
    const organisationId = 'f0a9be0f-a5a2-47ac-a951-5ff419311dfa';
    const resetRunId = '2e7d7c78-c10b-4d3e-b81a-ce3b7cc6c0f0';
    expect(
      parseOperationalResetCommand([
        'operational-reset',
        'prepare',
        '--organisation-id',
        organisationId,
        '--run-id',
        resetRunId,
        '--deployed-commit',
        '0123456789abcdef0123456789abcdef01234567',
        '--admin-email',
        'repairs@motts.com.au',
        '--acknowledgement',
        'acknowledged',
        '--expected-version',
        '4'
      ])
    ).toEqual({
      kind: 'prepare',
      input: {
        organisationId,
        resetRunId,
        deployedCommit: '0123456789abcdef0123456789abcdef01234567',
        adminEmail: 'repairs@motts.com.au',
        acknowledgement: 'acknowledged',
        expectedVersion: 4
      }
    });
    expect(
      parseOperationalResetCommand([
        'operational-reset',
        'execute',
        '--organisation-id',
        organisationId,
        '--run-id',
        resetRunId,
        '--snapshot-id',
        'accountpulse-snapshot-1'
      ])
    ).toEqual({
      kind: 'execute',
      input: {
        organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-snapshot-1'
      }
    });
    expect(
      parseOperationalResetCommand([
        'operational-reset',
        'abort',
        '--organisation-id',
        organisationId,
        '--run-id',
        resetRunId,
        '--admin-email',
        'repairs@motts.com.au',
        '--reason',
        'Snapshot failed'
      ])
    ).toEqual({
      kind: 'abort',
      input: {
        organisationId,
        resetRunId,
        adminEmail: 'repairs@motts.com.au',
        reason: 'Snapshot failed'
      }
    });
    expect(parseOperationalResetCommand([])).toBeNull();
    expect(() => parseOperationalResetCommand(['unknown'])).toThrow(
      'Unsupported worker command'
    );
    expect(() =>
      parseOperationalResetCommand([
        'operational-reset',
        'execute',
        '--organisation-id',
        organisationId,
        '--run-id',
        resetRunId
      ])
    ).toThrow('snapshot-id is required');
  });
});
