import { describe, expect, it } from 'vitest';

import {
  createEnvironmentSecretReader,
  databaseUrlFromEnvironment,
  parseApprovedSmsRecoveryCommand,
  parseDebtContactHolidayDates,
  parseInboundReplyRecoveryCommand,
  parseOperationalResetCommand,
  parseProviderCredentials,
  parseXeroWorkerConfiguration
} from './runtime-config.js';

describe('worker runtime configuration', () => {
  it('parses the explicitly configured debt-contact holiday calendar', () => {
    expect(
      parseDebtContactHolidayDates({
        NODE_ENV: 'production',
        DEBT_CONTACT_HOLIDAY_DATES_JSON: '["2026-01-01","2026-12-25"]'
      })
    ).toEqual(['2026-01-01', '2026-12-25']);
  });

  it('requires an explicit debt-contact holiday calendar in production', () => {
    expect(() =>
      parseDebtContactHolidayDates({ NODE_ENV: 'production' })
    ).toThrow('DEBT_CONTACT_HOLIDAY_DATES_JSON is required in production');
    expect(() =>
      parseDebtContactHolidayDates({
        NODE_ENV: ' production ',
        DEBT_CONTACT_HOLIDAY_DATES_JSON: '   '
      })
    ).toThrow('DEBT_CONTACT_HOLIDAY_DATES_JSON is required in production');
    expect(parseDebtContactHolidayDates({ NODE_ENV: 'test' })).toEqual([]);
  });

  it.each([
    ['malformed JSON', '["2026-01-01"'],
    ['a non-array value', '{"date":"2026-01-01"}'],
    ['a non-string item', '[20260101]'],
    ['a non-canonical date', '["2026-1-01"]'],
    ['an impossible date', '["2026-02-29"]'],
    ['a duplicate date', '["2026-01-01","2026-01-01"]']
  ])('rejects %s in the debt-contact holiday calendar', (_case, source) => {
    expect(() =>
      parseDebtContactHolidayDates({
        NODE_ENV: 'production',
        DEBT_CONTACT_HOLIDAY_DATES_JSON: source
      })
    ).toThrow('DEBT_CONTACT_HOLIDAY_DATES_JSON must be a JSON array of unique YYYY-MM-DD dates');
  });

  it('resolves a hosting-neutral environment secret reference', async () => {
    const reader = createEnvironmentSecretReader({
      RETELL_API_KEY: 'private-retell-key'
    });

    await expect(reader.read('env:RETELL_API_KEY')).resolves.toBe(
      'private-retell-key'
    );
    await expect(reader.read('RETELL_API_KEY')).resolves.toBe(
      'private-retell-key'
    );
  });

  it('rejects unsafe or unavailable secret references without exposing them', async () => {
    const reader = createEnvironmentSecretReader({});

    await expect(reader.read('env:retell-api-key')).rejects.toThrow(
      'Secret reference is invalid'
    );
    const missing = await reader.read('env:RETELL_API_KEY').catch(
      (error: unknown) => error
    );
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toBe('Managed secret is unavailable');
    expect((missing as Error).message).not.toContain('RETELL_API_KEY');
  });

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

  it('requires customer OAuth and token-encryption configuration while leaving legacy Xero optional', () => {
    expect(
      parseProviderCredentials({
        XERO_OAUTH_CLIENT_ID: 'customer-oauth-id',
        XERO_OAUTH_CLIENT_SECRET: 'customer-oauth-secret',
        XERO_OAUTH_REDIRECT_URI: 'https://ap.motts.com.au/xero/callback',
        XERO_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
          primary: Buffer.alloc(32, 7).toString('base64')
        }),
        XERO_TOKEN_ACTIVE_KEY_ID: 'primary',
        SINCH_API_CREDENTIALS: JSON.stringify({
          apiKey: 'sinch-key',
          apiSecret: 'sinch-secret'
        })
      })
    ).toEqual({
      xero: null,
      xeroOAuth: {
        clientId: 'customer-oauth-id',
        clientSecret: 'customer-oauth-secret',
        redirectUri: 'https://ap.motts.com.au/xero/callback'
      },
      xeroTokenEncryption: {
        keysJson: JSON.stringify({
          primary: Buffer.alloc(32, 7).toString('base64')
        }),
        activeKeyId: 'primary'
      },
      sinch: {
        apiKey: 'sinch-key',
        apiSecret: 'sinch-secret'
      }
    });
    expect(() => parseXeroWorkerConfiguration({})).toThrow(
      'XERO_OAUTH_CLIENT_ID is required'
    );
  });

  it('parses legacy Custom Connection credentials only when supplied', () => {
    const base = {
      XERO_OAUTH_CLIENT_ID: 'customer-oauth-id',
      XERO_OAUTH_CLIENT_SECRET: 'customer-oauth-secret',
      XERO_OAUTH_REDIRECT_URI: 'https://ap.motts.com.au/xero/callback',
      XERO_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
        primary: Buffer.alloc(32, 9).toString('base64')
      }),
      XERO_TOKEN_ACTIVE_KEY_ID: 'primary'
    };
    expect(parseXeroWorkerConfiguration(base).legacyCredentials).toBeNull();
    expect(
      parseXeroWorkerConfiguration({
        ...base,
        XERO_API_CREDENTIALS: JSON.stringify({
          clientId: 'legacy-id',
          clientSecret: 'legacy-secret'
        })
      }).legacyCredentials
    ).toEqual({ clientId: 'legacy-id', clientSecret: 'legacy-secret' });
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

  it('parses protected approved-SMS recovery commands', () => {
    const organisationId = 'f0a9be0f-a5a2-47ac-a951-5ff419311dfa';
    expect(
      parseApprovedSmsRecoveryCommand([
        'recover-approved-sms',
        'preview',
        '--organisation-id',
        organisationId,
        '--local-date',
        '2026-09-30'
      ])
    ).toEqual({
      kind: 'preview',
      input: { organisationId, localDate: '2026-09-30' }
    });
    expect(
      parseApprovedSmsRecoveryCommand([
        'recover-approved-sms',
        'execute',
        '--organisation-id',
        organisationId,
        '--local-date',
        '2026-09-30',
        '--expected-count',
        '12',
        '--expected-digest',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '--acknowledgement',
        'RECOVER APPROVED UNSENT SMS FOR 2026-09-30'
      ])
    ).toEqual({
      kind: 'execute',
      input: {
        organisationId,
        localDate: '2026-09-30',
        expectedCount: 12,
        expectedDigest:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        acknowledgement: 'RECOVER APPROVED UNSENT SMS FOR 2026-09-30'
      }
    });
    expect(parseApprovedSmsRecoveryCommand([])).toBeNull();
    expect(() =>
      parseApprovedSmsRecoveryCommand([
        'recover-approved-sms',
        'execute',
        '--organisation-id',
        organisationId,
        '--local-date',
        '2026-09-30',
        '--expected-count',
        '-1',
        '--acknowledgement',
        'wrong'
      ])
    ).toThrow('expected-count is invalid');
  });

  it('parses the bounded inbound reply recovery command', () => {
    expect(
      parseInboundReplyRecoveryCommand([
        'recover-inbound-replies',
        '--organisation-id',
        'f0a9be0f-a5a2-47ac-a951-5ff419311dfa'
      ])
    ).toEqual({
      organisationId: 'f0a9be0f-a5a2-47ac-a951-5ff419311dfa'
    });
    expect(
      parseInboundReplyRecoveryCommand(['recover-inbound-replies'])
    ).toEqual({});
    expect(parseInboundReplyRecoveryCommand([])).toBeNull();
    expect(() =>
      parseInboundReplyRecoveryCommand([
        'recover-inbound-replies',
        '--organisation-id',
        'f0a9be0f-a5a2-47ac-a951-5ff419311dfa',
        '--unexpected',
        'value'
      ])
    ).toThrow('unexpected is not supported');
  });
});
