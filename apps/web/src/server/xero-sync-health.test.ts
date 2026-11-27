import { describe, expect, it } from 'vitest';

import { getXeroSyncHealth } from './xero-sync-health.js';

const now = new Date('2026-11-27T03:00:00.000Z');
const connected = {
  edition: 'SOLO',
  oauthStatus: 'CONNECTED',
  legacyEnabled: false,
  lastSuccessfulSyncAt: now
} as const;

describe('Xero sync health', () => {
  it('keeps a successful customer OAuth sync current through two scheduled intervals', () => {
    expect(
      getXeroSyncHealth(
        { ...connected, lastSuccessfulSyncAt: new Date('2026-11-27T02:30:00.000Z') },
        now
      )
    ).toBe('CURRENT');
    expect(
      getXeroSyncHealth(
        { ...connected, lastSuccessfulSyncAt: new Date('2026-11-27T02:29:59.999Z') },
        now
      )
    ).toBe('DELAYED');
  });

  it('flags an authenticated Custom Connection after a week without a successful sync', () => {
    expect(
      getXeroSyncHealth(
        {
          edition: 'INTERNAL_LEGACY',
          oauthStatus: null,
          legacyEnabled: true,
          lastSuccessfulSyncAt: new Date('2026-11-20T02:30:00.000Z')
        },
        now
      )
    ).toBe('DELAYED');
  });

  it('distinguishes initial sync, reauthorisation, and disconnection', () => {
    expect(
      getXeroSyncHealth({ ...connected, lastSuccessfulSyncAt: null }, now)
    ).toBe('FIRST_SYNC_PENDING');
    expect(
      getXeroSyncHealth(
        {
          ...connected,
          edition: 'INTERNAL_LEGACY',
          legacyEnabled: true,
          oauthStatus: 'REAUTH_REQUIRED'
        },
        now
      )
    ).toBe('RECONNECT_REQUIRED');
    expect(
      getXeroSyncHealth({ ...connected, oauthStatus: 'DISCONNECTED' }, now)
    ).toBe('DISCONNECTED');
    expect(
      getXeroSyncHealth({ ...connected, oauthStatus: null, legacyEnabled: true }, now)
    ).toBe('DISCONNECTED');
  });

  it('uses an enabled legacy connection after its OAuth connection was disconnected', () => {
    expect(getXeroSyncHealth({
      ...connected,
      edition: 'INTERNAL_LEGACY',
      oauthStatus: 'DISCONNECTED',
      legacyEnabled: true
    }, now)).toBe('CURRENT');
  });

  it('does not show current data for a future sync timestamp', () => {
    expect(
      getXeroSyncHealth(
        { ...connected, lastSuccessfulSyncAt: new Date('2026-11-27T03:00:00.001Z') },
        now
      )
    ).toBe('DELAYED');
  });
});
